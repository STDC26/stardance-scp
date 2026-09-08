// G5-D — state separation.
//
// The gate's central risk is collapse: a customer pressing Send and a system
// treating that as a qualified, assigned, confirmed, paid booking. These proofs
// walk the whole chain and assert that a successful submission produced exactly
// one thing — a canonical request at PENDING_ACCEPTANCE — and nothing else.
//
//   REQUEST_RECEIVED   != OWNER_QUALIFIED
//   OWNER_QUALIFIED    != PROVIDER_ACCEPTED
//   PROVIDER_ACCEPTED  != OWNER_ASSIGNED
//   OWNER_ASSIGNED     != CUSTOMER_CONFIRMED
//   CUSTOMER_CONFIRMED != FULFILLMENT_ACTIVE
//   FULFILLMENT_ACTIVE != SERVICE_COMPLETED
//   SERVICE_COMPLETED  != PAYMENT_OR_SETTLEMENT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { handoffAfterIngress, INGRESS_PATH, type CustomerHost } from "../../src/host/customerHost";
import { withTransaction } from "../../src/db/pool";
import { submitCustomerDemand } from "../../src/customer/demandIngress";
import { AdapterSpine } from "../../src/adapters/spine/adapter";
import { createRecordingTransport } from "../../src/adapters/spine/transports";
import {
    SCOPE,
    activate,
    getCustomerPool,
    post,
    resetCustomer,
    startHostOrThrow,
    validIntent
} from "./customerTestDb";
import { anchoredHoursAhead } from "../support/testTime";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function count(pool: Pool, table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params
    );
    return Number(rows[0]!.n);
}

