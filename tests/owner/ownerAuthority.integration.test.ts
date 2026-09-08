// G5-F — Owner operational authority, end to end through the real gates.
//
// Every fixture below is built by driving the actual G5-D customer ingress, the
// actual G5-E partner path and the actual G4 orchestrator. Nothing inserts a
// request, an offer, an assignment or a capacity window by hand, because a
// fixture that wrote its own canonical state could pass while the Owner path
// was still wrong.
//
// Time is anchored to a fixed weekday of a future week, so no assertion here
// depends on the wall clock at which the suite happens to run.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { withTransaction } from "../../src/db/pool";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { qualificationsForRequest } from "../../src/lifecycle/qualification";
import { issueSession } from "../../src/provider/session";
import { startOwnerHost } from "../../src/host/ownerHost";
import {
    SCOPE,
    bootWorld,
    createApprovedProvider,
    createDemand,
    getOwnerPool,
    ownerCall,
    recordProviderAcceptance,
    shutdownWorld,
    type OwnerWorld
} from "./ownerTestDb";
import { week } from "../provider/providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function count(pool: Pool, table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params
    );
    return Number(rows[0]!.n);
}

async function stateOf(pool: Pool, requestId: string): Promise<string> {
    const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM core_service_request WHERE request_id = $1`,
        [requestId]
    );
    return rows[0]!.state;
}

d("G5-F / queue, qualification and clarification", () => {
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

    it("the queue derives from canonical requests and owns nothing", async () => {
        const demand = await createDemand(world);
        const response = await ownerCall(world, "GET", "/api/owner/queue");

        expect(response.status).toBe(200);
        const queue = response.body["queue"] as Array<Record<string, unknown>>;
        expect(queue).toHaveLength(1);
        const entry = queue[0] as Record<string, never>;
        expect(entry["requestId"]).toBe(demand.requestId);
        expect(entry["state"]).toBe("PENDING_ACCEPTANCE");
        expect(entry["stage"]).toBe("AWAITING_QUALIFICATION");
        expect(entry["priceMinorUnits"]).toBe(350_000);
        // Customer context comes from the G5-D ingress envelope, not a copy.
        expect((entry["customer"] as Record<string, unknown>)["serviceRegion"]).toBe("Seminyak");
        expect((entry["customer"] as Record<string, unknown>)["sourceChannel"]).toBe(
            "WEB_CUSTOMER_SURFACE"
        );

        // No operational table was written merely by looking.
        expect(await count(pool, "core_operational_action")).toBe(0);
        expect(await count(pool, "core_request_qualification")).toBe(0);
    });

    it("a serviceable judgement records a decision and moves nothing", async () => {
        const demand = await createDemand(world);
        const response = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });

        expect(response.status).toBe(200);
        const actions = response.body["actions"] as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0]!["actionType"]).toBe("QUALIFY_REQUEST");
        // Null toState: a judgement, not a transition.
        expect(actions[0]!["toState"]).toBeNull();
        expect((actions[0]!["detail"] as Record<string, unknown>)["matched"]).toBe(false);

        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
        expect((response.body["request"] as Record<string, unknown>)["stage"]).toBe(
            "READY_FOR_MATCHING"
        );
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("clarification keeps the request exactly where it was", async () => {
        const demand = await createDemand(world);
        const response = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: {
                requestId: demand.requestId,
                outcome: "CLARIFICATION_REQUIRED",
                note: "Which villa?"
            }
        });

        expect(response.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
        expect((response.body["request"] as Record<string, unknown>)["stage"]).toBe(
            "CLARIFICATION_REQUIRED"
        );

        // And it does not open the door to matching.
        const provider = await createApprovedProvider(world);
        const dispatch = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(dispatch.status).toBe(422);
        expect(dispatch.body["error"]).toBe("QUALIFICATION_BLOCKS_MATCHING");
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
    });

    it("an unserviceable judgement is recorded AND performs the governed cancellation", async () => {
        const demand = await createDemand(world);
        const response = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: {
                requestId: demand.requestId,
                outcome: "UNSERVICEABLE",
                reasonCode: "LOCATION_UNAVAILABLE"
            }
        });

        expect(response.status).toBe(200);
        const actions = response.body["actions"] as Array<Record<string, unknown>>;
        // Two acts: the judgement, and the cancellation that acts on it.
        expect(actions.map((a) => a["actionType"])).toEqual(["QUALIFY_REQUEST", "CANCEL_SERVICE"]);
        expect(actions[1]!["toState"]).toBe("CANCELLED");
        expect(await stateOf(pool, demand.requestId)).toBe("CANCELLED");

        const judgements = await withTransaction(pool, (client) =>
            qualificationsForRequest(client, demand.requestId)
        );
        expect(judgements).toHaveLength(1);
        expect(judgements[0]!.outcome).toBe("UNSERVICEABLE");
        expect(judgements[0]!.reasonCode).toBe("LOCATION_UNAVAILABLE");
        expect(judgements[0]!.observedState).toBe("PENDING_ACCEPTANCE");
        expect(judgements[0]!.decidedByIdentityId).toBe(world.ownerIdentityId);
    });

    it("refuses an unserviceable judgement that states no reason", async () => {
        const demand = await createDemand(world);
        const response = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "UNSERVICEABLE" }
        });
        expect(response.status).toBe(422);
        expect(response.body["canonicalReason"]).toBe("CORRELATION_REQUIRED");
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
    });

    it("qualification is predecessor-valid and append-only", async () => {
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "CLARIFICATION_REQUIRED" }
        });
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });

        const judgements = await withTransaction(pool, (client) =>
            qualificationsForRequest(client, demand.requestId)
        );
        expect(judgements.map((j) => [j.sequence, j.outcome])).toEqual([
            [1, "CLARIFICATION_REQUIRED"],
            [2, "SERVICEABLE"]
        ]);
        await expect(
            pool.query(`UPDATE core_request_qualification SET outcome = 'UNSERVICEABLE'`)
        ).rejects.toThrow(/append-only/);

        // A cancelled request cannot be judged: the judgement would be about
        // something already concluded.
        await ownerCall(world, "POST", "/api/owner/cancel", {
            body: { requestId: demand.requestId, reasonCode: "OWNER_CANCELLED" }
        });
        const late = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        expect(late.status).toBe(422);
        expect(late.body["canonicalReason"]).toBe("INVALID_PREDECESSOR_STATE");
    });
});

d("G5-F / supply, strict matching and no-match recovery", () => {
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

    async function qualified(): Promise<string> {
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        return demand.requestId;
    }

    it("only current approved supply is visible, and refresh manufactures none", async () => {
        const requestId = await qualified();

        const empty = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/supply`);
        expect(empty.status).toBe(200);
        expect((empty.body["supply"] as Record<string, unknown>)["approvedCount"]).toBe(0);
        expect((empty.body["supply"] as Record<string, unknown>)["coveringCount"]).toBe(0);

        const provider = await createApprovedProvider(world);
        const populated = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/supply`);
        const supply = populated.body["supply"] as Record<string, unknown>;
        expect(supply["approvedCount"]).toBe(1);
        expect(supply["coveringCount"]).toBe(1);
        expect((supply["approved"] as Array<Record<string, unknown>>)[0]!["providerId"]).toBe(
            provider.providerId
        );
    });

    it("a submitted-but-unconfirmed week is not eligible supply", async () => {
        const requestId = await qualified();
        const provider = await createApprovedProvider(world);

        // The partner edits, which supersedes the confirmed week.
        await fetch(`${world.partnerHost.origin}/api/partner/availability`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-partner-session": provider.token },
            body: JSON.stringify({
                weekStartDate: world.monday,
                days: week([{ isoDay: 6, available: true }])
            })
        });

        const supply = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/supply`);
        expect((supply.body["supply"] as Record<string, unknown>)["approvedCount"]).toBe(0);

        const match = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/match`);
        expect(match.body["outcome"]).not.toBe("SELLABLE");
        expect(match.body["match"]).toBeNull();
    });

    it("strict matching consumes G3 and names the eligible provider", async () => {
        const requestId = await qualified();
        const provider = await createApprovedProvider(world);

        const match = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/match`);
        expect(match.status).toBe(200);
        expect(match.body["outcome"]).toBe("SELLABLE");
        const terms = match.body["match"] as Record<string, unknown>;
        expect(terms["providerId"]).toBe(provider.providerId);
        expect(terms["serviceAreaKey"]).toBe("Seminyak");
        expect(terms["priceMinorUnits"]).toBe(350_000);
    });

    it("R32 preserved — a provider working elsewhere that day is not a match", async () => {
        // The customer wants Seminyak on Wednesday; the partner covers Seminyak
        // only on Monday and Canggu only on Tuesday.
        const requestId = await qualified();
        const provider = await createApprovedProvider(world, {
            days: week([
                { isoDay: 1, available: true, regions: ["Seminyak"] },
                { isoDay: 2, available: true, regions: ["Canggu"] },
                { isoDay: 3, available: true, regions: ["Canggu"] },
                { isoDay: 4, available: false },
                { isoDay: 5, available: false }
            ])
        });

        const match = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/match`);
        expect(match.body["outcome"]).not.toBe("SELLABLE");
        expect(match.body["reasonCode"]).toBe("PROVIDER_UNAVAILABLE");

        // The Owner cannot offer to them anyway.
        const dispatch = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId, providerId: provider.providerId }
        });
        expect(dispatch.status).toBe(422);
        expect(dispatch.body["error"]).toBe("PROVIDER_NOT_ELIGIBLE_MATCH");
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
    });

    it("no-match does not assign, and the governed recovery is a cancellation", async () => {
        const requestId = await qualified();

        const match = await ownerCall(world, "GET", `/api/owner/requests/${requestId}/match`);
        expect(match.body["outcome"]).not.toBe("SELLABLE");
        expect(await count(pool, "core_assignment")).toBe(0);
        expect(await count(pool, "core_dispatch_offer")).toBe(0);

        const cancelled = await ownerCall(world, "POST", "/api/owner/cancel", {
            body: { requestId, reasonCode: "LOCATION_UNAVAILABLE", note: "No cover in that area." }
        });
        expect(cancelled.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("CANCELLED");
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("an unqualified request cannot be offered to anyone", async () => {
        const demand = await createDemand(world);
        const provider = await createApprovedProvider(world);
        const dispatch = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(dispatch.status).toBe(422);
        expect(dispatch.body["error"]).toBe("NOT_QUALIFIED_FOR_MATCHING");
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
    });
});

d("G5-F / offer, acceptance, assignment and confirmation separation", () => {
    let pool: Pool;
    let world: OwnerWorld;
    let requestId: string;
    let provider: Awaited<ReturnType<typeof createApprovedProvider>>;

    beforeEach(async () => {
        pool = getOwnerPool();
        world = await bootWorld(pool);
        provider = await createApprovedProvider(world);
        const demand = await createDemand(world);
        requestId = demand.requestId;
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId, outcome: "SERVICEABLE" }
        });
    });

    afterEach(async () => {
        await shutdownWorld(world);
        await pool?.end();
    });

    async function dispatch() {
        return ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId, providerId: provider.providerId }
        });
    }
    async function assign() {
        return ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId, providerId: provider.providerId }
        });
    }

    it("an offer is not acceptance and not assignment", async () => {
        const offered = await dispatch();
        expect(offered.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("PROVIDER_DISPATCHED");
        expect(await count(pool, "core_dispatch_offer", "state = 'OFFERED'")).toBe(1);
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(0);
        expect(await count(pool, "core_assignment")).toBe(0);

        const early = await assign();
        expect(early.status).toBe(422);
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("acceptance is not assignment, and the Owner cannot manufacture it", async () => {
        await dispatch();

        // There is no Owner route through which acceptance could be recorded.
        for (const path of [
            "/api/owner/accept",
            "/api/owner/record-acceptance",
            "/api/owner/provider-accept"
        ]) {
            expect((await ownerCall(world, "POST", path, { body: { requestId } })).status).toBe(404);
        }

        const accepted = await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );
        expect(accepted.ok).toBe(true);
        expect(await stateOf(pool, requestId)).toBe("PROVIDER_ACCEPTED");
        // Acceptance moved the request; it did not assign anybody.
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("explicit Owner assignment requires acceptance and an eligible provider", async () => {
        await dispatch();
        await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );

        // Naming somebody else is refused before Core is even asked.
        const other = await createApprovedProvider(world, { displayName: "Someone Else" });
        const wrong = await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId, providerId: other.providerId }
        });
        expect(wrong.status).toBe(422);
        expect(wrong.body["error"]).toBe("PROVIDER_NOT_ELIGIBLE_MATCH");
        expect(await count(pool, "core_assignment")).toBe(0);

        const assigned = await assign();
        expect(assigned.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("OWNER_ASSIGNED");
        expect(await count(pool, "core_assignment", "status = 'ACTIVE'")).toBe(1);

        const { rows } = await pool.query<{ assigned_by_identity_id: string }>(
            `SELECT assigned_by_identity_id FROM core_assignment WHERE request_id = $1`,
            [requestId]
        );
        expect(rows[0]!.assigned_by_identity_id).toBe(world.ownerIdentityId);
    });

    it("assignment does not customer-confirm, and confirmation does not fulfill", async () => {
        await dispatch();
        await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );
        await assign();

        // Assigned, but nobody has confirmed anything.
        expect(await stateOf(pool, requestId)).toBe("OWNER_ASSIGNED");
        expect(await count(pool, "core_customer_confirmation", "status = 'CONFIRMED'")).toBe(0);

        const asked = await ownerCall(world, "POST", "/api/owner/request-confirmation", {
            body: { requestId }
        });
        expect(asked.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("AWAITING_CUSTOMER_CONFIRMATION");
        // Asking is not answering.
        expect(await count(pool, "core_customer_confirmation", "status = 'CONFIRMED'")).toBe(0);

        // Fulfillment cannot start from here.
        const early = await ownerCall(world, "POST", "/api/owner/start-fulfillment", {
            body: { requestId }
        });
        expect(early.status).toBe(422);
        expect(early.body["canonicalReason"]).toBe("INVALID_PREDECESSOR_STATE");
        expect(await count(pool, "core_fulfillment")).toBe(0);

        // The customer answers, under their own authority.
        const customerIdentity = await pool.query<{ customer_identity_id: string }>(
            `SELECT customer_identity_id FROM core_service_request WHERE request_id = $1`,
            [requestId]
        );
        const confirmed = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CUSTOMER_CONFIRMATION",
                marketId: "bali",
                requestId,
                actorIdentityId: customerIdentity.rows[0]!.customer_identity_id,
                idempotencyKey: `confirm:${requestId}`
            })
        );
        expect(confirmed.ok).toBe(true);
        expect(await stateOf(pool, requestId)).toBe("CUSTOMER_CONFIRMED");
        // Confirming is still not fulfilling.
        expect(await count(pool, "core_fulfillment")).toBe(0);

        const started = await ownerCall(world, "POST", "/api/owner/start-fulfillment", {
            body: { requestId }
        });
        expect(started.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("FULFILLMENT_ACTIVE");
        // Starting is not completing.
        expect(await count(pool, "core_fulfillment", "result = 'SERVICE_COMPLETED'")).toBe(0);

        const completed = await ownerCall(world, "POST", "/api/owner/complete-service", {
            body: { requestId }
        });
        expect(completed.status).toBe(200);
        expect(await stateOf(pool, requestId)).toBe("SERVICE_COMPLETED");
    });

    it("no Owner action ever touches the legacy appointments surface", async () => {
        const before = await count(pool, "appointments");
        await dispatch();
        await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );
        await assign();
        expect(await count(pool, "appointments")).toBe(before);

        // And a hostile legacy row changes nothing about canonical truth.
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
                `FL-${String(Date.now() % 1_000_000).padStart(6, "0")}-G5F0`
            ]
        );
        expect(await stateOf(pool, requestId)).toBe("OWNER_ASSIGNED");
        const queue = await ownerCall(world, "GET", "/api/owner/queue");
        expect((queue.body["queue"] as unknown[]).length).toBe(1);
    });
});

d("G5-F / authority, isolation, idempotency and concurrency", () => {
    let pool: Pool;
    let world: OwnerWorld;
    let requestId: string;

    beforeEach(async () => {
        pool = getOwnerPool();
        world = await bootWorld(pool);
        const demand = await createDemand(world);
        requestId = demand.requestId;
    });

    afterEach(async () => {
        await shutdownWorld(world);
        await pool?.end();
    });

    it("refuses an absent, invalid or non-Owner session on every binding route", async () => {
        const provider = await createApprovedProvider(world);
        const paths = [
            "/api/owner/qualify",
            "/api/owner/dispatch",
            "/api/owner/assign",
            "/api/owner/request-confirmation",
            "/api/owner/cancel",
            "/api/owner/start-fulfillment",
            "/api/owner/complete-service"
        ];
        for (const path of paths) {
            expect((await ownerCall(world, "POST", path, { body: {}, token: "" })).status, path).toBe(
                401
            );
            expect(
                (await ownerCall(world, "POST", path, { body: {}, token: "not-a-token" })).status,
                path
            ).toBe(401);
            // A real PROVIDER session is a real session — and still has no
            // Owner authority.
            const attempt = await ownerCall(world, "POST", path, {
                body: {},
                token: provider.token
            });
            expect(attempt.status, path).toBe(403);
            expect(attempt.body["error"], path).toBe("OWNER_AUTHORITY_REQUIRED");
        }
        expect((await ownerCall(world, "GET", "/api/owner/queue", { token: provider.token })).status).toBe(
            403
        );
        expect(await count(pool, "core_operational_action")).toBe(0);
    });

    it("a forged role header grants nothing", async () => {
        const provider = await createApprovedProvider(world);
        for (const headers of [
            { "x-scp-role": "OWNER" },
            { "x-owner-role": "OWNER" },
            { "x-role": "OWNER" }
        ]) {
            const attempt = await ownerCall(world, "POST", "/api/owner/qualify", {
                token: provider.token,
                headers,
                body: { requestId, outcome: "SERVICEABLE" }
            });
            expect(attempt.status).toBe(403);
        }
        expect(await count(pool, "core_request_qualification")).toBe(0);
    });

    it("a session for another tenant, market or environment has no authority here", async () => {
        for (const change of [
            "tenant_id = 'another-tenant'",
            "market_id = 'bangkok'",
            "environment = 'production'"
        ]) {
            await pool.query(`UPDATE core_provider_session SET ${change} WHERE session_role = 'OWNER'`);
            const attempt = await ownerCall(world, "POST", "/api/owner/qualify", {
                body: { requestId, outcome: "SERVICEABLE" }
            });
            expect(attempt.status, change).toBe(403);
            expect(attempt.body["error"], change).toBe("SESSION_SCOPE_MISMATCH");
            await pool.query(
                `UPDATE core_provider_session
                    SET tenant_id = $1, market_id = $2, environment = $3
                  WHERE session_role = 'OWNER'`,
                [SCOPE.tenantId, SCOPE.marketId, SCOPE.environment]
            );
        }
    });

    it("an Owner of another market cannot act here, and identifiers cannot redirect scope", async () => {
        // A genuine OWNER, but of a different market.
        const foreign = await withTransaction(pool, async (client) => {
            const { rows } = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ('bangkok', 'BKK Owner')
                 RETURNING identity_id`
            );
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role)
                 VALUES ($1, 'bangkok', 'OWNER')`,
                [rows[0]!.identity_id]
            );
            return issueSession(client, {
                identityId: rows[0]!.identity_id,
                role: "OWNER",
                lineage: SCOPE
            });
        });
        const attempt = await ownerCall(world, "POST", "/api/owner/qualify", {
            token: foreign.token,
            body: { requestId, outcome: "SERVICEABLE" }
        });
        // The session is scoped to this runtime, so it reaches Core — which
        // refuses because the identity holds no OWNER role in THIS market.
        expect(attempt.status).toBe(422);
        expect(attempt.body["canonicalReason"]).toBe("AUTHORITY_REFUSED");
        expect(await count(pool, "core_request_qualification")).toBe(0);

        // An unknown request identifier is indistinguishable from one out of scope.
        const unknown = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: "00000000-0000-0000-0000-000000000001", outcome: "SERVICEABLE" }
        });
        expect(unknown.status).toBe(404);
        expect(unknown.body["error"]).toBe("REQUEST_UNKNOWN");
    });

    it("refuses every field that could redirect authority or assert state", async () => {
        for (const field of [
            "state",
            "toState",
            "actorIdentityId",
            "tenantId",
            "marketId",
            "environment",
            "role",
            "confirmed",
            "supplyStatus"
        ]) {
            const attempt = await ownerCall(world, "POST", "/api/owner/qualify", {
                body: { requestId, outcome: "SERVICEABLE", [field]: "anything" }
            });
            expect(attempt.status, field).toBe(422);
            expect(attempt.body["error"], field).toBe("UNDECLARED_FIELD");
        }
        expect(await count(pool, "core_request_qualification")).toBe(0);
    });

    it("an identical replay is safe and a conflicting replay is refused", async () => {
        const body = { requestId, outcome: "SERVICEABLE", idempotencyKey: "owner-replay-0001" };
        const first = await ownerCall(world, "POST", "/api/owner/qualify", { body });
        const second = await ownerCall(world, "POST", "/api/owner/qualify", { body });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect((second.body["actions"] as Array<Record<string, unknown>>)[0]!["replayed"]).toBe(true);
        // One judgement, not two.
        expect(await count(pool, "core_request_qualification")).toBe(1);

        const conflicting = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: {
                requestId,
                outcome: "CLARIFICATION_REQUIRED",
                idempotencyKey: "owner-replay-0001"
            }
        });
        expect(conflicting.status).toBe(422);
        expect(conflicting.body["canonicalReason"]).toBe("IDEMPOTENCY_CONFLICT");
        expect(await count(pool, "core_request_qualification")).toBe(1);
    });

    it("concurrent singular mutations resolve to exactly one canonical result", async () => {
        const provider = await createApprovedProvider(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId, outcome: "SERVICEABLE" }
        });

        // Six simultaneous offers of the same work.
        const responses = await Promise.all(
            Array.from({ length: 6 }, () =>
                ownerCall(world, "POST", "/api/owner/dispatch", {
                    body: { requestId, providerId: provider.providerId }
                })
            )
        );
        for (const response of responses) {
            expect([200, 422]).toContain(response.status);
        }
        expect(await stateOf(pool, requestId)).toBe("PROVIDER_DISPATCHED");
        expect(await count(pool, "core_dispatch_offer", "state = 'OFFERED'")).toBe(1);

        await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );

        // Six simultaneous assignments.
        const assignments = await Promise.all(
            Array.from({ length: 6 }, () =>
                ownerCall(world, "POST", "/api/owner/assign", {
                    body: { requestId, providerId: provider.providerId }
                })
            )
        );
        for (const response of assignments) {
            expect([200, 422]).toContain(response.status);
        }
        expect(await stateOf(pool, requestId)).toBe("OWNER_ASSIGNED");
        expect(await count(pool, "core_assignment", "status = 'ACTIVE'")).toBe(1);
    });

    it("a stale assignment attempt after the schedule collapses is refused", async () => {
        const provider = await createApprovedProvider(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId, outcome: "SERVICEABLE" }
        });
        await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId, providerId: provider.providerId }
        });
        await recordProviderAcceptance(
            world,
            requestId,
            provider.providerIdentityId,
            provider.providerId
        );

        // The provider's approval is withdrawn between projection and action.
        await pool.query(`UPDATE core_provider SET supply_status = 'SUSPENDED' WHERE provider_id = $1`, [
            provider.providerId
        ]);
        const attempt = await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId, providerId: provider.providerId }
        });
        expect(attempt.status).toBe(422);
        expect(attempt.body["canonicalReason"]).toBe("PROVIDER_NO_LONGER_ELIGIBLE");
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("every Owner action is recorded as governed evidence and canonical audit", async () => {
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId, outcome: "SERVICEABLE" }
        });
        const { rows } = await pool.query<{ kind: string; outcome: string }>(
            `SELECT kind::text AS kind, outcome FROM core_runtime_evidence
              WHERE kind::text LIKE 'OWNER_%'
              ORDER BY evidence_id`
        );
        const kinds = rows.map((r) => r.kind);
        expect(kinds).toContain("OWNER_SESSION_ISSUED");
        expect(kinds).toContain("OWNER_QUALIFICATION_RECORDED");
        expect(kinds).toContain("OWNER_COMMAND_ACCEPTED");

        const actions = await pool.query<{ action_type: string; actor_role: string; outcome: string }>(
            `SELECT action_type, actor_role, outcome FROM core_operational_action`
        );
        expect(actions.rows).toHaveLength(1);
        expect(actions.rows[0]).toMatchObject({
            action_type: "QUALIFY_REQUEST",
            actor_role: "OWNER",
            outcome: "ACCEPTED"
        });
    });
});

d("G5-F / restart durability and browser non-authority", () => {
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

    it("canonical operational truth survives a host restart", async () => {
        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        await recordProviderAcceptance(
            world,
            demand.requestId,
            provider.providerIdentityId,
            provider.providerId
        );
        await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        const before = await ownerCall(world, "GET", `/api/owner/requests/${demand.requestId}`);

        // Tear the Owner host down and bring a fresh one up on the same database.
        await world.ownerHost.close();
        const restarted = await startOwnerHost({
            pool,
            identity: {
                tenantId: SCOPE.tenantId,
                marketId: SCOPE.marketId,
                environment: SCOPE.environment
            }
        });
        expect(restarted.ok).toBe(true);
        if (!restarted.ok) return;
        world.ownerHost = restarted.host;

        const after = await ownerCall(world, "GET", `/api/owner/requests/${demand.requestId}`);
        expect(after.body["request"]).toEqual(before.body["request"]);
        expect((after.body["request"] as Record<string, unknown>)["state"]).toBe("OWNER_ASSIGNED");
        expect((after.body["request"] as Record<string, unknown>)["stage"]).toBe(
            "ASSIGNED_AWAITING_CONFIRMATION_REQUEST"
        );
        // The session outlives the process because it lives in the database.
        expect(after.status).toBe(200);
    });

    it("the console holds nothing, and a manipulated client cannot manufacture truth", async () => {
        const demand = await createDemand(world);
        const page = await (await fetch(`${world.ownerHost.origin}/`)).text();
        for (const api of ["localStorage", "sessionStorage", "document.cookie"]) {
            expect(page).not.toContain(api);
        }
        const response = await fetch(`${world.ownerHost.origin}/`);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");

        // A client asserting a state simply has the field refused.
        const forged = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE", state: "OWNER_ASSIGNED" }
        });
        expect(forged.status).toBe(422);
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
    });

    it("the Owner host will not start without a resolvable governed runtime", async () => {
        await pool.query(
            `UPDATE core_tenant_configuration SET state = 'SUPERSEDED' WHERE state = 'ACTIVE'`
        );
        const outcome = await startOwnerHost({
            pool,
            identity: {
                tenantId: SCOPE.tenantId,
                marketId: SCOPE.marketId,
                environment: SCOPE.environment
            }
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NO_ACTIVE_CONFIGURATION");
    });
});
