// G5-D — governed demand ingress.
//
// Can the proven Freshline customer experience capture a real booking request
// and persist it as canonical SCP demand, through the G5-C runtime spine,
// without a browser, a Freshline fork or a second booking authority governing
// anything that matters?

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { projectCatalogue } from "../../src/customer/catalogueProjection";
import { INGRESS_PATH, CONFIGURATION_PATH, type CustomerHost } from "../../src/host/customerHost";
import {
    SCOPE,
    activate,
    bundleAtVersion,
    futureSlot,
    getCustomerPool,
    getJson,
    post,
    resetCustomer,
    startHostOrThrow,
    validIntent
} from "./customerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** The server's own clock, read from the database the server writes through. */
async function serverNow(pool: Pool): Promise<Date> {
    const { rows } = await pool.query<{ n: Date }>(`SELECT now() AS n`);
    return rows[0]!.n;
}

async function requestCount(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM core_service_request`);
    return Number(rows[0]!.n);
}

interface PersistedDemand {
    request_id: string;
    state: string;
    market_id: string;
    tenant_id: string;
    environment: string;
    configuration_version: number;
    configuration_checksum: string;
    price_minor_units: string;
    currency_code: string;
    duration_minutes: number;
    start_time: Date;
    end_time: Date;
    server_received_at: Date;
    requested_start_time: Date;
    service_code: string;
    extra_codes: string[];
    service_region: string;
    accommodation_type: string | null;
    locale: string;
    source_channel: string;
    customer_contact_handle: string;
    idempotency_key: string;
}

async function loadDemand(pool: Pool, requestId: string): Promise<PersistedDemand> {
    const { rows } = await pool.query<PersistedDemand>(
        `SELECT r.request_id, r.state, r.market_id,
                i.tenant_id, i.environment, i.configuration_version, i.configuration_checksum,
                i.server_received_at, i.requested_start_time, i.service_code, i.extra_codes,
                i.service_region, i.accommodation_type, i.locale, i.source_channel,
                i.customer_contact_handle, i.idempotency_key,
                v.price_minor_units, v.currency_code, v.duration_minutes, v.start_time, v.end_time
           FROM core_service_request r
           JOIN core_demand_ingress i ON i.request_id = r.request_id
           JOIN core_service_request_version v
             ON v.request_id = r.request_id AND v.version = r.current_version
          WHERE r.request_id = $1`,
        [requestId]
    );
    return rows[0]!;
}

d("G5-D / demand ingress — customer intent becomes canonical SCP demand", () => {
    let pool: Pool;
    let host: CustomerHost;

    beforeEach(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startHostOrThrow(pool);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("a valid booking intent creates exactly one canonical Service Request", async () => {
        const before = await requestCount(pool);
        const response = await post(host.origin, INGRESS_PATH, validIntent());

        expect(response.status).toBe(201);
        expect(response.body["disposition"]).toBe("ACCEPTED");
        expect(response.body["state"]).toBe("PENDING_ACCEPTANCE");
        expect(await requestCount(pool)).toBe(before + 1);

        const demand = await loadDemand(pool, response.body["requestId"] as string);
        expect(demand.state).toBe("PENDING_ACCEPTANCE");
        expect(demand.market_id).toBe(SCOPE.marketId);
    });

    it("the initial state is the one Core assigns, and it is predecessor-valid", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const { rows } = await pool.query<{ from_state: string | null; to_state: string }>(
            `SELECT from_state, to_state FROM core_event
              WHERE object_type = 'SERVICE_REQUEST' AND object_id = $1
              ORDER BY event_id ASC`,
            [response.body["requestId"]]
        );
        // Exactly one transition, out of nothing, into the canonical entry state.
        expect(rows).toHaveLength(1);
        expect(rows[0]!.from_state).toBeNull();
        expect(rows[0]!.to_state).toBe("PENDING_ACCEPTANCE");
    });

    it("the persisted request carries tenant, market, environment and configuration lineage", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const demand = await loadDemand(pool, response.body["requestId"] as string);

        expect(demand.tenant_id).toBe(SCOPE.tenantId);
        expect(demand.market_id).toBe(SCOPE.marketId);
        expect(demand.environment).toBe(SCOPE.environment);
        expect(demand.configuration_version).toBe(2);
        expect(demand.configuration_checksum).toHaveLength(64);
        expect(demand.configuration_checksum).toBe(
            host.runtime.configuration.provenance.checksum
        );
    });

    it("carries the customer context Core deliberately does not model", async () => {
        const intent = validIntent({
            extraCodes: ["FOOT_MASSAGE", "BACK_SHOULDER_MASSAGE"],
            region: "Canggu",
            accommodationType: "Hotel",
            locale: "id"
        });
        const response = await post(host.origin, INGRESS_PATH, intent);
        const demand = await loadDemand(pool, response.body["requestId"] as string);

        expect(demand.service_code).toBe("FRESH_CUT");
        expect(demand.extra_codes.sort()).toEqual(["BACK_SHOULDER_MASSAGE", "FOOT_MASSAGE"]);
        expect(demand.service_region).toBe("Canggu");
        expect(demand.accommodation_type).toBe("Hotel");
        expect(demand.locale).toBe("id");
        expect(demand.source_channel).toBe("WEB_CUSTOMER_SURFACE");
    });

    it("the server clock is authoritative and the client never supplies an instant", async () => {
        const slot = futureSlot(4, 14);

        // SCP-R36: this used to assert the received-at was within 30 real
        // seconds of the client's own `Date.now()`, which made a correctness
        // test fail whenever the machine was slow — it was measuring the
        // harness, not the product. The invariant it was reaching for is that
        // the instant is the SERVER's. That is stated exactly here: bracket it
        // between two server-side clock readings taken around the call. It
        // holds whether the request takes a millisecond or an hour.
        const before = await serverNow(pool);
        const response = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ requestedDate: slot.date, requestedTime: slot.time })
        );
        const after = await serverNow(pool);
        const demand = await loadDemand(pool, response.body["requestId"] as string);

        const receivedAt = demand.server_received_at.getTime();
        expect(receivedAt).toBeGreaterThanOrEqual(before.getTime());
        expect(receivedAt).toBeLessThanOrEqual(after.getTime());

        // And the stronger half of the same claim: the client is structurally
        // incapable of supplying one. The closed intake contract refuses it
        // rather than preferring the server's value over it.
        for (const field of ["serverReceivedAt", "submittedAt", "receivedAt"]) {
            const forged = await post(
                host.origin,
                INGRESS_PATH,
                validIntent({
                    requestedDate: slot.date,
                    requestedTime: slot.time,
                    [field]: new Date(0).toISOString()
                })
            );
            expect(forged.status, `${field} must be refused`).toBe(422);
            expect(forged.body["error"]).toBe("UNDECLARED_FIELD");
        }

        // The instant is resolved from the market-local selection, in the
        // governed timezone — not from a client-supplied timestamp.
        const expected = DateTime.fromISO(`${slot.date}T${slot.time}`, {
            zone: host.runtime.configuration.timezone.value
        });
        expect(demand.requested_start_time.getTime()).toBe(expected.toMillis());
        expect(demand.start_time.getTime()).toBe(expected.toMillis());
    });

    it("the persisted price is the governed one; a browser cannot alter it", async () => {
        // A client that tries to price its own booking is refused outright.
        const tampered = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ priceMinorUnits: 1, currency: "IDR" })
        );
        expect(tampered.status).toBe(422);
        expect(tampered.body["error"]).toBe("UNDECLARED_FIELD");

        // And the price that IS persisted comes from the governed catalogue.
        const clean = await post(host.origin, INGRESS_PATH, validIntent());
        const demand = await loadDemand(pool, clean.body["requestId"] as string);
        expect(Number(demand.price_minor_units)).toBe(350_000);
        expect(demand.currency_code).toBe("IDR");
    });

    it("prices extras from the governed catalogue, never from the client", async () => {
        const response = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ serviceCode: "FULL_FRESH", extraCodes: ["FULL_BODY_MASSAGE"] })
        );
        const demand = await loadDemand(pool, response.body["requestId"] as string);
        // 550,000 service + 350,000 extra, and 90 + 45 minutes of exclusive capacity.
        expect(Number(demand.price_minor_units)).toBe(900_000);
        expect(demand.duration_minutes).toBe(135);
        expect(demand.end_time.getTime() - demand.start_time.getTime()).toBe(135 * 60_000);
    });

    it("refuses unknown and inactive catalogue entries", async () => {
        const unknownService = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ serviceCode: "NOT_A_SERVICE" })
        );
        expect(unknownService.status).toBe(422);
        expect(unknownService.body["error"]).toBe("SERVICE_UNKNOWN");

        const unknownExtra = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ extraCodes: ["NOT_AN_EXTRA"] })
        );
        expect(unknownExtra.body["error"]).toBe("EXTRA_UNKNOWN");

        const duplicated = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ extraCodes: ["FOOT_MASSAGE", "FOOT_MASSAGE"] })
        );
        expect(duplicated.body["error"]).toBe("EXTRA_DUPLICATED");
    });

    it("refuses an unsupported region, accommodation type or locale", async () => {
        expect((await post(host.origin, INGRESS_PATH, validIntent({ region: "Jakarta" }))).body["error"]).toBe(
            "REGION_UNSUPPORTED"
        );
        expect(
            (await post(host.origin, INGRESS_PATH, validIntent({ accommodationType: "Yacht" }))).body[
                "error"
            ]
        ).toBe("ACCOMMODATION_UNSUPPORTED");
        expect((await post(host.origin, INGRESS_PATH, validIntent({ locale: "fr" }))).body["error"]).toBe(
            "LOCALE_UNSUPPORTED"
        );
    });

    it("refuses a request outside the governed operating policy", async () => {
        const early = futureSlot(3, 6);
        expect(
            (
                await post(
                    host.origin,
                    INGRESS_PATH,
                    validIntent({ requestedDate: early.date, requestedTime: early.time })
                )
            ).body["error"]
        ).toBe("OUTSIDE_OPERATING_HOURS");

        // Inside opening hours, but the service would still be running after
        // close — refused against the duration Core froze, not a second one.
        const late = futureSlot(3, 22);
        const ceiling = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({
                serviceCode: "FULL_FRESH",
                extraCodes: ["FULL_BODY_MASSAGE"],
                requestedDate: late.date,
                requestedTime: late.time
            })
        );
        expect(ceiling.body["error"]).toBe("CLOSING_CEILING_EXCEEDED");
        // The refusal left nothing behind.
        expect(await requestCount(pool)).toBe(0);

        const soon = DateTime.now().setZone("Asia/Makassar").plus({ minutes: 10 });
        expect(
            (
                await post(
                    host.origin,
                    INGRESS_PATH,
                    validIntent({
                        requestedDate: soon.toFormat("yyyy-MM-dd"),
                        requestedTime: soon.toFormat("HH:mm")
                    })
                )
            ).body["error"]
        ).toBe("BOOKING_WINDOW_TOO_SOON");

        const far = futureSlot(120, 10);
        expect(
            (
                await post(
                    host.origin,
                    INGRESS_PATH,
                    validIntent({ requestedDate: far.date, requestedTime: far.time })
                )
            ).body["error"]
        ).toBe("BOOKING_WINDOW_TOO_FAR");
    });

    it("an idempotent replay reuses the canonical request rather than duplicating it", async () => {
        const intent = validIntent({ idempotencyKey: "web-replay-0001" });
        const first = await post(host.origin, INGRESS_PATH, intent);
        expect(first.status).toBe(201);
        expect(first.body["disposition"]).toBe("ACCEPTED");

        const second = await post(host.origin, INGRESS_PATH, intent);
        expect(second.status).toBe(200);
        expect(second.body["disposition"]).toBe("REPLAYED");
        expect(second.body["requestId"]).toBe(first.body["requestId"]);
        expect(await requestCount(pool)).toBe(1);

        const ack = second.body["acknowledgement"] as Record<string, unknown>;
        expect(ack["replay"]).toBe(true);
        expect(ack["customerConfirmed"]).toBe(false);
    });

    it("a changed payload under a reused key fails deterministically", async () => {
        const key = "web-collision-0001";
        await post(host.origin, INGRESS_PATH, validIntent({ idempotencyKey: key }));

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const conflict = await post(
                host.origin,
                INGRESS_PATH,
                validIntent({ idempotencyKey: key, serviceCode: "FULL_FRESH" })
            );
            expect(conflict.status).toBe(409);
            expect(conflict.body["error"]).toBe("IDEMPOTENCY_KEY_CONFLICT");
        }
        expect(await requestCount(pool)).toBe(1);
    });

    it("simultaneous identical submissions produce exactly one canonical request", async () => {
        const intent = validIntent({ idempotencyKey: "web-race-0001" });
        const responses = await Promise.all(
            Array.from({ length: 8 }, () => post(host.origin, INGRESS_PATH, intent))
        );

        const accepted = responses.filter((r) => r.body["disposition"] === "ACCEPTED");
        const replayed = responses.filter((r) => r.body["disposition"] === "REPLAYED");
        expect(accepted).toHaveLength(1);
        expect(replayed).toHaveLength(7);
        // Every contender got a governed answer; none got a raw database error.
        for (const response of responses) {
            expect([200, 201]).toContain(response.status);
            expect(response.body["requestId"]).toBe(accepted[0]!.body["requestId"]);
        }
        expect(await requestCount(pool)).toBe(1);
    });

    it("the canonical request survives a process restart", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const requestId = response.body["requestId"] as string;
        const before = await loadDemand(pool, requestId);

        // Tear the whole runtime down — server, pool, resolved configuration.
        await host.close();
        await pool.end();

        pool = getCustomerPool();
        host = await startHostOrThrow(pool);

        const after = await loadDemand(pool, requestId);
        expect(after.state).toBe("PENDING_ACCEPTANCE");
        expect(after.price_minor_units).toBe(before.price_minor_units);
        expect(after.start_time.getTime()).toBe(before.start_time.getTime());
        expect(after.configuration_checksum).toBe(before.configuration_checksum);
        expect(await requestCount(pool)).toBe(1);
    });

    it("fails closed when the governed catalogue was never projected into Core", async () => {
        await host.close();
        await pool.query(`TRUNCATE core_catalogue_binding CASCADE`);
        host = await startHostOrThrow(pool, {}, { projectCatalogueOnStart: false });

        const response = await post(host.origin, INGRESS_PATH, validIntent());
        expect(response.status).toBe(503);
        expect(response.body["error"]).toBe("CATALOGUE_NOT_PROJECTED");
        expect(await requestCount(pool)).toBe(0);
    });

    it("records ingress as runtime evidence without granting it authority", async () => {
        await post(host.origin, INGRESS_PATH, validIntent());
        await post(host.origin, INGRESS_PATH, validIntent({ region: "Jakarta" }));

        const { rows } = await pool.query<{ kind: string; outcome: string; reason_code: string | null }>(
            `SELECT kind, outcome, reason_code FROM core_runtime_evidence
              WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
              ORDER BY evidence_id ASC`,
            [SCOPE.tenantId, SCOPE.marketId, SCOPE.environment]
        );
        const kinds = rows.map((r) => r.kind);
        expect(kinds).toContain("CATALOGUE_PROJECTED");
        expect(kinds).toContain("DEMAND_INGRESS_ACCEPTED");
        expect(kinds).toContain("DEMAND_INGRESS_REFUSED");
        expect(rows.find((r) => r.kind === "DEMAND_INGRESS_REFUSED")!.reason_code).toBe(
            "REGION_UNSUPPORTED"
        );
    });

    it("the ingress record is append-only", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const requestId = response.body["requestId"];

        await expect(
            pool.query(`UPDATE core_demand_ingress SET service_region = 'Kuta' WHERE request_id = $1`, [
                requestId
            ])
        ).rejects.toThrow(/append-only/);
        await expect(
            pool.query(`DELETE FROM core_demand_ingress WHERE request_id = $1`, [requestId])
        ).rejects.toThrow(/append-only/);
    });
});

d("G5-D / configuration projection — the catalogue is governed, not deployed", () => {
    let pool: Pool;
    let host: CustomerHost;

    beforeEach(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startHostOrThrow(pool);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("projects the governed catalogue into Core and records the binding", async () => {
        const { rows } = await pool.query<{ kind: string; service_code: string; extra_code: string | null }>(
            `SELECT kind, service_code, extra_code FROM core_catalogue_binding
              WHERE tenant_id = $1 ORDER BY service_code, extra_code NULLS FIRST`,
            [SCOPE.tenantId]
        );
        // 3 services, each with 3 extras projected as service-scoped add-ons.
        expect(rows.filter((r) => r.kind === "SERVICE")).toHaveLength(3);
        expect(rows.filter((r) => r.kind === "EXTRA")).toHaveLength(9);

        const services = await pool.query<{ name: string; base_duration_minutes: number }>(
            `SELECT name, base_duration_minutes FROM core_service ORDER BY base_duration_minutes`
        );
        expect(services.rows.map((r) => r.name)).toEqual([
            "The Fresh Cut",
            "Fresh Cut + Beard",
            "The Full Fresh"
        ]);
    });

    it("re-projecting an unchanged configuration is a no-op, not a duplicate catalogue", async () => {
        const before = await pool.query(`SELECT count(*) AS n FROM core_service`);
        const result = await withTransaction(pool, (client) =>
            projectCatalogue(client, host.runtime.configuration)
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.projection.servicesCreated).toBe(0);
        expect(result.projection.priceVersionsAppended).toBe(0);
        const after = await pool.query(`SELECT count(*) AS n FROM core_service`);
        expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it("activating a new configuration version changes the customer surface with no code change", async () => {
        const first = await post(host.origin, INGRESS_PATH, validIntent());
        const firstDemand = await loadDemand(pool, first.body["requestId"] as string);
        expect(Number(firstDemand.price_minor_units)).toBe(350_000);

        // A governed price change, and one catalogue item withdrawn.
        await activate(
            pool,
            bundleAtVersion(3, (b) => {
                b.planes.CATALOGUE.services[0]!.price.amount = 395_000;
                b.planes.CATALOGUE.extras[0]!.active = false;
            })
        );
        await host.close();
        host = await startHostOrThrow(pool);

        const projection = await getJson(host.origin, CONFIGURATION_PATH);
        const catalogue = projection.body["catalogue"] as {
            services: Array<{ code: string; price: { minorUnits: number } }>;
            extras: Array<{ code: string }>;
        };
        expect(catalogue.services[0]!.price.minorUnits).toBe(395_000);
        expect(catalogue.extras.map((e) => e.code)).not.toContain("FOOT_MASSAGE");

        // New demand takes the new governed price.
        const second = await post(host.origin, INGRESS_PATH, validIntent());
        const secondDemand = await loadDemand(pool, second.body["requestId"] as string);
        expect(Number(secondDemand.price_minor_units)).toBe(395_000);
        expect(secondDemand.configuration_version).toBe(3);

        // The already-persisted request keeps the terms it was accepted on.
        const unchanged = await loadDemand(pool, first.body["requestId"] as string);
        expect(Number(unchanged.price_minor_units)).toBe(350_000);
        expect(unchanged.configuration_version).toBe(2);

        // A withdrawn extra can no longer be submitted, UI or no UI.
        const withdrawn = await post(
            host.origin,
            INGRESS_PATH,
            validIntent({ extraCodes: ["FOOT_MASSAGE"] })
        );
        expect(withdrawn.body["error"]).toBe("EXTRA_INACTIVE");
    });

    it("marks projected durations as unconfirmed engineering assumptions (R16)", async () => {
        const { rows } = await pool.query<{ duration_provenance: string }>(
            `SELECT DISTINCT duration_provenance FROM core_catalogue_binding WHERE tenant_id = $1`,
            [SCOPE.tenantId]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.duration_provenance).toBe("CC_SUPPLIED_UNCONFIRMED");
    });

    it("payment and dynamic pricing remain inactive on the projected surface", async () => {
        const projection = await getJson(host.origin, CONFIGURATION_PATH);
        expect(projection.body["commerce"]).toEqual({
            paymentActive: false,
            paymentPolicy: "OFFLINE",
            dynamicPricingActive: false
        });
        expect(projection.body["authoritative"]).toBe(false);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name LIKE '%payment%'`
        );
        expect(Number(rows[0]!.n)).toBe(0);
    });
});
