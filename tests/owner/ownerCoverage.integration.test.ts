// SCP-G5-H-UX-CLOSE-03B — the Owner coverage view (C03A-D07).
//
// The operator can now see the supply and coverage that matching will actually
// consider. The point of these proofs is that seeing is not doing: the view
// reports `approvedSupply` — the same governed projection the kernel consumes —
// and cannot create eligibility, assignment or any other truth.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
    bootWorld,
    createApprovedProvider,
    getOwnerPool,
    ownerCall,
    shutdownWorld,
    type OwnerWorld
} from "./ownerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("SCP-G5-H-UX-CLOSE-03B / Owner coverage visibility", () => {
    let pool: Pool;
    let world: OwnerWorld;

    beforeEach(async () => {
        pool = getOwnerPool();
        world = await bootWorld(pool);
    });
    afterEach(async () => {
        await shutdownWorld(world);
        await pool?.end();
    });

    it("COV-01 — reports approved supply, coverage regions and the confirmed week", async () => {
        const provider = await createApprovedProvider(world);
        const res = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`);

        expect(res.status).toBe(200);
        expect(res.body["weekStartDate"]).toBe(world.monday);
        expect(res.body["approvedSupplyCount"]).toBe(1);
        expect(res.body["coverageRegions"]).toBeInstanceOf(Array);
        expect((res.body["coverageRegions"] as string[]).length).toBeGreaterThan(0);

        const supply = res.body["supply"] as Array<Record<string, unknown>>;
        expect(supply).toHaveLength(1);
        expect(supply[0]!["providerId"]).toBe(provider.providerId);
        expect(supply[0]!["weekStartDate"]).toBe(world.monday);
        expect(supply[0]!["days"]).toBeInstanceOf(Array);
    });

    it("COV-02 — the empty state is a real answer, not a blank", async () => {
        // No approved provider at all: the operator must be told there is no
        // eligible supply, because that is exactly when matching will refuse.
        const res = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`);
        expect(res.status).toBe(200);
        expect(res.body["approvedSupplyCount"]).toBe(0);
        expect(res.body["coverageRegions"]).toEqual([]);
        expect(res.body["supply"]).toEqual([]);
    });

    it("COV-03 — the view agrees with the governed projection exactly", async () => {
        await createApprovedProvider(world);
        const res = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`);
        const supply = res.body["supply"] as Array<Record<string, unknown>>;

        // Every region the view reports is a region the projection carries —
        // the header is a union of the rows, never an assertion of its own.
        const fromRows = [
            ...new Set(supply.flatMap((s) => s["coverageRegions"] as string[]))
        ].sort();
        expect(res.body["coverageRegions"]).toEqual(fromRows);
        expect(res.body["approvedSupplyCount"]).toBe(supply.length);
    });

    it("COV-04 — reading coverage changes nothing", async () => {
        await createApprovedProvider(world);
        const before = await pool.query<{ n: string }>(
            `SELECT (SELECT count(*) FROM core_operational_action)::text || ':' ||
                    (SELECT count(*) FROM core_event)::text || ':' ||
                    (SELECT count(*) FROM core_dispatch_offer)::text AS n`
        );
        for (let i = 0; i < 3; i += 1) {
            expect((await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`)).status).toBe(200);
        }
        const after = await pool.query<{ n: string }>(
            `SELECT (SELECT count(*) FROM core_operational_action)::text || ':' ||
                    (SELECT count(*) FROM core_event)::text || ':' ||
                    (SELECT count(*) FROM core_dispatch_offer)::text AS n`
        );
        expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it("COV-05 — coverage is Owner-only and scope-safe", async () => {
        const provider = await createApprovedProvider(world);
        for (const token of ["", "not-a-token"]) {
            const attempt = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`, { token });
            expect(attempt.status).toBe(401);
        }
        const asPartner = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`, {
            token: provider.token
        });
        expect([401, 403]).toContain(asPartner.status);
    });

    it("COV-06 — a malformed week is refused rather than guessed", async () => {
        for (const week of ["", "not-a-date", "2026-13-99", "28-09-2026"]) {
            const res = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${encodeURIComponent(week)}`);
            expect(res.status, week).toBeGreaterThanOrEqual(400);
        }
    });

    it("COV-07 — the view carries no assignment authority", async () => {
        await createApprovedProvider(world);
        const res = await ownerCall(world, "GET", `/api/owner/coverage?weekStartDate=${world.monday}`);
        // The response is supply description only: no request, no offer, no
        // attempt, no state — nothing an operator could mistake for a booking.
        const keys = Object.keys(res.body).sort();
        expect(keys).toEqual(["approvedSupplyCount", "correlationId", "coverageRegions", "supply", "weekStartDate"]);
        const supply = res.body["supply"] as Array<Record<string, unknown>>;
        for (const entry of supply) {
            expect(entry["requestId"]).toBeUndefined();
            expect(entry["offerId"]).toBeUndefined();
            expect(entry["state"]).toBeUndefined();
        }
    });
});
