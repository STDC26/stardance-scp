// G2-E10 — Dispatch Offer lifecycle: offer, decline, expiry, late-acceptance
// rejection, and the concurrent sweep-vs-acceptance race.
//
// This is the G1 REQ-OPS-TIMEOUT-09 guarantee carried forward onto the
// canonical model. The G1 proof continues to run unchanged against the legacy
// `appointments` surface; this suite proves the same safety property holds for
// core_dispatch_offer / core_service_request.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, windowStartingInHours, idemKey } from "./coreTestDb";
import { createServiceRequest, loadRequest } from "../../src/core/request/serviceRequest";
import {
    expireDispatchOffers,
    loadOffer,
    offerDispatch,
    respondToOffer
} from "../../src/core/dispatch/dispatchOffer";
import { eventsFor } from "../../src/core/events/eventLog";
import { SYSTEM_ACTOR } from "../../src/core/types";
import { loadMarketConfig } from "../../src/config/marketConfig";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function seedDispatchedRequest(pool: Pool, offeredMinutesAgo = 0) {
    return withTransaction(pool, async (client) => {
        const world = await seedWorld(client);
        const created = await createServiceRequest(
            client,
            {
                marketId: world.marketId,
                customerIdentityId: world.customerIdentityId,
                serviceId: world.serviceId,
                startTime: windowStartingInHours(24)
            },
            SYSTEM_ACTOR,
            idemKey("create")
        );
        if (!created.ok) throw new Error(created.message);

        const offered = await offerDispatch(
            client,
            {
                requestId: created.value.requestId,
                providerId: world.providerId,
                marketId: "bali",
                now: () => new Date(Date.now() - offeredMinutesAgo * 60_000)
            },
            SYSTEM_ACTOR,
            idemKey("offer")
        );
        if (!offered.ok) throw new Error(offered.message);

        return { world, requestId: created.value.requestId, offerId: offered.value.offerId };
    });
}

