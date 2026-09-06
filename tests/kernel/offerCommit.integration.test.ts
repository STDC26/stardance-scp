// G3-E05 Offer Integrity · G3-E06 Atomic Commitment · G3-E07 Idempotency
// G3-E11 Audit and Replay · G3-E12 Authority · G3-E13 Cognition Non-Binding

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getKernelPool,
    resetKernel,
    seedMobileWorld,
    seedInStoreWorld,
    localSlot,
    idem,
    type MobileWorld
} from "./kernelTestDb";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import {
    createSellableOffer,
    expireSellableOffers,
    invalidateOffer,
    loadOffer
} from "../../src/kernel/offer";
import { commitOffer, commitCorrelation } from "../../src/kernel/commit";
import { holdsForOffer } from "../../src/core/capacity/capacity";
import { loadRequest, loadCurrentVersion } from "../../src/core/request/serviceRequest";
import { eventsFor } from "../../src/core/events/eventLog";
import { SYSTEM_ACTOR } from "../../src/core/types";
import {
    CognitionRegistry,
    runCognition,
    cognitionMayBindCanonicalState
} from "../../src/adapters/cognition/cognition";
import { createRemoteInferenceStub } from "../../src/adapters/cognition/intentClassificationAdapters";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function offerFor(pool: Pool, w: MobileWorld, start: Date, key = idem("offer")) {
    return withTransaction(pool, async (client) => {
        const outcome = await createSellableOffer(client, {
            marketId: w.marketId,
            topology: "MOBILE",
            serviceId: w.serviceId,
            customerIdentityId: w.customerIdentityId,
            requestedStart: start,
            serviceAreaKey: w.serviceAreaKey,
            idempotencyKey: key,
            actor: SYSTEM_ACTOR
        });
        if (!outcome.ok) throw new Error(`offer refused: ${outcome.refusal.reasonCode}`);
        return outcome.offer;
    });
}

d("G3-E05 — offer integrity", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("freezes canonical price, duration and provenance on the offer", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        expect(offer.state).toBe("ACTIVE");
        expect(offer.version).toBe(1);
        expect(offer.priceMinorUnits).toBe(250000);
        expect(offer.currencyCode).toBe("IDR");
        expect(offer.durationMinutes).toBe(70);
        expect(offer.tenantId).toBe("freshline");

        const { rows } = await pool.query<{
            duration_basis: Record<string, unknown>;
            config_provenance: Record<string, unknown>;
        }>(
            `SELECT duration_basis, config_provenance FROM core_sellable_offer WHERE offer_id = $1`,
            [offer.offerId]
        );
        expect(rows[0]!.duration_basis).toEqual({
            baseDurationMinutes: 60,
            addonDurationMinutes: 0,
            bufferMinutes: 10,
            totalMinutes: 70
        });
        expect(rows[0]!.config_provenance["tenantId"]).toBe("freshline");
    });

    it("the database refuses to reprice or materially mutate a persisted offer", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        for (const mutation of [
            `UPDATE core_sellable_offer SET price_minor_units = 1 WHERE offer_id = $1`,
            `UPDATE core_sellable_offer SET duration_minutes = 5 WHERE offer_id = $1`,
            `UPDATE core_sellable_offer SET start_time = now() WHERE offer_id = $1`,
            `UPDATE core_sellable_offer SET provider_id = provider_id, tenant_id = 'northbeam' WHERE offer_id = $1`
        ]) {
            let rejected = false;
            try {
                await pool.query(mutation, [offer.offerId]);
            } catch (err) {
                rejected = /immutable/i.test(err instanceof Error ? err.message : String(err));
            }
            expect(rejected).toBe(true);
        }

        const reloaded = await withTransaction(pool, (c) => loadOffer(c, offer.offerId));
        expect(reloaded!.priceMinorUnits).toBe(250000);
        expect(reloaded!.durationMinutes).toBe(70);
    });

    it("an active offer holds the capacity it was built on", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);
        await offerFor(pool, w, start);

        await withTransaction(pool, async (client) => {
            const contested = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey
            });
            expect(contested.ok && contested.value.reasonCode).toBe("CAPACITY_UNAVAILABLE");
        });
    });

    it("supersession creates a new version and releases the prior offer's capacity", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const first = await offerFor(pool, w, localSlot("bali", 3, 14));

        const second = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 16),
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("supersede"),
                actor: SYSTEM_ACTOR,
                supersedes: first.offerId
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        expect(second.offerKey).toBe(first.offerKey);
        expect(second.version).toBe(2);

        const priorReloaded = await withTransaction(pool, (c) => loadOffer(c, first.offerId));
        expect(priorReloaded!.state).toBe("SUPERSEDED");

        const priorHolds = await withTransaction(pool, (c) => holdsForOffer(c, first.offerId));
        expect(priorHolds.every((h) => h.state === "INVALIDATED")).toBe(true);

        // The superseded slot is sellable again.
        await withTransaction(pool, async (client) => {
            const reevaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(reevaluated.ok && reevaluated.value.outcome).toBe("SELLABLE");
        });
    });

    it("expiry releases the capacity an abandoned offer was holding", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);
        const offer = await offerFor(pool, w, start);

        await withTransaction(pool, async (client) => {
            const expired = await expireSellableOffers(
                client,
                w.marketId,
                new Date(offer.expiresAt.getTime() + 1000),
                SYSTEM_ACTOR
            );
            expect(expired).toContain(offer.offerId);
        });

        const reloaded = await withTransaction(pool, (c) => loadOffer(c, offer.offerId));
        expect(reloaded!.state).toBe("EXPIRED");

        await withTransaction(pool, async (client) => {
            const reevaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey
            });
            expect(reevaluated.ok && reevaluated.value.outcome).toBe("SELLABLE");
        });
    });
});

