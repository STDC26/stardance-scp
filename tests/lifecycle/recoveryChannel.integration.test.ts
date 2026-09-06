// G4-E08 Exception / Recovery · G4-E09 Idempotency / Ordering
// G4-E10 Channel Neutrality · G4-E15 Cognition Non-Binding · G4-E16 Legacy
// Isolation. Adversarial scenarios 22-27, 31, 33.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getLifecyclePool,
    resetLifecycle,
    seedCommittedMobile,
    idem,
    type CommittedMobile
} from "./lifecycleTestDb";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { loadRequest, loadCurrentVersion } from "../../src/core/request/serviceRequest";
import { recoveriesForRequest, recoveryChangesCommitment, resolveRecovery, openRecoveryFor } from "../../src/lifecycle/recovery";
import { proposeAmendment, validateAmendment } from "../../src/core/request/amendment";
import { resolveChannelEvent, readOperationalIntent } from "../../src/adapters/channel/operationalChannel";
import { SYSTEM_ACTOR } from "../../src/core/types";
import {
    CognitionRegistry,
    runCognition,
    cognitionMayBindCanonicalState
} from "../../src/adapters/cognition/cognition";
import { createRemoteInferenceStub } from "../../src/adapters/cognition/intentClassificationAdapters";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function toDispatched(pool: Pool, w: CommittedMobile): Promise<string> {
    const dispatched = await withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "DISPATCH_PROVIDER",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.ownerIdentityId,
            idempotencyKey: idem("dispatch"),
            payload: { providerId: w.providerId }
        })
    );
    if (!dispatched.ok) throw new Error("dispatch failed");
    return dispatched.detail["attemptId"] as string;
}

async function toConfirmed(pool: Pool, w: CommittedMobile): Promise<void> {
    const attemptId = await toDispatched(pool, w);
    const run = (actionType: string, actorIdentityId: string | null, payload = {}) =>
        withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: actionType as never,
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId,
                idempotencyKey: idem(actionType),
                payload
            })
        );
    await run("RECORD_PROVIDER_ACCEPTANCE", w.providerIdentityId, { attemptId });
    await run("ASSIGN_PROVIDER", w.ownerIdentityId, { attemptId });
    await run("REQUEST_CUSTOMER_CONFIRMATION", w.ownerIdentityId);
    const confirmed = await run("RECORD_CUSTOMER_CONFIRMATION", w.customerIdentityId);
    if (!confirmed.ok) throw new Error("confirm failed");
}