async function stateOf(pool: Pool, requestId: string): Promise<string> {
    const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM core_service_request WHERE request_id = $1`,
        [requestId]
    );
    return rows[0]!.state;
}

d("G5-D / state truth — a submission produces one request and nothing else", () => {
    let pool: Pool;
    let host: CustomerHost;
    let requestId: string;

    beforeEach(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startHostOrThrow(pool);
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        expect(response.status).toBe(201);
        requestId = response.body["requestId"] as string;
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("REQUEST_RECEIVED is not OWNER_QUALIFIED", async () => {
        expect(await stateOf(pool, requestId)).toBe("PENDING_ACCEPTANCE");
        // Owner qualification is a governed operational action. None was taken.
        expect(await count(pool, "core_operational_action")).toBe(0);
        expect(await count(pool, "core_commerce_evaluation")).toBe(0);
    });

    it("is not PROVIDER_ACCEPTED or OWNER_ASSIGNED", async () => {
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
        expect(await count(pool, "core_assignment")).toBe(0);
        // Nothing was offered, so nothing could have been accepted.
        expect(await count(pool, "core_event", "object_type = 'DISPATCH_OFFER'")).toBe(0);
        expect(await count(pool, "core_event", "object_type = 'ASSIGNMENT'")).toBe(0);
    });

    it("is not CUSTOMER_CONFIRMED", async () => {
        expect(await count(pool, "core_customer_confirmation")).toBe(0);
        expect(await count(pool, "core_event", "object_type = 'CUSTOMER_CONFIRMATION'")).toBe(0);
    });

    it("grants the submitting contact no authority to confirm anything", async () => {
        // The identity exists so the request has a customer; it holds NO role.
        // A contact handle typed into a public form is self-asserted, and
        // customer confirmation authority requires the CUSTOMER role.
        const { rows } = await pool.query<{ identity_id: string; channel_handle: string }>(
            `SELECT i.identity_id, i.channel_handle
               FROM core_identity i
               JOIN core_demand_ingress d ON d.customer_identity_id = i.identity_id
              WHERE d.request_id = $1`,
            [requestId]
        );
        expect(rows).toHaveLength(1);
        expect(await count(pool, "core_identity_role", "identity_id = $1", [rows[0]!.identity_id])).toBe(
            0
        );
    });

    it("is not FULFILLMENT_ACTIVE or SERVICE_COMPLETED", async () => {
        expect(await count(pool, "core_fulfillment")).toBe(0);
        expect(await count(pool, "core_event", "object_type = 'FULFILLMENT'")).toBe(0);
    });

    it("takes no payment and reserves no capacity", async () => {
        expect(host.runtime.configuration.commerce.payment.active).toBe(false);
        expect(host.runtime.configuration.commerce.payment.policy).toBe("OFFLINE");
        expect(host.runtime.configuration.commerce.locationDynamicPricing.active).toBe(false);
        // Ingress records demand. It does not hold a provider's time — that is
        // the kernel's act, on the far side of owner qualification.
        expect(await count(pool, "core_capacity_hold")).toBe(0);
    });

    it("writes exactly one canonical transition for the request", async () => {
        const { rows } = await pool.query<{ from_state: string | null; to_state: string; actor_role: string }>(
            `SELECT from_state, to_state, actor_role FROM core_event
              WHERE object_type = 'SERVICE_REQUEST' AND object_id = $1`,
            [requestId]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.to_state).toBe("PENDING_ACCEPTANCE");
        expect(rows[0]!.actor_role).toBe("CUSTOMER");
    });

    it("the acknowledgement asserts every one of these separations to the customer", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const ack = response.body["acknowledgement"] as Record<string, unknown>;
        expect(ack["stateTruth"]).toBe("REQUEST_RECEIVED");
        expect(ack["ownerQualified"]).toBe(false);
        expect(ack["providerAccepted"]).toBe(false);
        expect(ack["providerAssigned"]).toBe(false);
        expect(ack["customerConfirmed"]).toBe(false);
        expect(ack["fulfillmentStarted"]).toBe(false);
        expect(ack["serviceCompleted"]).toBe(false);
        expect(ack["paymentTaken"]).toBe(false);
    });
});

d("G5-D / channel non-authority — the request exists before, and despite, any handoff", () => {
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

    it("persists canonical demand before any channel handoff is attempted", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const requestId = response.body["requestId"] as string;

        const { rows } = await pool.query<{ kind: string; occurred_at: Date }>(
            `SELECT kind, occurred_at FROM core_runtime_evidence
              WHERE kind IN ('DEMAND_INGRESS_ACCEPTED', 'CHANNEL_HANDOFF_ATTEMPTED')
              ORDER BY evidence_id ASC`
        );
        expect(rows.map((r) => r.kind)).toEqual([
            "DEMAND_INGRESS_ACCEPTED",
            "CHANNEL_HANDOFF_ATTEMPTED"
        ]);

        // The canonical request is committed and complete regardless.
        const request = await pool.query(
            `SELECT state FROM core_service_request WHERE request_id = $1`,
            [requestId]
        );
        expect(request.rows[0]).toEqual({ state: "PENDING_ACCEPTANCE" });
    });

    it("a FAILED WhatsApp handoff alters no canonical state", async () => {
        // WhatsApp is not activated in this gate, so the transport refuses.
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        expect(response.status).toBe(201);

        const { rows } = await pool.query<{ outcome: string; reason_code: string; detail: Record<string, unknown> }>(
            `SELECT outcome, reason_code, detail FROM core_runtime_evidence
              WHERE kind = 'CHANNEL_HANDOFF_ATTEMPTED'`
        );
        expect(rows[0]!.outcome).toBe("REFUSED");
        expect(rows[0]!.reason_code).toBe("ADAPTER_NOT_CONFIGURED");
        expect(rows[0]!.detail["advancesCanonicalState"]).toBe(false);

        expect(await stateOf(pool, response.body["requestId"] as string)).toBe("PENDING_ACCEPTANCE");
        expect(await count(pool, "core_event", "object_type = 'SERVICE_REQUEST'")).toBe(1);
    });

    it("a SUCCESSFUL handoff alters no canonical state either", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const requestId = response.body["requestId"] as string;
        const eventsBefore = await count(pool, "core_event");

        // Substitute a transport that really does deliver. Nothing about SCP
        // truth may depend on which transport is registered.
        const recording = createRecordingTransport("WHATSAPP");
        const runtime = { ...host.runtime, adapters: new AdapterSpine().register(recording) };
        await handoffAfterIngress(pool, runtime, {
            disposition: "ACCEPTED",
            requestId,
            requestVersion: 1,
            state: "PENDING_ACCEPTANCE",
            priceMinorUnits: 350_000,
            currencyCode: "IDR",
            durationMinutes: 45,
            startTime: anchoredHoursAhead(0),
            endTime: anchoredHoursAhead(1),
            idempotencyKey: "handoff-success",
            correlationId: "corr-success",
            lineage: {
                tenantId: SCOPE.tenantId,
                marketId: SCOPE.marketId,
                environment: SCOPE.environment
            },
            configurationVersion: 2,
            configurationChecksum: host.runtime.configuration.provenance.checksum,
            customerIdentityId: "00000000-0000-0000-0000-000000000000",
            acknowledgement: response.body["acknowledgement"] as never
        });

        expect(recording.sent).toHaveLength(1);
        expect(await stateOf(pool, requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await count(pool, "core_event")).toBe(eventsBefore);
    });

    it("the adapter result has no vocabulary in which it could claim a state", async () => {
        const recording = createRecordingTransport("WHATSAPP");
        const result = await new AdapterSpine().register(recording).send(
            "WHATSAPP",
            {
                correlationId: "c",
                idempotencyKey: "k",
                lineage: {
                    tenantId: SCOPE.tenantId,
                    marketId: SCOPE.marketId,
                    environment: SCOPE.environment
                }
            },
            { channel: "WHATSAPP", recipientHandle: "+628", body: "x" }
        );
        expect(result.advancesCanonicalState).toBe(false);
        for (const forbidden of ["state", "status", "confirmed", "applied", "assigned"]) {
            expect(Object.hasOwn(result, forbidden)).toBe(false);
        }
    });
});

d("G5-D / legacy non-authority — `appointments` cannot regain canonical standing", () => {
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

    it("ingress writes nothing to the legacy surface", async () => {
        const before = await count(pool, "appointments");
        await post(host.origin, INGRESS_PATH, validIntent());
        expect(await count(pool, "appointments")).toBe(before);
    });

    it("mutating a legacy appointment changes nothing about canonical truth", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        const requestId = response.body["requestId"] as string;

        const legacyCode = `FL-${String(Date.now() % 1_000_000).padStart(6, "0")}-G5D0`;
        const legacyService = await pool.query<{ service_id: string }>(
            `INSERT INTO service_catalogue (name, duration_minutes)
             VALUES ('Legacy', 60)
             RETURNING service_id`
        );
        const legacyCustomer = await pool.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ('bali', 'Legacy')
             RETURNING identity_id`
        );
        await pool.query(
            `INSERT INTO appointments
                (billing_code, customer_id, service_id, start_time, end_time, status)
             VALUES ($3, $1, $2, now() + interval '2 days',
                     now() + interval '2 days 1 hour', 'CANCELLED')`,
            [
                legacyCustomer.rows[0]!.identity_id,
                legacyService.rows[0]!.service_id,
                // The legacy surface is NOT truncated between runs — it is the
                // frozen G1 table the inherited suites still rely on — so this
                // fixture takes a code of its own rather than colliding.
                legacyCode
            ]
        );

        // The legacy row says CANCELLED. The canonical request is untouched by
        // it, because the two are not the same object and never were.
        expect(await stateOf(pool, requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await count(pool, "core_event", "object_type = 'SERVICE_REQUEST'")).toBe(1);

        await pool.query(`UPDATE appointments SET status = 'CONTRACTOR_ACCEPTED' WHERE billing_code = $1`, [
            legacyCode
        ]);
        expect(await stateOf(pool, requestId)).toBe("PENDING_ACCEPTANCE");
    });

    it("no ingress record or catalogue binding references the legacy surface", async () => {
        await post(host.origin, INGRESS_PATH, validIntent());
        const { rows } = await pool.query<{ table_name: string; column_name: string }>(
            `SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('core_demand_ingress', 'core_catalogue_binding')
                AND column_name LIKE '%appointment%'`
        );
        expect(rows).toEqual([]);
    });
});
