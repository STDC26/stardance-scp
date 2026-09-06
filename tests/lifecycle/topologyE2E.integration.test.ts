// G4-E11 Freshline Mobile Reproof · G4-E12 InStore Generalization
// G4-E13 Hybrid Neutrality · G4-E14 Audit / Replay · G4-E01 Canonical Ownership
// Adversarial scenarios 28-30, 32.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getLifecyclePool,
    resetLifecycle,
    seedCommittedMobile,
    seedCommittedInStore,
    seedCommittedHybrid,
    idem
} from "./lifecycleTestDb";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { actionsForRequest } from "../../src/lifecycle/actions";
import { loadRequest } from "../../src/core/request/serviceRequest";
import { attemptsForRequest } from "../../src/lifecycle/dispatchAttempt";
import { assignmentsForRequest } from "../../src/lifecycle/providerAssignment";
import { contextsForRequest } from "../../src/lifecycle/confirmationContext";
import { eventsFor } from "../../src/core/events/eventLog";
import type { MarketId } from "../../src/config/marketConfig";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

interface Lane {
    marketId: MarketId;
    requestId: string;
    providerId: string;
    providerIdentityId: string;
    ownerIdentityId: string;
    customerIdentityId: string;
}

/**
 * The complete successful lifecycle, driven only through
 * executeOperationalAction. Every terrain uses this same function — that is the
 * topology-neutrality claim, made executable.
 */
async function runFullLifecycle(pool: Pool, lane: Lane): Promise<string[]> {
    const states: string[] = [];
    const act = async (
        actionType: string,
        actorIdentityId: string | null,
        payload: Record<string, unknown> = {}
    ) => {
        const outcome = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: actionType as never,
                marketId: lane.marketId,
                requestId: lane.requestId,
                actorIdentityId,
                idempotencyKey: idem(actionType),
                payload
            })
        );
        if (!outcome.ok) {
            throw new Error(`${actionType} refused: ${outcome.reasonCode} — ${outcome.message}`);
        }
        if (outcome.toState) states.push(outcome.toState);
        return outcome;
    };

    const dispatched = await act("DISPATCH_PROVIDER", lane.ownerIdentityId, {
        providerId: lane.providerId
    });
    const attemptId = dispatched.detail["attemptId"] as string;

    await act("RECORD_PROVIDER_ACCEPTANCE", lane.providerIdentityId, { attemptId });
    await act("ASSIGN_PROVIDER", lane.ownerIdentityId, { attemptId });
    await act("REQUEST_CUSTOMER_CONFIRMATION", lane.ownerIdentityId);
    await act("RECORD_CUSTOMER_CONFIRMATION", lane.customerIdentityId);
    await act("START_FULFILLMENT", lane.ownerIdentityId);
    await act("COMPLETE_SERVICE", lane.ownerIdentityId);

    return states;
}

const SUCCESSFUL_PATH = [
    "PROVIDER_DISPATCHED",
    "PROVIDER_ACCEPTED",
    "OWNER_ASSIGNED",
    "AWAITING_CUSTOMER_CONFIRMATION",
    "CUSTOMER_CONFIRMED",
    "FULFILLMENT_ACTIVE",
    "SERVICE_COMPLETED"
];

d("G4-E11 — Freshline Bali Mobile operational reproof", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("28 — the complete mobile lifecycle runs PENDING_ACCEPTANCE to SERVICE_COMPLETED", async () => {
        const w = await seedCommittedMobile(pool);
        const states = await runFullLifecycle(pool, w);
        expect(states).toEqual(SUCCESSFUL_PATH);

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("SERVICE_COMPLETED");
    });

    it("32 — the lifecycle is fully reconstructable from durable records", async () => {
        const w = await seedCommittedMobile(pool);
        await runFullLifecycle(pool, w);

        await withTransaction(pool, async (client) => {
            // Every action, accepted and refused, in order.
            const actions = await actionsForRequest(client, w.requestId);
            expect(actions.map((a) => a.actionType)).toEqual([
                "DISPATCH_PROVIDER",
                "RECORD_PROVIDER_ACCEPTANCE",
                "ASSIGN_PROVIDER",
                "REQUEST_CUSTOMER_CONFIRMATION",
                "RECORD_CUSTOMER_CONFIRMATION",
                "START_FULFILLMENT",
                "COMPLETE_SERVICE"
            ]);
            expect(actions.every((a) => a.outcome === "ACCEPTED")).toBe(true);
            // Replaying the recorded to-states reproduces the canonical path.
            expect(actions.map((a) => a.toState)).toEqual(SUCCESSFUL_PATH);

            // The supporting evidence objects are all present and versioned.
            expect(await attemptsForRequest(client, w.requestId)).toHaveLength(1);
            const assignments = await assignmentsForRequest(client, w.requestId);
            expect(assignments).toHaveLength(1);
            expect(assignments[0]!.assignmentVersion).toBe(1);
            const contexts = await contextsForRequest(client, w.requestId);
            expect(contexts).toHaveLength(1);
            expect(contexts[0]!.status).toBe("CONFIRMED");

            // And the canonical event trail agrees with the action trail.
            const events = await eventsFor(client, "SERVICE_REQUEST", w.requestId);
            const canonical = events
                .map((e) => e.to_state)
                .filter((s) => SUCCESSFUL_PATH.includes(s));
            expect(canonical).toEqual(SUCCESSFUL_PATH);
        });
    });

    it("the three consequential gates are exercised by three different authorities", async () => {
        const w = await seedCommittedMobile(pool);
        await runFullLifecycle(pool, w);

        const { rows } = await pool.query<{ action_type: string; actor_role: string }>(
            `SELECT action_type, actor_role FROM core_operational_action
              WHERE request_id = $1 AND outcome = 'ACCEPTED'
              ORDER BY created_at`,
            [w.requestId]
        );
        const byType = new Map(rows.map((r) => [r.action_type, r.actor_role]));
        expect(byType.get("RECORD_PROVIDER_ACCEPTANCE")).toBe("PROVIDER");
        expect(byType.get("ASSIGN_PROVIDER")).toBe("OWNER");
        expect(byType.get("RECORD_CUSTOMER_CONFIRMATION")).toBe("CUSTOMER");
    });
});