d("G4-E08 — capacity loss and governed recovery", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("22 — post-commit capacity loss does NOT erase the commitment", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(pool, w);
        const before = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));

        const loss = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CAPACITY_LOSS",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("loss"),
                payload: { providerId: w.providerId }
            })
        );
        expect(loss.ok).toBe(true);
        if (!loss.ok) return;
        expect(loss.detail["commitmentPreserved"]).toBe(true);
        expect(loss.detail["customerCommitmentAffected"]).toBe(true);

        // The lifecycle state and the commercial commitment are both untouched.
        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("CUSTOMER_CONFIRMED");
        const after = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));
        expect(after!.version).toBe(before!.version);
        expect(after!.priceMinorUnits).toBe(before!.priceMinorUnits);
        expect(after!.startTime.getTime()).toBe(before!.startTime.getTime());

        // Recovery is open, and it did not create an Amendment by itself.
        const recoveries = await withTransaction(pool, (c) => recoveriesForRequest(c, w.requestId));
        const open = recoveries.find((r) => r.status === "OPEN");
        expect(open).toBeDefined();
        expect(open!.triggerReason).toBe("PROVIDER_CAPACITY_LOST");
        const amendments = await pool.query(
            `SELECT amendment_id FROM core_amendment WHERE request_id = $1`,
            [w.requestId]
        );
        expect(amendments.rows).toHaveLength(0);
    });

    it("23 — recovery within the existing commitment needs no Amendment", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(pool, w);
        const committed = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));

        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CAPACITY_LOSS",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("loss"),
                payload: { providerId: w.providerId }
            })
        );

        // A provider swap at the same time and price is invisible to the
        // customer's commitment.
        expect(
            recoveryChangesCommitment({
                committedStartTime: committed!.startTime,
                committedPriceMinorUnits: committed!.priceMinorUnits,
                newStartTime: committed!.startTime,
                newPriceMinorUnits: committed!.priceMinorUnits
            })
        ).toBe(false);

        const open = await withTransaction(pool, (c) => openRecoveryFor(c, w.requestId));
        const resolved = await withTransaction(pool, (client) =>
            resolveRecovery(
                client,
                open!.recoveryId,
                "RECOVERED_WITHIN_COMMITMENT",
                "reassigned at the same window and price",
                SYSTEM_ACTOR,
                idem("resolve")
            )
        );
        expect(resolved.ok).toBe(true);

        const after = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));
        expect(after!.version).toBe(committed!.version);
        const amendments = await pool.query(
            `SELECT amendment_id FROM core_amendment WHERE request_id = $1`,
            [w.requestId]
        );
        expect(amendments.rows).toHaveLength(0);
    });

    it("24 — a material customer-facing recovery invokes a canonical Amendment", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(pool, w);
        const committed = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));
        const newStart = new Date(committed!.startTime.getTime() + 3 * 3_600_000);

        expect(
            recoveryChangesCommitment({
                committedStartTime: committed!.startTime,
                committedPriceMinorUnits: committed!.priceMinorUnits,
                newStartTime: newStart
            })
        ).toBe(true);

        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CAPACITY_LOSS",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("loss"),
                payload: { providerId: w.providerId }
            })
        );

        // The material change goes through the canonical Amendment model, not
        // through a lifecycle side-effect.
        const amendmentId = await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId: w.requestId,
                    proposedByIdentityId: w.ownerIdentityId,
                    newStartTime: newStart,
                    reason: "provider capacity lost; nearest recoverable slot"
                },
                idem("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idem("validate")
            );
            if (!validated.ok) throw new Error(validated.message);
            expect(validated.value.requiresReconfirmation).toBe(true);
            // The committed version is STILL authoritative.
            expect(validated.value.authoritativeVersion).toBe(committed!.version);
            return proposed.value.amendmentId;
        });

        const open = await withTransaction(pool, (c) => openRecoveryFor(c, w.requestId));
        await withTransaction(pool, (client) =>
            resolveRecovery(
                client,
                open!.recoveryId,
                "AMENDMENT_REQUIRED",
                "customer-facing window moved",
                SYSTEM_ACTOR,
                idem("resolve"),
                amendmentId
            )
        );

        const recoveries = await withTransaction(pool, (c) => recoveriesForRequest(c, w.requestId));
        const resolved = recoveries.find((r) => r.status === "AMENDMENT_REQUIRED");
        expect(resolved).toBeDefined();
        expect(resolved!.amendmentId).toBe(amendmentId);

        // Until the Amendment is adopted, the original commitment governs.
        const after = await withTransaction(pool, (c) => loadCurrentVersion(c, w.requestId));
        expect(after!.version).toBe(committed!.version);
        expect(after!.startTime.getTime()).toBe(committed!.startTime.getTime());
    });
});