d("G2-E10 — Dispatch Offer", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("derives the acceptance window from market configuration, not a Core constant", async () => {
        const { offerId } = await seedDispatchedRequest(pool);
        const offer = await withTransaction(pool, (c) => loadOffer(c, offerId));
        const configured = loadMarketConfig("bali").dispatch.acceptanceTimeoutMinutes;
        // Bali is 15 and Bangkok is 20 — a Core constant could not produce both.
        expect(configured).toBe(15);
        expect(offer).not.toBeNull();
        const windowMinutes = Math.round(
            (offer!.expiresAt.getTime() - (Date.now() - 0)) / 60_000
        );
        expect(windowMinutes).toBeGreaterThanOrEqual(configured - 1);
        expect(windowMinutes).toBeLessThanOrEqual(configured + 1);
    });

    it("refuses to dispatch to unapproved supply", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            await client.query(
                `UPDATE core_provider SET supply_status = 'SUBMITTED' WHERE provider_id = $1`,
                [world.providerId]
            );
            const created = await createServiceRequest(
                client,
                {
                    marketId: world.marketId,
                    customerIdentityId: world.customerIdentityId,
                    serviceId: world.serviceId,
                    startTime: windowStartingInHours(24)
                },
                SYSTEM_ACTOR,
                idemKey("create")
            );
            expect(created.ok).toBe(true);
            if (!created.ok) return;

            const offered = await offerDispatch(
                client,
                {
                    requestId: created.value.requestId,
                    providerId: world.providerId,
                    marketId: "bali"
                },
                SYSTEM_ACTOR,
                idemKey("offer")
            );
            expect(offered.ok).toBe(false);
            if (!offered.ok) expect(offered.code).toBe("PROVIDER_NOT_APPROVED");
        });
    });

    it("acceptance records acceptance ONLY — it does not assign the request", async () => {
        const { world, requestId, offerId } = await seedDispatchedRequest(pool);
        await withTransaction(pool, async (client) => {
            const responded = await respondToOffer(
                client,
                { offerId, identityId: world.providerIdentityId, decision: "ACCEPT" },
                idemKey("respond")
            );
            expect(responded.ok).toBe(true);
            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("PROVIDER_ACCEPTED");
            // No assignment row was created by acceptance.
            const assignments = await client.query(
                `SELECT assignment_id FROM core_assignment WHERE request_id = $1`,
                [requestId]
            );
            expect(assignments.rows).toHaveLength(0);
        });
    });

    it("decline releases the request to PENDING_ACCEPTANCE and never becomes a request state", async () => {
        const { world, requestId, offerId } = await seedDispatchedRequest(pool);
        await withTransaction(pool, async (client) => {
            const responded = await respondToOffer(
                client,
                { offerId, identityId: world.providerIdentityId, decision: "DECLINE" },
                idemKey("respond")
            );
            expect(responded.ok).toBe(true);
            if (responded.ok) expect(responded.value.requestState).toBe("PENDING_ACCEPTANCE");

            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("PENDING_ACCEPTANCE");

            const offer = await loadOffer(client, offerId);
            expect(offer!.state).toBe("DECLINED");

            // The decline is visible in the audit trail as an OFFER outcome.
            const offerEvents = await eventsFor(client, "DISPATCH_OFFER", offerId);
            expect(offerEvents.some((e) => e.to_state === "DECLINED")).toBe(true);

            const requestEvents = await eventsFor(client, "SERVICE_REQUEST", requestId);
            expect(requestEvents.some((e) => /DECLINED/.test(e.to_state))).toBe(false);
        });
    });

    it("rejects a response from an identity that is not the offered provider", async () => {
        const { world, offerId } = await seedDispatchedRequest(pool);
        await withTransaction(pool, async (client) => {
            const responded = await respondToOffer(
                client,
                { offerId, identityId: world.customerIdentityId, decision: "ACCEPT" },
                idemKey("respond")
            );
            expect(responded.ok).toBe(false);
            if (!responded.ok) expect(responded.code).toBe("UNAUTHORIZED");
        });
    });

    it("LATE ACCEPTANCE is rejected", async () => {
        // Offered 20 minutes ago against a 15-minute window.
        const { world, offerId } = await seedDispatchedRequest(pool, 20);
        await withTransaction(pool, async (client) => {
            const responded = await respondToOffer(
                client,
                { offerId, identityId: world.providerIdentityId, decision: "ACCEPT" },
                idemKey("respond")
            );
            expect(responded.ok).toBe(false);
            if (!responded.ok) expect(responded.code).toBe("OFFER_EXPIRED");
        });
    });

    it("refuses a second decision on an already-decided offer", async () => {
        const { world, offerId } = await seedDispatchedRequest(pool);
        await withTransaction(pool, async (client) => {
            const first = await respondToOffer(
                client,
                { offerId, identityId: world.providerIdentityId, decision: "ACCEPT" },
                idemKey("respond")
            );
            expect(first.ok).toBe(true);
        });
        await withTransaction(pool, async (client) => {
            const second = await respondToOffer(
                client,
                { offerId, identityId: world.providerIdentityId, decision: "DECLINE" },
                idemKey("respond")
            );
            expect(second.ok).toBe(false);
            if (!second.ok) expect(second.code).toBe("OFFER_ALREADY_DECIDED");
        });
    });

    it("the expiry sweep atomically returns an expired offer's request to the pool", async () => {
        const { requestId, offerId } = await seedDispatchedRequest(pool, 20);
        await withTransaction(pool, async (client) => {
            const swept = await expireDispatchOffers(client, "bali");
            expect(swept.expired).toContain(offerId);

            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("PENDING_ACCEPTANCE");
            const offer = await loadOffer(client, offerId);
            expect(offer!.state).toBe("EXPIRED");
        });
    });

    it("the sweep does NOT touch an offer still inside its window", async () => {
        const { requestId, offerId } = await seedDispatchedRequest(pool, 5);
        await withTransaction(pool, async (client) => {
            const swept = await expireDispatchOffers(client, "bali");
            expect(swept.expired).not.toContain(offerId);
            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("PROVIDER_DISPATCHED");
        });
    });

    it("CRITICAL STRESS CHECK: concurrent sweep and valid acceptance produce exactly one winner", async () => {
        const ITERATIONS = 15;

        for (let i = 0; i < ITERATIONS; i++) {
            await resetCore(pool);
            // Offered 20 minutes ago: the sweep considers it expired, while the
            // acceptance path is given a clock that still considers it live.
            const { world, requestId, offerId } = await seedDispatchedRequest(pool, 20);
            const acceptClock = () => new Date(Date.now() - 19 * 60_000);

            const [sweep, accept] = await Promise.all([
                withTransaction(pool, (client) => expireDispatchOffers(client, "bali")).catch(
                    () => ({ scanned: 0, expired: [] as string[], skippedAlreadyResolved: [] as string[] })
                ),
                withTransaction(pool, (client) =>
                    respondToOffer(
                        client,
                        {
                            offerId,
                            identityId: world.providerIdentityId,
                            decision: "ACCEPT",
                            now: acceptClock
                        },
                        idemKey("race")
                    )
                ).catch(() => ({ ok: false as const, code: "STALE_STATE" as const, message: "aborted" }))
            ]);

            const sweepWon = sweep.expired.includes(offerId);
            const acceptWon = accept.ok === true;

            // INVARIANT 1 — exactly one side wins. Never both, never neither.
            expect(sweepWon !== acceptWon).toBe(true);

            // INVARIANT 2 — the offer is in exactly the winner's terminal state.
            const finalOffer = await withTransaction(pool, (c) => loadOffer(c, offerId));
            expect(finalOffer!.state).toBe(sweepWon ? "EXPIRED" : "ACCEPTED");

            // INVARIANT 3 — no split brain between offer and request.
            const finalRequest = await withTransaction(pool, (c) => loadRequest(c, requestId));
            expect(finalRequest!.state).toBe(sweepWon ? "PENDING_ACCEPTANCE" : "PROVIDER_ACCEPTED");

            // INVARIANT 4 — exactly one transition off PROVIDER_DISPATCHED was audited.
            const events = await withTransaction(pool, (c) =>
                eventsFor(c, "SERVICE_REQUEST", requestId)
            );
            const offDispatched = events.filter((e) => e.from_state === "PROVIDER_DISPATCHED");
            expect(offDispatched).toHaveLength(1);
        }
    });
});
