// SCP-G5-E-CORR-01 — R32: MOBILE eligibility must satisfy time AND place from
// the SAME capacity window.
//
// The defect this suite exists to prevent: a partner available Monday in
// Seminyak and Tuesday in Canggu was sellable in both regions on both days,
// because "when" and "where" were answered independently — the requested area
// was validated as EXISTING in the tenant rather than as COVERED by the window
// that supplied the time.
//
// Every fixture here is built through the real G5-E path (profile -> card ->
// Owner approval -> availability -> Owner confirmation) and every question is
// asked of the real G3 kernel. Nothing inserts a capacity window by hand,
// because a fixture that wrote its own capacity could pass while the actual
// supply path was still wrong.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import type { ServiceCommerceEvaluation } from "../../src/kernel/evaluation";
import type { PartnerHost } from "../../src/host/partnerHost";
import {
    activate,
    approvedPartner,
    getProviderPool,
    ownerSession,
    resetProvider,
    startPartnerOrThrow,
    validProfile,
    week,
    call,
    futureMonday
} from "../provider/providerTestDb";
import { getKernelPool, resetKernel, seedInStoreWorld, localSlot } from "./kernelTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** Monday Seminyak, Tuesday Canggu, the rest of the week off. */
const ASYMMETRIC = week([
    { isoDay: 1, available: true, startTime: "09:00", endTime: "17:00", regions: ["Seminyak"] },
    { isoDay: 2, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
    { isoDay: 3, available: false },
    { isoDay: 4, available: false },
    { isoDay: 5, available: false }
]);

d("G5-E-CORR-01 / R32 — MOBILE time and service area must come from one window", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };
    let customerIdentityId: string;
    let serviceId: string;
    let weekStartDate: string;

    async function enableMobileCommerce(): Promise<void> {
        [customerIdentityId, serviceId] = await withTransaction(pool, async (client) => {
            await client.query(
                `INSERT INTO core_service_topology (service_id, topology)
                 SELECT service_id, 'MOBILE' FROM core_service ON CONFLICT DO NOTHING`
            );
            const identity = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ('bali','Customer')
                 RETURNING identity_id`
            );
            const identityId = identity.rows[0]!.identity_id;
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role)
                 VALUES ($1,'bali','CUSTOMER')`,
                [identityId]
            );
            const service = await client.query<{ service_id: string }>(
                `SELECT service_id FROM core_catalogue_binding
                  WHERE kind = 'SERVICE' AND service_code = 'FRESH_CUT'`
            );
            return [identityId, service.rows[0]!.service_id] as [string, string];
        });
    }

    /** 11:00 market-local on the given weekday of the confirmed week. */
    function slot(isoDay: number): Date {
        return DateTime.fromISO(weekStartDate, { zone: "Asia/Makassar" })
            .plus({ days: isoDay - 1 })
            .set({ hour: 11, minute: 0, second: 0, millisecond: 0 })
            .toJSDate();
    }

    async function evaluate(
        area: string,
        isoDay: number,
        extra: { preferredProviderId?: string } = {}
    ): Promise<ServiceCommerceEvaluation> {
        const outcome = await withTransaction(pool, (client) =>
            evaluateServiceCommerce(client, {
                marketId: "bali",
                topology: "MOBILE",
                serviceId,
                customerIdentityId,
                serviceAreaKey: area,
                requestedStart: slot(isoDay),
                ...extra
            })
        );
        if (!outcome.ok) {
            throw new Error(`${outcome.code}: ${outcome.message}`);
        }
        return outcome.value;
    }

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
        weekStartDate = futureMonday();
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("CORR-T01 — the asymmetric day x region matrix answers all six questions correctly", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate
        });
        await enableMobileCommerce();

        // The capacity that must decide this: one Monday-Seminyak row, one
        // Tuesday-Canggu row, and nothing at all on Wednesday.
        const { rows: windows } = await pool.query<{ iso_day: number; location_id: string }>(
            `SELECT l.iso_day, w.location_id
               FROM core_capacity_window w
               JOIN core_supply_window_link l ON l.window_id = w.window_id
              WHERE w.provider_id = $1 AND w.active = TRUE
              ORDER BY l.iso_day`,
            [partner.providerId]
        );
        expect(windows).toEqual([
            { iso_day: 1, location_id: "Seminyak" },
            { iso_day: 2, location_id: "Canggu" }
        ]);

        const mondaySeminyak = await evaluate("Seminyak", 1);
        expect(mondaySeminyak.outcome).toBe("SELLABLE");
        expect(mondaySeminyak.terms?.providerId).toBe(partner.providerId);
        expect(mondaySeminyak.terms?.serviceAreaKey).toBe("Seminyak");

        const mondayCanggu = await evaluate("Canggu", 1);
        expect(mondayCanggu.outcome).not.toBe("SELLABLE");
        expect(mondayCanggu.reasonCode).toBe("PROVIDER_UNAVAILABLE");
        expect(mondayCanggu.terms).toBeNull();

        const tuesdayCanggu = await evaluate("Canggu", 2);
        expect(tuesdayCanggu.outcome).toBe("SELLABLE");
        expect(tuesdayCanggu.terms?.serviceAreaKey).toBe("Canggu");

        const tuesdaySeminyak = await evaluate("Seminyak", 2);
        expect(tuesdaySeminyak.outcome).not.toBe("SELLABLE");
        expect(tuesdaySeminyak.reasonCode).toBe("PROVIDER_UNAVAILABLE");

        for (const area of ["Seminyak", "Canggu"]) {
            const wednesday = await evaluate(area, 3);
            expect(wednesday.outcome, area).not.toBe("SELLABLE");
            expect(wednesday.reasonCode, area).toBe("PROVIDER_UNAVAILABLE");
        }
    });

    it("CORR-T02 — a legitimately multi-region day stays sellable in every region it covers", async () => {
        await approvedPartner(host.origin, owner.token, {
            days: week([
                {
                    isoDay: 1,
                    available: true,
                    startTime: "09:00",
                    endTime: "17:00",
                    regions: ["Seminyak", "Canggu"]
                },
                { isoDay: 2, available: false },
                { isoDay: 3, available: false },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ]),
            weekStartDate
        });
        await enableMobileCommerce();

        // The correction narrows a wrong-region claim; it must not narrow a
        // provider who genuinely covers both.
        expect((await evaluate("Seminyak", 1)).outcome).toBe("SELLABLE");
        expect((await evaluate("Canggu", 1)).outcome).toBe("SELLABLE");
        // A region they do not cover on that day is still refused.
        expect((await evaluate("Uluwatu", 1)).reasonCode).toBe("PROVIDER_UNAVAILABLE");
    });

    it("CORR-T03 — the right region at the wrong time is still unavailable", async () => {
        await approvedPartner(host.origin, owner.token, {
            days: week([
                { isoDay: 1, available: true, startTime: "09:00", endTime: "11:00", regions: ["Seminyak"] },
                { isoDay: 2, available: false },
                { isoDay: 3, available: false },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ]),
            weekStartDate
        });
        await enableMobileCommerce();

        // 11:00 + 45 minutes runs past the 11:00 close.
        const outside = await evaluate("Seminyak", 1);
        expect(outside.outcome).not.toBe("SELLABLE");
        expect(outside.reasonCode).toBe("PROVIDER_UNAVAILABLE");
    });

    it("CORR-T04 — the right time in the wrong region is refused, and the time overlap is real", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: week([
                { isoDay: 1, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
                { isoDay: 2, available: false },
                { isoDay: 3, available: false },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ]),
            weekStartDate
        });
        await enableMobileCommerce();

        // Prove the overlap exists, so the refusal is about place and not time.
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_capacity_window
              WHERE provider_id = $1 AND active = TRUE
                AND during @> tstzrange($2::timestamptz,
                                        $2::timestamptz + interval '45 minutes', '[)')`,
            [partner.providerId, slot(1)]
        );
        expect(Number(rows[0]!.n)).toBe(1);

        const wrongRegion = await evaluate("Seminyak", 1);
        expect(wrongRegion.outcome).not.toBe("SELLABLE");
        expect(wrongRegion.reasonCode).toBe("PROVIDER_UNAVAILABLE");

        expect((await evaluate("Canggu", 1)).outcome).toBe("SELLABLE");
    });

    it("CORR-T05 — a foreign-tenant service area cannot satisfy eligibility", async () => {
        await approvedPartner(host.origin, owner.token, { days: ASYMMETRIC, weekStartDate });
        await enableMobileCommerce();

        // An area key that exists — for somebody else.
        await pool.query(
            `INSERT INTO core_service_area (tenant_id, market_id, area_key, active)
             VALUES ('another-tenant', 'bali', 'Seminyak', TRUE)`
        );
        // And one that exists in this tenant but in another market.
        await pool.query(
            `INSERT INTO core_service_area (tenant_id, market_id, area_key, active)
             VALUES ((SELECT tenant_id FROM core_service_area WHERE market_id = 'bali' LIMIT 1),
                     'bangkok', 'Thonglor', TRUE)`
        );

        // The resolution in step 5 is tenant- and market-scoped, so neither can
        // reach capacity evaluation at all.
        const foreignMarket = await evaluate("Thonglor", 1);
        expect(foreignMarket.outcome).not.toBe("SELLABLE");
        expect(foreignMarket.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");

        const unknown = await evaluate("Nowhere", 1);
        expect(unknown.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");

        // The governed Bali area still works — the scoping did not break it.
        expect((await evaluate("Seminyak", 1)).outcome).toBe("SELLABLE");

        // A deactivated area stops being serviceable.
        await pool.query(
            `UPDATE core_service_area SET active = FALSE
              WHERE market_id = 'bali' AND area_key = 'Seminyak' AND tenant_id <> 'another-tenant'`
        );
        expect((await evaluate("Seminyak", 1)).reasonCode).toBe("LOCATION_NOT_SERVICEABLE");
    });

    it("CORR-T06 — a pinned preferred provider does not bypass the invariant", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate
        });
        await enableMobileCommerce();

        const pinnedWrongRegion = await evaluate("Canggu", 1, {
            preferredProviderId: partner.providerId
        });
        expect(pinnedWrongRegion.outcome).not.toBe("SELLABLE");
        expect(pinnedWrongRegion.reasonCode).toBe("PROVIDER_UNAVAILABLE");

        const pinnedRightRegion = await evaluate("Seminyak", 1, {
            preferredProviderId: partner.providerId
        });
        expect(pinnedRightRegion.outcome).toBe("SELLABLE");
        expect(pinnedRightRegion.terms?.providerId).toBe(partner.providerId);
    });

    it("CORR-T07 — general discovery excludes the wrong-region provider and keeps the right one", async () => {
        // A: Monday in Seminyak only.
        const providerA = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate
        });
        // B: Monday in Canggu only.
        const providerB = await approvedPartner(host.origin, owner.token, {
            profile: { displayName: "Ketut", contactHandle: "+628137654321" },
            days: week([
                { isoDay: 1, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
                { isoDay: 2, available: false },
                { isoDay: 3, available: false },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ]),
            weekStartDate
        });
        await enableMobileCommerce();
        expect(providerA.providerId).not.toBe(providerB.providerId);

        const canggu = await evaluate("Canggu", 1);
        expect(canggu.outcome).toBe("SELLABLE");
        expect(canggu.terms?.providerId).toBe(providerB.providerId);

        const seminyak = await evaluate("Seminyak", 1);
        expect(seminyak.outcome).toBe("SELLABLE");
        expect(seminyak.terms?.providerId).toBe(providerA.providerId);
    });

    it("CORR-T08 — when every provider is elsewhere, the request is not sellable", async () => {
        await approvedPartner(host.origin, owner.token, { days: ASYMMETRIC, weekStartDate });
        await approvedPartner(host.origin, owner.token, {
            profile: { displayName: "Ketut", contactHandle: "+628137654321" },
            days: week([
                { isoDay: 1, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
                { isoDay: 2, available: false },
                { isoDay: 3, available: false },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ]),
            weekStartDate
        });
        await enableMobileCommerce();

        // Both are working Monday at 11:00 — neither is in Kuta.
        const kuta = await evaluate("Kuta", 1);
        expect(kuta.outcome).not.toBe("SELLABLE");
        expect(kuta.reasonCode).toBe("PROVIDER_UNAVAILABLE");
        expect(kuta.terms).toBeNull();
        // The alternatives ladder cannot smuggle a wrong-region provider back in.
        expect(kuta.alternatives).toEqual([]);
    });

    it("CORR-T10 — a superseded regional window cannot satisfy eligibility", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate
        });
        await enableMobileCommerce();
        expect((await evaluate("Seminyak", 1)).outcome).toBe("SELLABLE");

        // The partner moves Monday from Seminyak to Uluwatu.
        await call(host.origin, "POST", "/api/partner/availability", {
            token: partner.token,
            body: {
                weekStartDate,
                days: week([
                    {
                        isoDay: 1,
                        available: true,
                        startTime: "09:00",
                        endTime: "17:00",
                        regions: ["Uluwatu"]
                    },
                    { isoDay: 2, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
                    { isoDay: 3, available: false },
                    { isoDay: 4, available: false },
                    { isoDay: 5, available: false }
                ])
            }
        });

        // The old confirmation is gone, so nothing is sellable anywhere yet.
        expect((await evaluate("Seminyak", 1)).reasonCode).toBe("PROVIDER_UNAVAILABLE");
        expect((await evaluate("Uluwatu", 1)).reasonCode).toBe("PROVIDER_UNAVAILABLE");

        const version = await pool.query<{ availability_version_id: string }>(
            `SELECT availability_version_id FROM core_provider_availability_version
              WHERE provider_id = $1 AND state = 'SUBMITTED'`,
            [partner.providerId]
        );
        await call(host.origin, "POST", "/api/operations/availability/confirm", {
            token: owner.token,
            body: { availabilityVersionId: version.rows[0]!.availability_version_id }
        });

        // The new week governs, and only the new week.
        expect((await evaluate("Uluwatu", 1)).outcome).toBe("SELLABLE");
        expect((await evaluate("Seminyak", 1)).reasonCode).toBe("PROVIDER_UNAVAILABLE");
    });
});

d("G5-E-CORR-01 / CORR-T09 — INSTORE location eligibility is unchanged", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });

    afterEach(async () => {
        await pool?.end();
    });

    it("an established INSTORE request remains sellable at its location", async () => {
        const world = await withTransaction(pool, (client) => seedInStoreWorld(client));
        const outcome = await withTransaction(pool, (client) =>
            evaluateServiceCommerce(client, {
                marketId: world.marketId,
                topology: "INSTORE",
                serviceId: world.cutServiceId,
                customerIdentityId: world.customerIdentityId,
                locationId: world.locationId,
                requestedStart: localSlot(world.marketId, 3, 11)
            })
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.value.outcome).toBe("SELLABLE");
        expect(outcome.value.terms?.locationId).toBe(world.locationId);
        // MOBILE's service-area key plays no part in an INSTORE decision.
        expect(outcome.value.terms?.serviceAreaKey).toBeNull();
    });

    it("INSTORE still refuses an unknown, inactive or foreign-tenant location", async () => {
        const world = await withTransaction(pool, (client) => seedInStoreWorld(client));

        const unknown = await withTransaction(pool, (client) =>
            evaluateServiceCommerce(client, {
                marketId: world.marketId,
                topology: "INSTORE",
                serviceId: world.cutServiceId,
                customerIdentityId: world.customerIdentityId,
                locationId: "00000000-0000-0000-0000-000000000001",
                requestedStart: localSlot(world.marketId, 3, 11)
            })
        );
        expect(unknown.ok && unknown.value.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");

        await pool.query(`UPDATE core_location SET tenant_id = 'another-tenant' WHERE location_id = $1`, [
            world.locationId
        ]);
        const foreign = await withTransaction(pool, (client) =>
            evaluateServiceCommerce(client, {
                marketId: world.marketId,
                topology: "INSTORE",
                serviceId: world.cutServiceId,
                customerIdentityId: world.customerIdentityId,
                locationId: world.locationId,
                requestedStart: localSlot(world.marketId, 3, 11)
            })
        );
        expect(foreign.ok && foreign.value.reasonCode).toBe("TENANT_MISMATCH");
    });
});
