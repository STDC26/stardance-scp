// G4-E04 Dispatch Correctness · G4-E05 Assignment Correctness
// Adversarial scenarios 01-09.

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
import { attemptsForRequest, currentAttempt } from "../../src/lifecycle/dispatchAttempt";
import { activeAssignment, assignmentsForRequest } from "../../src/lifecycle/providerAssignment";
import { loadRequest } from "../../src/core/request/serviceRequest";
import { recoveriesForRequest } from "../../src/lifecycle/recovery";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function dispatch(pool: Pool, w: CommittedMobile, effectiveAt?: Date) {
    return withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "DISPATCH_PROVIDER",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.ownerIdentityId,
            idempotencyKey: idem("dispatch"),
            payload: { providerId: w.providerId },
            ...(effectiveAt ? { effectiveAt } : {})
        })
    );
}

d("G4-E04 — dispatch correctness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("01 — PENDING_ACCEPTANCE to PROVIDER_DISPATCHED via a governed action", async () => {
        const w = await seedCommittedMobile(pool);
        const before = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(before!.state).toBe("PENDING_ACCEPTANCE");

        const result = await dispatch(pool, w);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.fromState).toBe("PENDING_ACCEPTANCE");
        expect(result.toState).toBe("PROVIDER_DISPATCHED");
        expect(result.detail["attemptVersion"]).toBe(1);

        const after = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(after!.state).toBe("PROVIDER_DISPATCHED");
    });

    it("02 — acceptance on the exact current attempt succeeds", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");
        const attemptId = dispatched.detail["attemptId"] as string;

        const accepted = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_ACCEPTANCE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("accept"),
                payload: { attemptId }
            })
        );
        expect(accepted.ok).toBe(true);
        if (accepted.ok) expect(accepted.toState).toBe("PROVIDER_ACCEPTED");
    });

    it("03 — acceptance after the window closed is refused as DISPATCH_EXPIRED", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");
        const attemptId = dispatched.detail["attemptId"] as string;

        const late = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_ACCEPTANCE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("late"),
                payload: { attemptId },
                // Bali's configured acceptance window is 15 minutes.
                effectiveAt: new Date(Date.now() + 20 * 60_000)
            })
        );
        expect(late.ok).toBe(false);
        if (!late.ok) expect(late.reasonCode).toBe("DISPATCH_EXPIRED");

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("PROVIDER_DISPATCHED");
    });

    it("04 — acceptance naming a superseded prior attempt is refused", async () => {
        const w = await seedCommittedMobile(pool);
        const first = await dispatch(pool, w);
        if (!first.ok) throw new Error("dispatch failed");
        const firstAttemptId = first.detail["attemptId"] as string;

        // Expire and re-dispatch to create attempt v2.
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "EXPIRE_DISPATCH",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: null,
                idempotencyKey: idem("expire"),
                payload: { attemptId: firstAttemptId },
                effectiveAt: new Date(Date.now() + 20 * 60_000)
            })
        );
        const second = await dispatch(pool, w);
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.detail["attemptVersion"]).toBe(2);

        const stale = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_ACCEPTANCE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("stale"),
                payload: { attemptId: firstAttemptId }
            })
        );
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.reasonCode).toBe("DISPATCH_EXPIRED");
    });

    it("a new dispatch supersedes an open prior attempt", async () => {
        const w = await seedCommittedMobile(pool);
        const first = await dispatch(pool, w);
        if (!first.ok) throw new Error("dispatch failed");

        // Return to the pool via rejection so a second dispatch is legal.
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_REJECTION",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("reject"),
                payload: { attemptId: first.detail["attemptId"] }
            })
        );
        const second = await dispatch(pool, w);
        expect(second.ok).toBe(true);

        const attempts = await withTransaction(pool, (c) => attemptsForRequest(c, w.requestId));
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.state).toBe("DECLINED");
        expect(attempts[1]!.state).toBe("OFFERED");
        expect(attempts[1]!.attemptVersion).toBe(2);
    });

    it("05 — duplicate acceptance produces exactly one effect", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");
        const attemptId = dispatched.detail["attemptId"] as string;

        const send = () =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "RECORD_PROVIDER_ACCEPTANCE",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.providerIdentityId,
                    idempotencyKey: "accept-once",
                    payload: { attemptId }
                })
            );

        const first = await send();
        const second = await send();
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.replayed).toBe(true);
        expect(second.actionId).toBe(first.actionId);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_operational_action
              WHERE request_id = $1 AND action_type = 'RECORD_PROVIDER_ACCEPTANCE'`,
            [w.requestId]
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it("provider rejection returns the request to the pool through governed recovery", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");

        const rejected = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_REJECTION",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("reject"),
                payload: { attemptId: dispatched.detail["attemptId"] }
            })
        );
        expect(rejected.ok).toBe(true);
        if (rejected.ok) expect(rejected.toState).toBe("PENDING_ACCEPTANCE");

        const recoveries = await withTransaction(pool, (c) => recoveriesForRequest(c, w.requestId));
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]!.triggerReason).toBe("DISPATCH_REJECTED");
        expect(recoveries[0]!.status).toBe("RECOVERED_WITHIN_COMMITMENT");
    });

    it("dispatch expiry returns to the pool and never manufactures acceptance", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");

        const expired = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "EXPIRE_DISPATCH",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: null,
                idempotencyKey: idem("expire"),
                payload: { attemptId: dispatched.detail["attemptId"] },
                effectiveAt: new Date(Date.now() + 20 * 60_000)
            })
        );
        expect(expired.ok).toBe(true);
        if (expired.ok) expect(expired.toState).toBe("PENDING_ACCEPTANCE");

        const attempt = await withTransaction(pool, (c) =>
            attemptsForRequest(c, w.requestId)
        );
        expect(attempt[0]!.state).toBe("EXPIRED");
        expect(await withTransaction(pool, (c) => currentAttempt(c, w.requestId))).toBeNull();
    });

    it("refuses to dispatch to unapproved supply", async () => {
        const w = await seedCommittedMobile(pool);
        await pool.query(`UPDATE core_provider SET supply_status = 'SUSPENDED' WHERE provider_id = $1`, [
            w.providerId
        ]);
        const result = await dispatch(pool, w);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reasonCode).toBe("PROVIDER_NO_LONGER_ELIGIBLE");
    });
});

d("G4-E05 — assignment correctness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    async function accepted(w: CommittedMobile): Promise<string> {
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");
        const attemptId = dispatched.detail["attemptId"] as string;
        const acceptance = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_ACCEPTANCE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("accept"),
                payload: { attemptId }
            })
        );
        if (!acceptance.ok) throw new Error("acceptance failed");
        return attemptId;
    }

    it("06 — a provider cannot self-assign", async () => {
        const w = await seedCommittedMobile(pool);
        const attemptId = await accepted(w);

        const attempt = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "ASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("selfassign"),
                payload: { attemptId }
            })
        );
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reasonCode).toBe("AUTHORITY_REFUSED");

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("PROVIDER_ACCEPTED");
        expect(await withTransaction(pool, (c) => activeAssignment(c, w.requestId))).toBeNull();
    });

    it("07 — owner assignment requires a valid provider acceptance first", async () => {
        const w = await seedCommittedMobile(pool);
        const dispatched = await dispatch(pool, w);
        if (!dispatched.ok) throw new Error("dispatch failed");

        // Still PROVIDER_DISPATCHED — nobody accepted.
        const premature = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "ASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("premature"),
                payload: { attemptId: dispatched.detail["attemptId"] }
            })
        );
        expect(premature.ok).toBe(false);
        if (!premature.ok) expect(premature.reasonCode).toBe("INVALID_PREDECESSOR_STATE");

        // After acceptance it succeeds.
        const attemptId = dispatched.detail["attemptId"] as string;
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_PROVIDER_ACCEPTANCE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("accept"),
                payload: { attemptId }
            })
        );
        const assigned = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "ASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("assign"),
                payload: { attemptId }
            })
        );
        expect(assigned.ok).toBe(true);
        if (assigned.ok) expect(assigned.toState).toBe("OWNER_ASSIGNED");
    });

    it("08 — concurrent owner assignments produce exactly one active assignment", async () => {
        const w = await seedCommittedMobile(pool);
        const attemptId = await accepted(w);

        const attempt = (i: number) =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "ASSIGN_PROVIDER",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.ownerIdentityId,
                    idempotencyKey: `concurrent-assign-${i}`,
                    payload: { attemptId }
                })
            ).catch(() => ({ ok: false as const, reasonCode: "ABORTED" as const }));

        const results = await Promise.all([0, 1, 2, 3, 4].map(attempt));
        const winners = results.filter((r) => r.ok);
        expect(winners).toHaveLength(1);

        const assignments = await withTransaction(pool, (c) => assignmentsForRequest(c, w.requestId));
        expect(assignments.filter((a) => a.status === "ACTIVE")).toHaveLength(1);
    });

    it("09 — reassignment replaces ownership without duplicating the commitment", async () => {
        const w = await seedCommittedMobile(pool);
        const attemptId = await accepted(w);
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "ASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("assign"),
                payload: { attemptId }
            })
        );

        // A second approved provider to hand the work to.
        const second = await withTransaction(pool, async (client) => {
            const identity = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Relief')
                 RETURNING identity_id`,
                [w.marketId]
            );
            const identityId = identity.rows[0]!.identity_id;
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1,$2,'PROVIDER')`,
                [identityId, w.marketId]
            );
            const provider = await client.query<{ provider_id: string }>(
                `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
                 VALUES ($1, $2, 'Relief', 'APPROVED') RETURNING provider_id`,
                [w.marketId, identityId]
            );
            return provider.rows[0]!.provider_id;
        });

        const reassigned = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "REASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("reassign"),
                payload: { providerId: second }
            })
        );
        expect(reassigned.ok).toBe(true);
        if (!reassigned.ok) return;
        expect(reassigned.detail["assignmentVersion"]).toBe(2);

        const assignments = await withTransaction(pool, (c) => assignmentsForRequest(c, w.requestId));
        expect(assignments).toHaveLength(2);
        expect(assignments[0]!.status).toBe("REPLACED");
        expect(assignments[0]!.replacedBy).toBe(assignments[1]!.assignmentId);
        expect(assignments[1]!.status).toBe("ACTIVE");
        expect(assignments[1]!.providerId).toBe(second);

        // Exactly one Service Request, one commercial commitment.
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });
});
