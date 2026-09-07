// SCP-G5-F-CORR-01 (R39) — qualification is a precondition of AUTHORITATIVE
// dispatch truth, not merely of the Owner surface.
//
// IRF proved that the Owner command layer's qualification guard could be walked
// around: calling the G4 orchestrator directly created canonical dispatch truth
// with no qualification, with CLARIFICATION_REQUIRED, and with UNSERVICEABLE.
//
// Every test below attacks an AUTHORITATIVE ingress directly — the orchestrator
// and the G2 dispatch function — bypassing the Owner boundary entirely, because
// an invariant that only holds when the polite path is used is not an invariant.
//
// The negative UNSERVICEABLE case is exercised in a REACHABLE form: the
// judgement is recorded through the orchestrator, which records it and moves
// nothing, so the request stays at PENDING_ACCEPTANCE. Relying on the Owner
// command's cancellation to make dispatch impossible would prove only that a
// terminal state blocks dispatch, which was never in doubt.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { offerDispatch } from "../../src/core/dispatch/dispatchOffer";
import { qualificationsForRequest } from "../../src/lifecycle/qualification";
import type { Actor } from "../../src/core/types";
import {
    SCOPE,
    bootWorld,
    createApprovedProvider,
    createDemand,
    getOwnerPool,
    ownerCall,
    shutdownWorld,
    type OwnerWorld
} from "./ownerTestDb";
import { week } from "../provider/providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G5-F-CORR-01 / R39 — the authoritative dispatch boundary enforces qualification", () => {
    let pool: Pool;
    let world: OwnerWorld;
    let provider: Awaited<ReturnType<typeof createApprovedProvider>>;

    beforeEach(async () => {
        pool = getOwnerPool();
        world = await bootWorld(pool);
        provider = await createApprovedProvider(world);
    });

    afterEach(async () => {
        await shutdownWorld(world);
        await pool?.end();
    });

    /**
     * Records a judgement through the orchestrator, which records and moves
     * nothing — leaving the request reachable whatever the judgement was.
     */
    async function judge(requestId: string, outcome: string) {
        return withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "QUALIFY_REQUEST",
                marketId: "bali",
                requestId,
                actorIdentityId: world.ownerIdentityId,
                idempotencyKey: `judge:${requestId}:${outcome}`,
                payload: {
                    outcome,
                    ...(outcome === "UNSERVICEABLE" ? { reasonCode: "LOCATION_UNAVAILABLE" } : {})
                }
            })
        );
    }

    /** INGRESS 1: the G4 orchestrator, called directly. */
    async function dispatchViaOrchestrator(
        requestId: string,
        options: { providerId?: string; actorIdentityId?: string | null; key?: string } = {}
    ) {
        return withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "DISPATCH_PROVIDER",
                marketId: "bali",
                requestId,
                actorIdentityId:
                    options.actorIdentityId === undefined
                        ? world.ownerIdentityId
                        : options.actorIdentityId,
                idempotencyKey: options.key ?? `orch:${requestId}`,
                payload: { providerId: options.providerId ?? provider.providerId }
            })
        );
    }

    /** INGRESS 2: the G2 dispatch function, called directly. */
    async function dispatchViaCore(requestId: string, providerId = provider.providerId) {
        const actor: Actor = {
            identityId: world.ownerIdentityId,
            role: "OWNER",
            authority: "OWNER_ROLE:bali"
        };
        return withTransaction(pool, (client) =>
            offerDispatch(
                client,
                { requestId, providerId, marketId: "bali" },
                actor,
                `core:${requestId}`
            )
        );
    }

    async function stateOf(requestId: string): Promise<string> {
        const { rows } = await pool.query<{ state: string }>(
            `SELECT state FROM core_service_request WHERE request_id = $1`,
            [requestId]
        );
        return rows[0]!.state;
    }

    async function offerCount(requestId: string): Promise<number> {
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_dispatch_offer WHERE request_id = $1`,
            [requestId]
        );
        return Number(rows[0]!.n);
    }

    it("R39-A — no qualification: both authoritative ingresses refuse, zero offers", async () => {
        const viaOrchestrator = await createDemand(world);
        const outcome = await dispatchViaOrchestrator(viaOrchestrator.requestId);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.reasonCode).toBe("QUALIFICATION_REQUIRED");
        expect(await stateOf(viaOrchestrator.requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await offerCount(viaOrchestrator.requestId)).toBe(0);

        const viaCore = await createDemand(world);
        const coreOutcome = await dispatchViaCore(viaCore.requestId);
        expect(coreOutcome.ok).toBe(false);
        if (coreOutcome.ok) return;
        expect(coreOutcome.code).toBe("QUALIFICATION_REQUIRED");
        expect(await stateOf(viaCore.requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await offerCount(viaCore.requestId)).toBe(0);
    });

    it("R39-B — CLARIFICATION_REQUIRED: both ingresses refuse, judgement untouched", async () => {
        const first = await createDemand(world);
        await judge(first.requestId, "CLARIFICATION_REQUIRED");
        const outcome = await dispatchViaOrchestrator(first.requestId);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reasonCode).toBe("QUALIFICATION_REQUIRED");
        expect(await stateOf(first.requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await offerCount(first.requestId)).toBe(0);

        const second = await createDemand(world);
        await judge(second.requestId, "CLARIFICATION_REQUIRED");
        const coreOutcome = await dispatchViaCore(second.requestId);
        expect(coreOutcome.ok).toBe(false);
        if (!coreOutcome.ok) expect(coreOutcome.code).toBe("QUALIFICATION_REQUIRED");
        expect(await offerCount(second.requestId)).toBe(0);

        // The refusal changed nothing about the judgement it read.
        const judgements = await withTransaction(pool, (client) =>
            qualificationsForRequest(client, first.requestId)
        );
        expect(judgements).toHaveLength(1);
        expect(judgements[0]!.outcome).toBe("CLARIFICATION_REQUIRED");
    });

    it("R39-C — UNSERVICEABLE on a REACHABLE request: both ingresses refuse", async () => {
        const first = await createDemand(world);
        await judge(first.requestId, "UNSERVICEABLE");
        // Not masked by a terminal state: the request is still dispatchable in
        // every respect except the judgement.
        expect(await stateOf(first.requestId)).toBe("PENDING_ACCEPTANCE");

        const outcome = await dispatchViaOrchestrator(first.requestId);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reasonCode).toBe("QUALIFICATION_REQUIRED");
        expect(await offerCount(first.requestId)).toBe(0);

        const second = await createDemand(world);
        await judge(second.requestId, "UNSERVICEABLE");
        expect(await stateOf(second.requestId)).toBe("PENDING_ACCEPTANCE");
        const coreOutcome = await dispatchViaCore(second.requestId);
        expect(coreOutcome.ok).toBe(false);
        if (!coreOutcome.ok) expect(coreOutcome.code).toBe("QUALIFICATION_REQUIRED");
        expect(await offerCount(second.requestId)).toBe(0);
    });

    it("R39-D control — SERVICEABLE dispatches normally through both ingresses", async () => {
        const viaOrchestrator = await createDemand(world);
        await judge(viaOrchestrator.requestId, "SERVICEABLE");
        const outcome = await dispatchViaOrchestrator(viaOrchestrator.requestId);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.toState).toBe("PROVIDER_DISPATCHED");
        expect(await offerCount(viaOrchestrator.requestId)).toBe(1);

        const viaCore = await createDemand(world);
        await judge(viaCore.requestId, "SERVICEABLE");
        const coreOutcome = await dispatchViaCore(viaCore.requestId);
        expect(coreOutcome.ok).toBe(true);
        expect(await stateOf(viaCore.requestId)).toBe("PROVIDER_DISPATCHED");
        expect(await offerCount(viaCore.requestId)).toBe(1);
    });

    it("a later SERVICEABLE judgement supersedes an earlier blocking one", async () => {
        const demand = await createDemand(world);
        await judge(demand.requestId, "CLARIFICATION_REQUIRED");
        expect((await dispatchViaOrchestrator(demand.requestId, { key: "a" })).ok).toBe(false);

        await judge(demand.requestId, "SERVICEABLE");
        const after = await dispatchViaOrchestrator(demand.requestId, { key: "b" });
        expect(after.ok).toBe(true);
        expect(await offerCount(demand.requestId)).toBe(1);
    });

    it("SERVICEABLE does not weaken any other precondition", async () => {
        // R32: the requested service area must still be covered by the same
        // capacity window that supplies the time.
        const elsewhere = await createApprovedProvider(world, {
            displayName: "Covers Canggu only",
            days: week([
                { isoDay: 1, available: true, regions: ["Canggu"] },
                { isoDay: 2, available: true, regions: ["Canggu"] },
                { isoDay: 3, available: true, regions: ["Canggu"] },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ])
        });
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        const wrongArea = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: elsewhere.providerId }
        });
        expect(wrongArea.status).toBe(422);
        expect(wrongArea.body["error"]).toBe("PROVIDER_NOT_ELIGIBLE_MATCH");
        expect(await offerCount(demand.requestId)).toBe(0);

        // An unapproved provider is still refused at the authoritative boundary.
        await pool.query(`UPDATE core_provider SET supply_status = 'SUSPENDED' WHERE provider_id = $1`, [
            provider.providerId
        ]);
        const suspended = await dispatchViaOrchestrator(demand.requestId);
        expect(suspended.ok).toBe(false);
        if (!suspended.ok) expect(suspended.reasonCode).toBe("PROVIDER_NO_LONGER_ELIGIBLE");
        expect(await offerCount(demand.requestId)).toBe(0);
    });

    it("qualification does not replace authority: a non-Owner actor still cannot dispatch", async () => {
        const demand = await createDemand(world);
        await judge(demand.requestId, "SERVICEABLE");

        const asProvider = await dispatchViaOrchestrator(demand.requestId, {
            actorIdentityId: provider.providerIdentityId,
            key: "as-provider"
        });
        expect(asProvider.ok).toBe(false);
        if (!asProvider.ok) expect(asProvider.reasonCode).toBe("AUTHORITY_REFUSED");
        expect(await offerCount(demand.requestId)).toBe(0);

        // And the Owner HTTP boundary still refuses a provider session.
        const viaHttp = await ownerCall(world, "POST", "/api/owner/dispatch", {
            token: provider.token,
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(viaHttp.status).toBe(403);
        expect(await offerCount(demand.requestId)).toBe(0);
    });

    it("dispatch remains idempotent, safe under replay and singular under concurrency", async () => {
        const demand = await createDemand(world);
        await judge(demand.requestId, "SERVICEABLE");

        const first = await dispatchViaOrchestrator(demand.requestId, { key: "replay-key" });
        const replay = await dispatchViaOrchestrator(demand.requestId, { key: "replay-key" });
        expect(first.ok).toBe(true);
        expect(replay.ok).toBe(true);
        if (replay.ok) expect(replay.replayed).toBe(true);
        expect(await offerCount(demand.requestId)).toBe(1);

        const conflicting = await dispatchViaOrchestrator(demand.requestId, {
            key: "replay-key",
            providerId: (await createApprovedProvider(world, { displayName: "Other" })).providerId
        });
        expect(conflicting.ok).toBe(false);
        if (!conflicting.ok) expect(conflicting.reasonCode).toBe("IDEMPOTENCY_CONFLICT");

        // Six concurrent dispatches of a fresh qualified request.
        const racing = await createDemand(world);
        await judge(racing.requestId, "SERVICEABLE");
        const responses = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
                dispatchViaOrchestrator(racing.requestId, { key: `race-${index}` })
            )
        );
        expect(responses.filter((r) => r.ok)).toHaveLength(1);
        expect(await offerCount(racing.requestId)).toBe(1);
        expect(await stateOf(racing.requestId)).toBe("PROVIDER_DISPATCHED");
    });

    it("dispatch still implies no acceptance, assignment, confirmation or fulfillment", async () => {
        const demand = await createDemand(world);
        await judge(demand.requestId, "SERVICEABLE");
        await dispatchViaOrchestrator(demand.requestId);

        expect(await stateOf(demand.requestId)).toBe("PROVIDER_DISPATCHED");
        const { rows } = await pool.query<{
            accepted: string;
            assignments: string;
            confirmations: string;
            fulfillments: string;
        }>(
            `SELECT
               (SELECT count(*) FROM core_dispatch_offer
                 WHERE request_id = $1 AND state = 'ACCEPTED')       AS accepted,
               (SELECT count(*) FROM core_assignment
                 WHERE request_id = $1)                              AS assignments,
               (SELECT count(*) FROM core_customer_confirmation
                 WHERE request_id = $1 AND status = 'CONFIRMED')     AS confirmations,
               (SELECT count(*) FROM core_fulfillment
                 WHERE request_id = $1)                              AS fulfillments`,
            [demand.requestId]
        );
        expect(rows[0]).toEqual({
            accepted: "0",
            assignments: "0",
            confirmations: "0",
            fulfillments: "0"
        });
    });

    it("the Owner command path still behaves correctly on both sides of the judgement", async () => {
        const demand = await createDemand(world);
        const unqualified = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(unqualified.status).toBe(422);
        expect(unqualified.body["error"]).toBe("NOT_QUALIFIED_FOR_MATCHING");

        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "CLARIFICATION_REQUIRED" }
        });
        const clarifying = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(clarifying.body["error"]).toBe("QUALIFICATION_BLOCKS_MATCHING");

        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        const dispatched = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(dispatched.status).toBe(200);
        expect(await stateOf(demand.requestId)).toBe("PROVIDER_DISPATCHED");
    });

    it("a hostile legacy appointment cannot supply the missing qualification", async () => {
        const demand = await createDemand(world);
        const legacyService = await pool.query<{ service_id: string }>(
            `INSERT INTO service_catalogue (name, duration_minutes) VALUES ('Legacy', 60)
             RETURNING service_id`
        );
        const legacyCustomer = await pool.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ('bali', 'Legacy')
             RETURNING identity_id`
        );
        await pool.query(
            `INSERT INTO appointments (billing_code, customer_id, service_id, start_time, end_time, status)
             VALUES ($3, $1, $2, now() + interval '2 days', now() + interval '2 days 1 hour',
                     'CONTRACTOR_ACCEPTED')`,
            [
                legacyCustomer.rows[0]!.identity_id,
                legacyService.rows[0]!.service_id,
                `FL-${String(Date.now() % 1_000_000).padStart(6, "0")}-R390`
            ]
        );

        const outcome = await dispatchViaOrchestrator(demand.requestId);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reasonCode).toBe("QUALIFICATION_REQUIRED");
        expect(await offerCount(demand.requestId)).toBe(0);
        expect(SCOPE.marketId).toBe("bali");
    });
});