d("G4-E12 — synthetic InStore generalization", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("29 — the InStore path completes through the SAME lifecycle machinery", async () => {
        const w = await seedCommittedInStore(pool);
        const states = await runFullLifecycle(pool, {
            marketId: w.marketId,
            requestId: w.requestId,
            providerId: w.providerAId,
            providerIdentityId: w.providerAIdentityId,
            ownerIdentityId: w.ownerIdentityId,
            customerIdentityId: w.customerIdentityId
        });
        expect(states).toEqual(SUCCESSFUL_PATH);

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("SERVICE_COMPLETED");
        expect(request!.marketId).toBe("saigon");
    });

    it("shared-resource provider loss recovers without erasing the commitment", async () => {
        const w = await seedCommittedInStore(pool);
        // Drive to confirmed, then lose the provider.
        const act = (actionType: string, actor: string | null, payload = {}) =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: actionType as never,
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: actor,
                    idempotencyKey: idem(actionType),
                    payload
                })
            );
        const dispatched = await act("DISPATCH_PROVIDER", w.ownerIdentityId, {
            providerId: w.providerAId
        });
        if (!dispatched.ok) throw new Error("dispatch failed");
        const attemptId = dispatched.detail["attemptId"] as string;
        await act("RECORD_PROVIDER_ACCEPTANCE", w.providerAIdentityId, { attemptId });
        await act("ASSIGN_PROVIDER", w.ownerIdentityId, { attemptId });

        const loss = await act("RECORD_CAPACITY_LOSS", w.ownerIdentityId, {
            providerId: w.providerAId
        });
        expect(loss.ok).toBe(true);
        if (loss.ok) expect(loss.detail["commitmentPreserved"]).toBe(true);

        // Reassign to the other barber; the request keeps its commitment.
        const reassigned = await act("REASSIGN_PROVIDER", w.ownerIdentityId, {
            providerId: w.providerBId
        });
        expect(reassigned.ok).toBe(true);

        const assignments = await withTransaction(pool, (c) =>
            assignmentsForRequest(c, w.requestId)
        );
        expect(assignments).toHaveLength(2);
        expect(assignments[1]!.providerId).toBe(w.providerBId);

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("OWNER_ASSIGNED");
        expect(request!.currentVersion).toBe(1);
    });

    it("no second lifecycle state machine exists for InStore", async () => {
        const w = await seedCommittedInStore(pool);
        await runFullLifecycle(pool, {
            marketId: w.marketId,
            requestId: w.requestId,
            providerId: w.providerAId,
            providerIdentityId: w.providerAIdentityId,
            ownerIdentityId: w.ownerIdentityId,
            customerIdentityId: w.customerIdentityId
        });

        // The commitment lives in the one canonical aggregate, and nowhere else.
        const canonical = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request WHERE request_id = $1`,
            [w.requestId]
        );
        expect(Number(canonical.rows[0]!.n)).toBe(1);
        const legacy = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM appointments WHERE billing_code LIKE 'NB-%'`
        );
        expect(Number(legacy.rows[0]!.n)).toBe(0);
    });
});

d("G4-E13 — Hybrid topology neutrality", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("30 — one tenant/market runs Mobile and InStore through identical contracts", async () => {
        const w = await seedCommittedHybrid(pool);

        const lane = (requestId: string): Lane => ({
            marketId: w.marketId,
            requestId,
            providerId: w.providerId,
            providerIdentityId: w.providerIdentityId ?? "",
            ownerIdentityId: w.ownerIdentityId,
            customerIdentityId: w.customerIdentityId
        });

        // The hybrid fixture's provider identity is needed for acceptance.
        const providerIdentity = await pool.query<{ identity_id: string }>(
            `SELECT identity_id FROM core_provider WHERE provider_id = $1`,
            [w.providerId]
        );
        const providerIdentityId = providerIdentity.rows[0]!.identity_id;

        const mobileStates = await runFullLifecycle(pool, {
            ...lane(w.mobileRequestId),
            providerIdentityId
        });
        const instoreStates = await runFullLifecycle(pool, {
            ...lane(w.instoreRequestId),
            providerIdentityId
        });

        // Same state model, same order, same terminal result.
        expect(mobileStates).toEqual(SUCCESSFUL_PATH);
        expect(instoreStates).toEqual(SUCCESSFUL_PATH);

        // Same action contract for both.
        await withTransaction(pool, async (client) => {
            const mobileActions = await actionsForRequest(client, w.mobileRequestId);
            const instoreActions = await actionsForRequest(client, w.instoreRequestId);
            expect(mobileActions.map((a) => a.actionType)).toEqual(
                instoreActions.map((a) => a.actionType)
            );
        });

        // Two distinct canonical requests, one lifecycle engine.
        const requests = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request WHERE market_id = $1`,
            [w.marketId]
        );
        expect(Number(requests.rows[0]!.n)).toBe(2);
    });
});
