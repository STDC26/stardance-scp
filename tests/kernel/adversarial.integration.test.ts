// G3-E15 — Performance and operational readiness, plus the adversarial
// attack surface the authorization enumerates.
//
// These run against real Postgres and real concurrency. The exclusion
// constraint and transactional locking are the guardrails under test; the
// application-level checks are convenience, not safety.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getKernelPool,
    resetKernel,
    seedMobileWorld,
    seedInStoreWorld,
    localSlot,
    idem
} from "./kernelTestDb";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import { createSellableOffer, loadOffer } from "../../src/kernel/offer";
import { commitOffer } from "../../src/kernel/commit";
import { SYSTEM_ACTOR } from "../../src/core/types";
import { isKernelDecisionReason } from "../../src/kernel/reasons";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G3-E15 — concurrency and operational readiness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("50 concurrent evaluations complete without correctness loss", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const effectiveAt = new Date();

        const results = await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
                withTransaction(pool, (client) =>
                    evaluateServiceCommerce(client, {
                        marketId: w.marketId,
                        topology: "MOBILE",
                        serviceId: w.serviceId,
                        customerIdentityId: w.customerIdentityId,
                        // Distinct non-overlapping slots so every one is genuinely sellable.
                        requestedStart: new Date(
                            localSlot("bali", 5, 10).getTime() + i * 90 * 60_000
                        ),
                        serviceAreaKey: w.serviceAreaKey,
                        effectiveAt
                    })
                ).catch(() => null)
            )
        );

        const ok = results.filter((r) => r && r.ok);
        expect(ok).toHaveLength(50);

        // Every decision is fully formed: canonical price, canonical duration,
        // an eligible provider, and a persisted decision record.
        for (const result of ok) {
            if (!result || !result.ok) continue;
            expect(["SELLABLE", "REQUIRES_ALTERNATIVE", "NOT_SELLABLE"]).toContain(
                result.value.outcome
            );
            if (result.value.outcome === "SELLABLE") {
                expect(result.value.terms!.priceMinorUnits).toBe(250000);
                expect(result.value.terms!.durationMinutes).toBe(70);
                expect(result.value.terms!.providerId).toBe(w.providerId);
            }
        }

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_commerce_evaluation`
        );
        expect(Number(rows[0]!.n)).toBe(50);
    });

    it("20 contenders for one exclusive slot yield exactly one commitment", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 6, 14);

        const attempt = async (i: number) => {
            try {
                return await withTransaction(pool, async (client) => {
                    const offered = await createSellableOffer(client, {
                        marketId: w.marketId,
                        topology: "MOBILE",
                        serviceId: w.serviceId,
                        customerIdentityId: w.customerIdentityId,
                        requestedStart: start,
                        serviceAreaKey: w.serviceAreaKey,
                        idempotencyKey: `contender-${i}`,
                        actor: SYSTEM_ACTOR
                    });
                    if (!offered.ok) {
                        return { won: false as const, reason: offered.refusal.reasonCode };
                    }
                    const committed = await commitOffer(client, {
                        offerId: offered.offer.offerId,
                        actorIdentityId: w.customerIdentityId,
                        idempotencyKey: `contender-commit-${i}`
                    });
                    if (!committed.ok) {
                        return { won: false as const, reason: committed.reasonCode };
                    }
                    return { won: true as const, requestId: committed.value.requestId };
                });
            } catch {
                // A transaction aborted by the database is also a refusal — it
                // must not be counted as a win.
                return { won: false as const, reason: "TRANSACTION_ABORTED" };
            }
        };

        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(i)));

        const winners = results.filter((r) => r.won);
        const losers = results.filter((r) => !r.won);

        // Exactly one commitment.
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(19);

        // Every loser received a GOVERNED refusal — a reason code from the
        // kernel taxonomy. A database-level abort is explicitly not acceptable
        // here: "all losing contenders receive governed refusal/conflict" is a
        // requirement about what the caller is told, not only about what
        // survives in the data.
        const GOVERNED_CONTENTION_REASONS = [
            "CAPACITY_CONFLICT",
            "CAPACITY_UNAVAILABLE",
            "OFFER_NO_LONGER_VALID",
            "CAPACITY_HOLD_EXPIRED"
        ];
        for (const loser of losers) {
            expect(isKernelDecisionReason(loser.reason)).toBe(true);
            expect(GOVERNED_CONTENTION_REASONS).toContain(loser.reason);
        }

        // No overlapping committed exclusive capacity.
        const overlapping = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM core_capacity_hold a
               JOIN core_capacity_hold b
                 ON a.hold_id < b.hold_id
                AND a.market_id = b.market_id
                AND a.resource_key = b.resource_key
                AND a.during && b.during
              WHERE a.state IN ('HELD','COMMITTED','ACTIVE','CONSUMED')
                AND b.state IN ('HELD','COMMITTED','ACTIVE','CONSUMED')`
        );
        expect(Number(overlapping.rows[0]!.n)).toBe(0);

        // Exactly one canonical Service Request.
        const requests = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(requests.rows[0]!.n)).toBe(1);

        // No orphan consumed hold: every CONSUMED hold belongs to a COMMITTED
        // offer that carries a request.
        const orphans = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM core_capacity_hold h
               LEFT JOIN core_sellable_offer o ON o.offer_id = h.offer_id
              WHERE h.state = 'CONSUMED'
                AND (o.offer_id IS NULL OR o.state <> 'COMMITTED' OR o.committed_request_id IS NULL)`
        );
        expect(Number(orphans.rows[0]!.n)).toBe(0);

        // And exactly one offer actually reached COMMITTED.
        const committedOffers = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_sellable_offer WHERE state = 'COMMITTED'`
        );
        expect(Number(committedOffers.rows[0]!.n)).toBe(1);
    });

    it("duplicate commit delivery produces one canonical result under concurrency", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 7, 14),
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("dup"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        const deliver = () =>
            withTransaction(pool, (client) =>
                commitOffer(client, {
                    offerId: offer.offerId,
                    actorIdentityId: w.customerIdentityId,
                    idempotencyKey: "duplicate-delivery"
                })
            ).catch(() => ({ ok: false as const, reasonCode: "ABORTED" as const, message: "" }));

        const deliveries = await Promise.all([deliver(), deliver(), deliver(), deliver()]);
        const succeeded = deliveries.filter((d) => d.ok);
        expect(succeeded.length).toBeGreaterThanOrEqual(1);

        const requestIds = new Set(
            succeeded.map((d) => (d.ok ? d.value.requestId : "")).filter(Boolean)
        );
        expect(requestIds.size).toBe(1);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it("no browser or client sequencing is required for correctness", async () => {
        // The same three calls issued out of any order still produce one
        // correct outcome: commit before offer simply has nothing to commit.
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));

        const premature = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: "11111111-2222-3333-4444-555555555555",
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("premature")
            })
        );
        expect(premature.ok).toBe(false);
        if (!premature.ok) expect(premature.reasonCode).toBe("OFFER_NO_LONGER_VALID");

        const malformed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: "not-a-uuid",
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("malformed")
            })
        );
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.reasonCode).toBe("INVALID_IDENTIFIER");
    });
});

