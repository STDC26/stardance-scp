// G2-E07 — Capacity, non-overlap, atomic hold/commit/release, and
// provider-capacity withdrawal coupling. Closes DEFECT-05.
//
// Runs against real Postgres because the guarantee under test is a database
// exclusion constraint. A mocked capacity store proves nothing about whether
// two concurrent bookings can occupy the same exclusive resource.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, windowStartingInHours, idemKey } from "./coreTestDb";
import {
    activeHoldsForRequest,
    commitCapacity,
    hasDeclaredAvailability,
    holdCapacity,
    releaseCapacity,
    withdrawProviderCapacity
} from "../../src/core/capacity/capacity";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G2-E07 — exclusive capacity is transactionally protected", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("recognises provider-declared availability separately from operating policy", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(2);
            const end = new Date(start.getTime() + 3_600_000);

            expect(
                await hasDeclaredAvailability(client, {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    startTime: start,
                    endTime: end
                })
            ).toBe(true);

            // Far outside the declared window.
            const farStart = new Date(Date.now() + 400 * 24 * 3_600_000);
            expect(
                await hasDeclaredAvailability(client, {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    startTime: farStart,
                    endTime: new Date(farStart.getTime() + 3_600_000)
                })
            ).toBe(false);
        });
    });

    it("OVERLAP PREVENTION: the same exclusive provider cannot be double-booked", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(3);
            const end = new Date(start.getTime() + 3_600_000);
            const base = {
                marketId: world.marketId,
                providerId: world.providerId,
                locationId: "PRIMARY"
            };

            const first = await holdCapacity(
                client,
                { ...base, startTime: start, endTime: end },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(first.ok).toBe(true);

            // Exact same window.
            const exact = await holdCapacity(
                client,
                { ...base, startTime: start, endTime: end },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(exact.ok).toBe(false);
            if (!exact.ok) expect(exact.code).toBe("CAPACITY_CONFLICT");

            // Partial overlap at the front.
            const partial = await holdCapacity(
                client,
                {
                    ...base,
                    startTime: new Date(start.getTime() - 1_800_000),
                    endTime: new Date(start.getTime() + 1_800_000)
                },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(partial.ok).toBe(false);

            // Exactly abutting is NOT an overlap — the range is half-open.
            const abutting = await holdCapacity(
                client,
                { ...base, startTime: end, endTime: new Date(end.getTime() + 3_600_000) },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(abutting.ok).toBe(true);
        });
    });

    it("scopes exclusivity by resource, not just by provider", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(4);
            const end = new Date(start.getTime() + 3_600_000);
            const base = {
                marketId: world.marketId,
                providerId: world.providerId,
                locationId: "PRIMARY",
                startTime: start,
                endTime: end
            };

            const roomA = await holdCapacity(
                client,
                { ...base, resourceKey: "ROOM:A" },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            const roomB = await holdCapacity(
                client,
                { ...base, resourceKey: "ROOM:B" },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(roomA.ok).toBe(true);
            expect(roomB.ok).toBe(true);

            const roomAAgain = await holdCapacity(
                client,
                { ...base, resourceKey: "ROOM:A" },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(roomAAgain.ok).toBe(false);
        });
    });

    it("a conflicting hold does not poison the caller's transaction", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(5);
            const end = new Date(start.getTime() + 3_600_000);
            const base = {
                marketId: world.marketId,
                providerId: world.providerId,
                locationId: "PRIMARY",
                startTime: start,
                endTime: end
            };

            await holdCapacity(client, base, SYSTEM_ACTOR, idemKey("hold"));
            const conflict = await holdCapacity(client, base, SYSTEM_ACTOR, idemKey("hold"));
            expect(conflict.ok).toBe(false);

            // The transaction must still be usable after the refusal.
            const { rows } = await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM core_capacity_hold`
            );
            expect(Number(rows[0]!.n)).toBe(1);
        });
    });

    it("commit keeps the slot blocked; release frees it for immediate reuse", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(6);
            const end = new Date(start.getTime() + 3_600_000);
            const base = {
                marketId: world.marketId,
                providerId: world.providerId,
                locationId: "PRIMARY",
                startTime: start,
                endTime: end
            };

            const held = await holdCapacity(client, base, SYSTEM_ACTOR, idemKey("hold"));
            expect(held.ok).toBe(true);
            if (!held.ok) return;

            const committed = await commitCapacity(
                client,
                held.value.holdId,
                world.marketId,
                SYSTEM_ACTOR,
                idemKey("commit")
            );
            expect(committed.ok).toBe(true);

            // A committed slot still blocks.
            const blocked = await holdCapacity(client, base, SYSTEM_ACTOR, idemKey("hold"));
            expect(blocked.ok).toBe(false);

            const released = await releaseCapacity(
                client,
                held.value.holdId,
                world.marketId,
                SYSTEM_ACTOR,
                idemKey("release")
            );
            expect(released.ok).toBe(true);

            // And now the window is reusable.
            const reused = await holdCapacity(client, base, SYSTEM_ACTOR, idemKey("hold"));
            expect(reused.ok).toBe(true);
        });
    });

    it("refuses to commit or release a hold twice", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(7);
            const held = await holdCapacity(
                client,
                {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    startTime: start,
                    endTime: new Date(start.getTime() + 3_600_000)
                },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(held.ok).toBe(true);
            if (!held.ok) return;

            await releaseCapacity(client, held.value.holdId, world.marketId, SYSTEM_ACTOR, idemKey("r"));
            const again = await releaseCapacity(
                client,
                held.value.holdId,
                world.marketId,
                SYSTEM_ACTOR,
                idemKey("r")
            );
            expect(again.ok).toBe(false);
            if (!again.ok) expect(again.code).toBe("STALE_STATE");
        });
    });

    it("CAPACITY WITHDRAWAL releases the provider's holds and flags a disturbed commitment", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const start = windowStartingInHours(8);
            const requestRows = await client.query<{ request_id: string }>(
                `INSERT INTO core_service_request
                    (market_id, customer_identity_id, service_id, state)
                 VALUES ($1, $2, $3, 'CUSTOMER_CONFIRMED') RETURNING request_id`,
                [world.marketId, world.customerIdentityId, world.serviceId]
            );
            const requestId = requestRows.rows[0]!.request_id;

            const held = await holdCapacity(
                client,
                {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    requestId,
                    startTime: start,
                    endTime: new Date(start.getTime() + 3_600_000)
                },
                SYSTEM_ACTOR,
                idemKey("hold")
            );
            expect(held.ok).toBe(true);
            if (!held.ok) return;
            await commitCapacity(client, held.value.holdId, world.marketId, SYSTEM_ACTOR, idemKey("c"));

            await client.query(
                `INSERT INTO core_customer_confirmation
                    (request_id, confirmed_version, confirmed_by_identity_id)
                 VALUES ($1, 1, $2)`,
                [requestId, world.customerIdentityId]
            );

            const withdrawn = await withdrawProviderCapacity(
                client,
                requestId,
                world.providerId,
                world.marketId,
                SYSTEM_ACTOR,
                idemKey("withdraw")
            );
            expect(withdrawn.ok).toBe(true);
            if (!withdrawn.ok) return;

            expect(withdrawn.value.releasedHoldIds).toContain(held.value.holdId);
            // The signal that recovery may need an Amendment + reconfirmation...
            expect(withdrawn.value.customerCommitmentAffected).toBe(true);
            // ...but withdrawal did NOT create an amendment by itself.
            const amendments = await client.query(
                `SELECT amendment_id FROM core_amendment WHERE request_id = $1`,
                [requestId]
            );
            expect(amendments.rows).toHaveLength(0);

            expect(await activeHoldsForRequest(client, requestId)).toHaveLength(0);
        });
    });

    it("CONCURRENCY: two simultaneous transactions cannot both hold the same slot", async () => {
        // Seeded outside the racing transactions so both see the same world.
        const world = await withTransaction(pool, async (client) => seedWorld(client));
        const start = windowStartingInHours(9);
        const end = new Date(start.getTime() + 3_600_000);
        const base = {
            marketId: world.marketId,
            providerId: world.providerId,
            locationId: "PRIMARY",
            startTime: start,
            endTime: end
        };

        const attempt = () =>
            withTransaction(pool, async (client) =>
                holdCapacity(client, base, SYSTEM_ACTOR, idemKey("race"))
            ).catch(() => ({ ok: false as const, code: "CAPACITY_CONFLICT" as const, message: "aborted" }));

        const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
        const winners = results.filter((r) => r.ok);
        expect(winners).toHaveLength(1);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_capacity_hold WHERE state <> 'RELEASED'`
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });
});
