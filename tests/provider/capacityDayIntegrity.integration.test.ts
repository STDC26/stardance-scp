// SCP-R42 — Provider capacity-day integrity.
//
// The defect: a Provider's declared weekly availability is anchored to a
// `week_start_date` DATE. Read back through host-local instant semantics on a
// positive-offset host, that Monday became the preceding Sunday, so
// `publishSupplyWindows` materialised every capacity window one calendar day
// early and MOBILE eligibility then answered for the wrong service day.
//
// This suite fixes the Monday EXPLICITLY rather than deriving it from the
// clock, and asserts absolute calendar dates end to end:
//
//   declared availability -> week_start_date -> supply version read-back
//     -> core_capacity_window.during -> core_supply_window_link.iso_day
//     -> MOBILE service-area eligibility -> provider selection
//
// Because every expectation is an absolute date, running this file under a
// different host timezone is a real proof and not a restatement of whatever
// the host believes today.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import { approvedSupply, loadAvailabilityVersion } from "../../src/provider/supply";
import type { PartnerHost } from "../../src/host/partnerHost";
import {
    activate,
    approvedPartner,
    getProviderPool,
    ownerSession,
    resetProvider,
    startPartnerOrThrow,
    week
} from "./providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * An explicit Monday. Not `DateTime.now().plus(...)` — the whole point is that
 * the expected calendar day is stated, not inferred from the host.
 */
const MONDAY = "2026-09-28";
const TUESDAY = "2026-09-29";
const ZONE = "Asia/Makassar";

/** Monday in Seminyak, Tuesday in Canggu — the R32 asymmetry. */
const ASYMMETRIC = week([
    { isoDay: 1, available: true, startTime: "09:00", endTime: "17:00", regions: ["Seminyak"] },
    { isoDay: 2, available: true, startTime: "09:00", endTime: "17:00", regions: ["Canggu"] },
    { isoDay: 3, available: false },
    { isoDay: 4, available: false },
    { isoDay: 5, available: false }
]);

d("SCP-R42 / Provider capacity-day integrity", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };
    let customerIdentityId: string;
    let serviceId: string;

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

    /** 11:00 market-local on an explicit calendar date. */
    function at(date: string): Date {
        return DateTime.fromISO(date, { zone: ZONE })
            .set({ hour: 11, minute: 0, second: 0, millisecond: 0 })
            .toJSDate();
    }

    async function evaluate(area: string, date: string) {
        const outcome = await withTransaction(pool, (client) =>
            evaluateServiceCommerce(client, {
                marketId: "bali",
                topology: "MOBILE",
                serviceId,
                customerIdentityId,
                serviceAreaKey: area,
                requestedStart: at(date)
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
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("R42-T01 — the stored week start is the declared Monday and reads back unchanged", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate: MONDAY
        });

        // 1. Postgres holds the declared Monday.
        const stored = await pool.query<{ d: string; isodow: number }>(
            `SELECT week_start_date AS d, EXTRACT(ISODOW FROM week_start_date)::int AS isodow
               FROM core_provider_availability_version
              WHERE availability_version_id = $1`,
            [partner.availabilityVersionId]
        );
        expect(stored.rows[0]!.d).toBe(MONDAY);
        expect(stored.rows[0]!.isodow).toBe(1);

        // 2. Both affected application read paths return the same calendar
        //    date — these are the exact steps that shifted before R42.
        const version = await withTransaction(pool, (client) =>
            loadAvailabilityVersion(client, partner.availabilityVersionId)
        );
        expect(version?.weekStartDate).toBe(MONDAY);
        expect(version?.weekStartDate).not.toBe("2026-09-27");

        const supply = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate: MONDAY })
        );
        expect(supply.map((s) => s.weekStartDate)).toEqual([MONDAY]);
    });

    it("R42-T02 — capacity windows land on the declared local service dates", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate: MONDAY
        });

        const { rows } = await pool.query<{
            iso_day: number;
            location_id: string;
            starts: Date;
        }>(
            `SELECT l.iso_day, w.location_id, lower(w.during) AS starts
               FROM core_capacity_window w
               JOIN core_supply_window_link l ON l.window_id = w.window_id
              WHERE w.provider_id = $1 AND w.active = TRUE
              ORDER BY l.iso_day`,
            [partner.providerId]
        );

        // 4 + 5: the window opens on the declared date, in the market's zone,
        // and its iso_day agrees with the calendar day it actually covers.
        const observed = rows.map((r) => ({
            isoDay: r.iso_day,
            region: r.location_id,
            localDate: DateTime.fromJSDate(r.starts).setZone(ZONE).toFormat("yyyy-MM-dd"),
            localTime: DateTime.fromJSDate(r.starts).setZone(ZONE).toFormat("HH:mm")
        }));
        expect(observed).toEqual([
            { isoDay: 1, region: "Seminyak", localDate: MONDAY, localTime: "09:00" },
            { isoDay: 2, region: "Canggu", localDate: TUESDAY, localTime: "09:00" }
        ]);

        // The defect's exact signature: a window opening the day before.
        for (const row of observed) {
            expect(row.localDate).not.toBe("2026-09-27");
        }
        // And iso_day must match the real weekday of the date it covers.
        for (const row of observed) {
            expect(DateTime.fromISO(row.localDate, { zone: ZONE }).weekday).toBe(row.isoDay);
        }
    });

    it("R42-T03 — MOBILE eligibility answers for the declared day, not the day before", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate: MONDAY
        });
        await enableMobileCommerce();

        // 6 + 7: the governed answer, and the provider selected with it.
        const mondaySeminyak = await evaluate("Seminyak", MONDAY);
        expect(mondaySeminyak.outcome).toBe("SELLABLE");
        expect(mondaySeminyak.terms?.providerId).toBe(partner.providerId);
        expect(mondaySeminyak.terms?.serviceAreaKey).toBe("Seminyak");

        const tuesdayCanggu = await evaluate("Canggu", TUESDAY);
        expect(tuesdayCanggu.outcome).toBe("SELLABLE");
        expect(tuesdayCanggu.terms?.providerId).toBe(partner.providerId);

        // The asymmetry still holds — R42 restored the day, it did not widen it.
        expect((await evaluate("Canggu", MONDAY)).outcome).not.toBe("SELLABLE");
        expect((await evaluate("Seminyak", TUESDAY)).outcome).not.toBe("SELLABLE");

        // The Sunday before the declared Monday must never have become sellable.
        expect((await evaluate("Seminyak", "2026-09-27")).outcome).not.toBe("SELLABLE");
    });

    it("R42-T04 — the partner's own view of its week is the date it declared", async () => {
        const partner = await approvedPartner(host.origin, owner.token, {
            days: ASYMMETRIC,
            weekStartDate: MONDAY
        });
        const response = await fetch(`${host.origin}/api/partner/me`, {
            headers: { "x-partner-session": partner.token }
        });
        const body = (await response.json()) as {
            availability: Array<{ weekStartDate: string }>;
        };
        expect(response.status).toBe(200);
        expect(body.availability.map((a) => a.weekStartDate)).toEqual([MONDAY]);
    });
});