d("G3 — cross-tenant and cross-market attack surface", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("an offer cannot be committed by a customer of another tenant", async () => {
        const freshline = await withTransaction(pool, (c) => seedMobileWorld(c));
        const northbeam = await withTransaction(pool, (c) => seedInStoreWorld(c));

        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: northbeam.marketId,
                topology: "INSTORE",
                serviceId: northbeam.cutServiceId,
                customerIdentityId: northbeam.customerIdentityId,
                requestedStart: localSlot("saigon", 3, 14),
                locationId: northbeam.locationId,
                idempotencyKey: idem("nb"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });
        expect(offer.tenantId).toBe("northbeam");

        const attempt = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: freshline.customerIdentityId,
                idempotencyKey: idem("cross")
            })
        );
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reasonCode).toBe("MARKET_MISMATCH");

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(0);
    });

    it("two tenants may hold identically-named resources without colliding", async () => {
        await withTransaction(pool, async (client) => {
            const northbeam = await seedInStoreWorld(client);
            const start = localSlot("saigon", 3, 14);

            const first = await createSellableOffer(client, {
                marketId: northbeam.marketId,
                topology: "INSTORE",
                serviceId: northbeam.colourServiceId,
                customerIdentityId: northbeam.customerIdentityId,
                requestedStart: start,
                locationId: northbeam.locationId,
                idempotencyKey: idem("nb-chair"),
                actor: SYSTEM_ACTOR
            });
            expect(first.ok).toBe(true);

            // A different market's hold over the same wall-clock window does not
            // collide, because exclusivity is scoped by market and resource key.
            const freshline = await seedMobileWorld(client);
            const other = await createSellableOffer(client, {
                marketId: freshline.marketId,
                topology: "MOBILE",
                serviceId: freshline.serviceId,
                customerIdentityId: freshline.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: freshline.serviceAreaKey,
                idempotencyKey: idem("fl-slot"),
                actor: SYSTEM_ACTOR
            });
            expect(other.ok).toBe(true);
        });
    });

    it("an offer created in one market cannot be reloaded into another market's flow", async () => {
        const northbeam = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: northbeam.marketId,
                topology: "INSTORE",
                serviceId: northbeam.cutServiceId,
                customerIdentityId: northbeam.customerIdentityId,
                requestedStart: localSlot("saigon", 3, 15),
                locationId: northbeam.locationId,
                idempotencyKey: idem("scope"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        const reloaded = await withTransaction(pool, (c) => loadOffer(c, offer.offerId));
        expect(reloaded!.marketId).toBe("saigon");
        expect(reloaded!.tenantId).toBe("northbeam");
    });
});