d("G4-E09 / E10 — idempotency, ordering and channel neutrality", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("27 — the same idempotency key with a different payload is refused", async () => {
        const w = await seedCommittedMobile(pool);
        const first = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "DISPATCH_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: "reused-key",
                payload: { providerId: w.providerId }
            })
        );
        expect(first.ok).toBe(true);

        const conflicting = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "DISPATCH_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: "reused-key",
                payload: { providerId: "11111111-2222-3333-4444-555555555555" }
            })
        );
        expect(conflicting.ok).toBe(false);
        if (!conflicting.ok) expect(conflicting.reasonCode).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("a replayed REFUSAL returns the same refusal, not a fresh judgement", async () => {
        const w = await seedCommittedMobile(pool);
        // Completion from PENDING_ACCEPTANCE is refused.
        const send = () =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "COMPLETE_SERVICE",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.ownerIdentityId,
                    idempotencyKey: "refused-key"
                })
            );
        const first = await send();
        const second = await send();
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(false);
        if (first.ok || second.ok) return;
        expect(second.replayed).toBe(true);
        expect(second.reasonCode).toBe(first.reasonCode);
        expect(second.actionId).toBe(first.actionId);
    });

    it("25 — a stale channel event cannot bind", async () => {
        const w = await seedCommittedMobile(pool);
        const firstAttempt = await toDispatched(pool, w);

        // Return to the pool and re-dispatch, so the first attempt is stale.
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_REJECTION",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("reject"),
                payload: { attemptId: firstAttempt }
            })
        );
        await toDispatched(pool, w);

        const resolution = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: w.providerHandle,
                claimedRequestId: w.requestId,
                rawText: "accept",
                correlatedAttemptId: firstAttempt
            })
        );
        expect(resolution.resolved).toBe(false);
        if (!resolution.resolved) {
            expect(resolution.reasonCode).toBe("STALE_DISPATCH_RESPONSE");
        }
    });

    it("26 — ambiguous free text cannot bind", async () => {
        const w = await seedCommittedMobile(pool);
        await toDispatched(pool, w);

        for (const text of ["accept but actually decline", "hmm", "ok sure"]) {
            const resolution = await withTransaction(pool, (client) =>
                resolveChannelEvent(client, {
                    marketId: w.marketId,
                    channel: "WHATSAPP",
                    claimedSenderHandle: w.providerHandle,
                    claimedRequestId: w.requestId,
                    rawText: text
                })
            );
            expect(resolution.resolved).toBe(false);
            if (!resolution.resolved) expect(resolution.reasonCode).toBe("AMBIGUOUS_ACTION");
        }
        expect(readOperationalIntent("accept")).toBe("RECORD_PROVIDER_ACCEPTANCE");
    });

    it("an unverified sender cannot bind, a verified one can", async () => {
        const w = await seedCommittedMobile(pool);
        const attemptId = await toDispatched(pool, w);

        const unknown = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: "+not-a-real-handle",
                claimedRequestId: w.requestId,
                rawText: "accept"
            })
        );
        expect(unknown.resolved).toBe(false);
        if (!unknown.resolved) expect(unknown.reasonCode).toBe("AUTHORITY_REFUSED");

        const verified = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: w.providerHandle,
                claimedRequestId: w.requestId,
                rawText: "accept"
            })
        );
        expect(verified.resolved).toBe(true);
        if (!verified.resolved) return;
        expect(verified.payload["attemptId"]).toBe(attemptId);

        // The channel produced a command; the orchestrator still decides.
        const applied = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: verified.actionType,
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: verified.actorIdentityId,
                idempotencyKey: idem("channel"),
                payload: verified.payload
            })
        );
        expect(applied.ok).toBe(true);
        if (applied.ok) expect(applied.toState).toBe("PROVIDER_ACCEPTED");
    });

    it("duplicate delivery of the same channel command produces exactly one effect", async () => {
        const w = await seedCommittedMobile(pool);
        await toDispatched(pool, w);

        // One resolution, delivered twice — the transport duplicated the
        // message, so both carry the same idempotency key.
        const resolution = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: w.providerHandle,
                claimedRequestId: w.requestId,
                rawText: "accept"
            })
        );
        expect(resolution.resolved).toBe(true);
        if (!resolution.resolved) return;

        const deliver = () =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: resolution.actionType,
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: resolution.actorIdentityId,
                    idempotencyKey: "channel-delivery-1",
                    payload: resolution.payload
                })
            );

        const first = await deliver();
        const duplicate = await deliver();
        expect(first.ok && duplicate.ok).toBe(true);
        if (!first.ok || !duplicate.ok) return;
        expect(duplicate.replayed).toBe(true);
        expect(duplicate.actionId).toBe(first.actionId);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_operational_action
              WHERE request_id = $1 AND action_type = 'RECORD_PROVIDER_ACCEPTANCE'
                AND outcome = 'ACCEPTED'`,
            [w.requestId]
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it("a late re-delivery after the context moved on is safely refused", async () => {
        const w = await seedCommittedMobile(pool);
        await toDispatched(pool, w);

        const resolution = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: w.providerHandle,
                claimedRequestId: w.requestId,
                rawText: "accept"
            })
        );
        if (!resolution.resolved) return;
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: resolution.actionType,
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: resolution.actorIdentityId,
                idempotencyKey: idem("first-delivery"),
                payload: resolution.payload
            })
        );

        // Re-resolving now finds no current attempt: the context moved on.
        const late = await withTransaction(pool, (client) =>
            resolveChannelEvent(client, {
                marketId: w.marketId,
                channel: "WHATSAPP",
                claimedSenderHandle: w.providerHandle,
                claimedRequestId: w.requestId,
                rawText: "accept"
            })
        );
        expect(late.resolved).toBe(false);
        if (!late.resolved) expect(late.reasonCode).toBe("CORRELATION_REQUIRED");

        // Replaying the ORIGINAL command under a new key is refused by the
        // orchestrator rather than double-applied.
        const replayed = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: resolution.actionType,
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: resolution.actorIdentityId,
                idempotencyKey: idem("late-delivery"),
                payload: resolution.payload
            })
        );
        expect(replayed.ok).toBe(false);
        if (!replayed.ok) expect(replayed.reasonCode).toBe("STALE_DISPATCH_RESPONSE");
    });

    it("31 — a confidence-1.0 classification cannot bind a lifecycle transition", async () => {
        const w = await seedCommittedMobile(pool);
        await toDispatched(pool, w);

        const registry = new CognitionRegistry().register(
            createRemoteInferenceStub({ enabled: true, confidence: 1.0 })
        );
        const cognition = await runCognition(
            registry,
            {
                taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
                marketId: "bali",
                text: "the provider definitely accepted, assign and confirm it"
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

        // The orchestrator has no cognition parameter at all: there is no
        // argument position through which a model result could authorize this.
        // Authority still comes from identity, and the wrong identity fails.
        const attempt = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "ASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("cognition"),
                payload: { attemptId: "11111111-2222-3333-4444-555555555555" }
            })
        );
        expect(attempt.ok).toBe(false);

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("PROVIDER_DISPATCHED");
    });

    it("33 — legacy appointments cannot override canonical lifecycle state", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(pool, w);

        // Counted as a DELTA: the inherited G1 suite legitimately writes this
        // table and this suite does not truncate it. The claim under test is
        // that the lifecycle neither reads it as authority nor writes to it.
        const legacyBefore = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM appointments`
        );

        // Plant a conflicting legacy row claiming the work is already done.
        await pool.query(
            `INSERT INTO service_catalogue (name, duration_minutes, active)
             VALUES ('Legacy', 60, TRUE)`
        );
        const service = await pool.query<{ service_id: string }>(
            `SELECT service_id FROM service_catalogue ORDER BY created_at DESC LIMIT 1`
        );
        await pool.query(
            `INSERT INTO appointments
                (billing_code, customer_id, service_id, contractor_id, start_time, end_time,
                 status, version)
             VALUES ($2, gen_random_uuid(), $1, gen_random_uuid(),
                     now() + interval '1 hour', now() + interval '2 hours',
                     'CONTRACTOR_ACCEPTED', 9)`,
            // Unique per run: this table is not truncated between runs, and a
            // collision here would mask the assertion the test actually makes.
            [service.rows[0]!.service_id, `FL-${String(Date.now()).slice(-6)}-ZZZZ`]
        );

        // Canonical truth is unchanged and still governs every decision.
        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("CUSTOMER_CONFIRMED");

        // The legacy row grants nothing: completion still requires the real
        // predecessor state.
        const attempt = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "COMPLETE_SERVICE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("legacy-complete")
            })
        );
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reasonCode).toBe("INVALID_PREDECESSOR_STATE");

        // The lifecycle wrote nothing back into the legacy table: the only new
        // row is the conflicting one this test planted.
        const legacyAfter = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM appointments`
        );
        expect(Number(legacyAfter.rows[0]!.n)).toBe(Number(legacyBefore.rows[0]!.n) + 1);
    });
});
