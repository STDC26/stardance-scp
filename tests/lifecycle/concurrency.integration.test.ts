// G4-E18 — Concurrency and operational readiness.
// Adversarial scenarios 34-35.

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
import { isLifecycleReason } from "../../src/lifecycle/reasons";
import { assignmentsForRequest } from "../../src/lifecycle/providerAssignment";
import { loadRequest } from "../../src/core/request/serviceRequest";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G4-E18 — concurrency and operational readiness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("34 — 50 concurrent independent operational actions, no correctness loss", async () => {
        // 50 INDEPENDENT requests, each dispatched concurrently. Independent
        // work must not be globally serialized, so these share no exclusive
        // resource and must all succeed.
        const worlds: CommittedMobile[] = [];
        for (let i = 0; i < 10; i++) {
            worlds.push(await seedCommittedMobile(pool, i));
        }

        const actions = worlds.flatMap((w, i) => [
            { w, key: `bulk-dispatch-${i}` },
            { w, key: `bulk-dispatch-${i}` }, // duplicate delivery of the same command
            { w, key: `bulk-noop-${i}` },
            { w, key: `bulk-noop2-${i}` },
            { w, key: `bulk-noop3-${i}` }
        ]);

        const results = await Promise.all(
            actions.map(({ w, key }) =>
                withTransaction(pool, (client) =>
                    executeOperationalAction(client, {
                        actionType: "DISPATCH_PROVIDER",
                        marketId: w.marketId,
                        requestId: w.requestId,
                        actorIdentityId: w.ownerIdentityId,
                        idempotencyKey: key,
                        payload: { providerId: w.providerId }
                    })
                ).catch((err: unknown) => ({
                    ok: false as const,
                    reasonCode: `RAW_DB_ABORT(${
                        typeof err === "object" && err !== null && "code" in err
                            ? String((err as { code: unknown }).code)
                            : "?"
                    })` as never
                }))
            )
        );
        expect(results).toHaveLength(50);

        // ZERO raw database abort leakage. Listed rather than asserted one at a
        // time so a failure names exactly what leaked.
        const nonGoverned = results
            .filter((r) => !r.ok)
            .map((r) => (r as { reasonCode: string }).reasonCode)
            .filter((code) => !isLifecycleReason(code));
        expect(nonGoverned).toEqual([]);

        // Every one of the 10 independent requests advanced exactly once.
        for (const w of worlds) {
            const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
            expect(request!.state).toBe("PROVIDER_DISPATCHED");
            const { rows } = await pool.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM core_dispatch_offer WHERE request_id = $1`,
                [w.requestId]
            );
            expect(Number(rows[0]!.n)).toBe(1);
        }
    });

    it("35 — 20 contenders for one exclusive assignment yield one governed winner", async () => {
        const w = await seedCommittedMobile(pool);

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

        // 20 owners race to assign the same request. Distinct idempotency keys,
        // so this is genuine contention rather than replay.
        const contend = (i: number) =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "ASSIGN_PROVIDER",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.ownerIdentityId,
                    idempotencyKey: `contender-${i}`,
                    payload: { attemptId }
                })
            ).catch((err: unknown) => ({
                ok: false as const,
                reasonCode: `RAW_DB_ABORT(${
                    typeof err === "object" && err !== null && "code" in err
                        ? String((err as { code: unknown }).code)
                        : "?"
                })` as never
            }));

        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => contend(i)));
        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(19);

        // ZERO raw database abort leakage: every loser holds a governed reason
        // from the lifecycle taxonomy, not a driver error.
        for (const loser of losers) {
            expect(isLifecycleReason(loser.reasonCode)).toBe(true);
            expect(["ASSIGNMENT_CONFLICT", "INVALID_PREDECESSOR_STATE", "STALE_OPERATIONAL_CONTEXT"]).toContain(
                loser.reasonCode
            );
        }

        // Exactly one ACTIVE assignment, and exactly one accepted action.
        const assignments = await withTransaction(pool, (c) => assignmentsForRequest(c, w.requestId));
        expect(assignments.filter((a) => a.status === "ACTIVE")).toHaveLength(1);
        expect(assignments).toHaveLength(1);

        const accepted = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_operational_action
              WHERE request_id = $1 AND action_type = 'ASSIGN_PROVIDER' AND outcome = 'ACCEPTED'`,
            [w.requestId]
        );
        expect(Number(accepted.rows[0]!.n)).toBe(1);

        // Every refusal was durably recorded too.
        const refused = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_operational_action
              WHERE request_id = $1 AND action_type = 'ASSIGN_PROVIDER' AND outcome = 'REFUSED'`,
            [w.requestId]
        );
        expect(Number(refused.rows[0]!.n)).toBe(19);

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("OWNER_ASSIGNED");
    });

    it("unrelated requests are not globally serialized by lifecycle contention", async () => {
        // Two independent requests. Contention on one must not block the other.
        const a = await seedCommittedMobile(pool, 1);
        const b = await seedCommittedMobile(pool, 2);

        const dispatchBoth = await Promise.all(
            [a, b].map((w, i) =>
                withTransaction(pool, (client) =>
                    executeOperationalAction(client, {
                        actionType: "DISPATCH_PROVIDER",
                        marketId: w.marketId,
                        requestId: w.requestId,
                        actorIdentityId: w.ownerIdentityId,
                        idempotencyKey: `parallel-${i}`,
                        payload: { providerId: w.providerId }
                    })
                )
            )
        );
        expect(dispatchBoth.every((r) => r.ok)).toBe(true);

        for (const w of [a, b]) {
            const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
            expect(request!.state).toBe("PROVIDER_DISPATCHED");
        }
    });
});