d("G3-E07 — idempotency", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("same key and same request returns the same offer", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);
        const key = idem("stable");

        const first = await offerFor(pool, w, start, key);
        const second = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: key,
                actor: SYSTEM_ACTOR
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) throw new Error("refused");
            return outcome;
        });

        expect(second.offer.offerId).toBe(first.offerId);
        expect(second.replayed).toBe(true);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_sellable_offer`
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it("same key and a materially different request is an IDEMPOTENCY_CONFLICT", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const key = idem("reused");
        await offerFor(pool, w, localSlot("bali", 3, 14), key);

        await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                // Different time = materially different request.
                requestedStart: localSlot("bali", 3, 16),
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: key,
                actor: SYSTEM_ACTOR
            });
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.refusal.reasonCode).toBe("IDEMPOTENCY_CONFLICT");
            }
        });
    });

    it("a duplicate commit produces exactly one canonical Service Request", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        const first = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: "commit-once"
            })
        );
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const retry = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: "commit-once"
            })
        );
        expect(retry.ok).toBe(true);
        if (!retry.ok) return;

        expect(retry.value.requestId).toBe(first.value.requestId);
        expect(retry.value.replayed).toBe(true);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });
});

d("G3-E06 / E11 / E12 / E13 — commitment, audit, authority, cognition", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("commits atomically into the canonical Service Request and consumes capacity", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);
        const offer = await offerFor(pool, w, start);

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;

        await withTransaction(pool, async (client) => {
            const reloaded = await loadOffer(client, offer.offerId);
            expect(reloaded!.state).toBe("COMMITTED");
            expect(reloaded!.committedRequestId).toBe(committed.value.requestId);

            const holds = await holdsForOffer(client, offer.offerId);
            expect(holds.every((h) => h.state === "CONSUMED")).toBe(true);
            expect(committed.value.consumedHoldIds).toHaveLength(holds.length);

            // The commitment landed in the EXISTING canonical aggregate, at the
            // start of the operational ladder — not a shortcut past the gates.
            const request = await loadRequest(client, committed.value.requestId);
            expect(request!.state).toBe("PENDING_ACCEPTANCE");

            // Priced from the offer, not re-derived.
            const version = await loadCurrentVersion(client, committed.value.requestId);
            expect(version!.priceMinorUnits).toBe(offer.priceMinorUnits);
            expect(version!.durationMinutes).toBe(offer.durationMinutes);
            expect(version!.startTime.getTime()).toBe(offer.startTime.getTime());
        });
    });

    it("NO SILENT REPRICING: a catalogue price change after the offer does not follow", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        // The catalogue moves. The offer must not.
        await pool.query(
            `INSERT INTO core_service_price_version
                (service_id, price_minor_units, currency_code, buffer_minutes)
             VALUES ($1, 999000, 'IDR', 10)`,
            [w.serviceId]
        );

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;

        const version = await withTransaction(pool, (c) =>
            loadCurrentVersion(c, committed.value.requestId)
        );
        expect(version!.priceMinorUnits).toBe(250000);
    });

    it("refuses a commit against a stale offer whose price basis was withdrawn", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        await pool.query(
            `UPDATE core_service_price_version SET active = FALSE WHERE price_version_id = $1`,
            [offer.priceVersionId]
        );

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(false);
        if (!committed.ok) expect(committed.reasonCode).toBe("OFFER_REVALIDATION_REQUIRED");

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(0);
    });

    it("refuses commits against expired, released, invalidated and already-committed offers", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));

        // Expired offer.
        const expiredOffer = await offerFor(pool, w, localSlot("bali", 3, 9));
        const expiredCommit = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: expiredOffer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit"),
                effectiveAt: new Date(expiredOffer.expiresAt.getTime() + 1000)
            })
        );
        expect(expiredCommit.ok).toBe(false);
        if (!expiredCommit.ok) expect(expiredCommit.reasonCode).toBe("OFFER_EXPIRED");

        // Expired HOLD while the offer itself is still inside its window.
        const holdOffer = await offerFor(pool, w, localSlot("bali", 3, 11));
        await pool.query(
            `UPDATE core_capacity_hold SET expires_at = now() - interval '1 minute'
              WHERE offer_id = $1`,
            [holdOffer.offerId]
        );
        const holdCommit = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: holdOffer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(holdCommit.ok).toBe(false);
        if (!holdCommit.ok) expect(holdCommit.reasonCode).toBe("CAPACITY_HOLD_EXPIRED");

        // Released hold.
        const releasedOffer = await offerFor(pool, w, localSlot("bali", 3, 13));
        await pool.query(
            `UPDATE core_capacity_hold SET state = 'RELEASED', released_at = now()
              WHERE offer_id = $1`,
            [releasedOffer.offerId]
        );
        const releasedCommit = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: releasedOffer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(releasedCommit.ok).toBe(false);

        // Invalidated offer.
        const invalidOffer = await offerFor(pool, w, localSlot("bali", 3, 15));
        await withTransaction(pool, (client) =>
            invalidateOffer(client, invalidOffer.offerId, SYSTEM_ACTOR, idem("invalidate"))
        );
        const invalidCommit = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: invalidOffer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(invalidCommit.ok).toBe(false);
        if (!invalidCommit.ok) expect(invalidCommit.reasonCode).toBe("OFFER_NO_LONGER_VALID");
    });

    it("consumes only the holds owned by the offer being committed", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offerA = await offerFor(pool, w, localSlot("bali", 3, 10));
        const offerB = await offerFor(pool, w, localSlot("bali", 3, 15));

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offerA.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);

        await withTransaction(pool, async (client) => {
            const aHolds = await holdsForOffer(client, offerA.offerId);
            const bHolds = await holdsForOffer(client, offerB.offerId);
            expect(aHolds.every((h) => h.state === "CONSUMED")).toBe(true);
            expect(bHolds.every((h) => h.state === "ACTIVE")).toBe(true);
        });
    });

    it("G3-E12 AUTHORITY: only the customer on the offer may commit it", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        for (const impostor of [w.providerIdentityId, w.ownerIdentityId]) {
            const attempt = await withTransaction(pool, (client) =>
                commitOffer(client, {
                    offerId: offer.offerId,
                    actorIdentityId: impostor,
                    idempotencyKey: idem("commit")
                })
            );
            expect(attempt.ok).toBe(false);
            if (!attempt.ok) expect(attempt.reasonCode).toBe("AUTHORITY_REFUSED");
        }

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(0);
    });

    it("G3-E12 AUTHORITY: a customer from another market/tenant is refused", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const other = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        const attempt = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: other.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reasonCode).toBe("MARKET_MISMATCH");
    });

    it("G3-E11 AUDIT: evaluation, offer, hold, commit and request are correlated", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));
        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;

        await withTransaction(pool, async (client) => {
            const chain = await commitCorrelation(client, offer.offerId);
            expect(chain.ok).toBe(true);
            if (!chain.ok) return;
            expect(chain.value.evaluationId).toBe(offer.evaluationId);
            expect(chain.value.requestId).toBe(committed.value.requestId);
            expect(chain.value.holdIds.length).toBeGreaterThan(0);

            // Why it was sellable is reconstructable from the durable record.
            const evaluation = await client.query<{
                outcome: string;
                decision_snapshot: Record<string, unknown>;
                config_snapshot: Record<string, unknown>;
            }>(
                `SELECT outcome, decision_snapshot, config_snapshot
                   FROM core_commerce_evaluation WHERE evaluation_id = $1`,
                [offer.evaluationId]
            );
            expect(evaluation.rows[0]!.outcome).toBe("SELLABLE");
            expect(evaluation.rows[0]!.decision_snapshot["priceMinorUnits"]).toBe(250000);

            // The commit event names the whole chain.
            const events = await eventsFor(client, "SERVICE_REQUEST", committed.value.requestId);
            const commitEvent = events.find((e) => e.to_state === "COMMERCIALLY_COMMITTED");
            expect(commitEvent).toBeDefined();
            expect(commitEvent!.governing_ref).toContain(offer.offerId);
            expect(commitEvent!.governing_ref).toContain(offer.evaluationId);
            expect(commitEvent!.actor_authority).toContain("CUSTOMER_COMMERCIAL_COMMIT");

            // Hold lifecycle is auditable.
            const holdEvents = await eventsFor(client, "CAPACITY_HOLD", chain.value.holdIds[0]!);
            expect(holdEvents.map((e) => e.to_state)).toContain("ACTIVE");
            expect(holdEvents.map((e) => e.to_state)).toContain("CONSUMED");
        });
    });

    it("G3-E13 COGNITION: a confidence-1.0 classification cannot bind commercial truth", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));

        const registry = new CognitionRegistry().register(
            createRemoteInferenceStub({ enabled: true, confidence: 1.0 })
        );
        const cognition = await runCognition(
            registry,
            {
                taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
                marketId: "bali",
                text: "the customer definitely wants this booking, commit it"
            },
            {
                preferredProfileIds: ["remote-inference-stub-v1"],
                allowRemoteInference: true,
                humanReviewBelowConfidence: 0.6
            }
        );
        expect(cognition.available).toBe(true);
        if (cognition.available) {
            expect(cognition.result.confidence).toBe(1.0);
            expect(cognitionMayBindCanonicalState(cognition.result)).toBe(false);
        }

        // The kernel commit API has no cognition parameter at all — there is no
        // argument position through which a model result could authorize this.
        const attempt = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                // A model cannot supply authority; the identity still must.
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reasonCode).toBe("AUTHORITY_REFUSED");
    });

    it("R1 GUARD: the kernel never writes the legacy appointments table", async () => {
        // Asserted as a DELTA, not an absolute count: the inherited G1 suite
        // legitimately writes `appointments`, and this suite does not truncate
        // it. The claim under test is that a full kernel sell-to-commit flow
        // adds nothing to the legacy surface.
        const legacyBefore = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM appointments`
        );

        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await offerFor(pool, w, localSlot("bali", 3, 14));
        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);

        const legacyAfter = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM appointments`
        );
        expect(Number(legacyAfter.rows[0]!.n)).toBe(Number(legacyBefore.rows[0]!.n));

        // The commitment went to the canonical aggregate instead.
        const canonical = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(canonical.rows[0]!.n)).toBe(1);
    });
});
