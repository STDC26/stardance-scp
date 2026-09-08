// SCP-G5-H — the integrated Freshline journey.
//
// G4 proved machinery. G5-B..G5-G proved Freshline runs on machinery. This
// proves the machinery composes into the actual service-commerce journey:
//
//   CUSTOMER REQUEST -> OWNER QUALIFICATION -> READY FOR MATCHING
//   -> SUPPLY SYNCHRONISATION -> STRICT ELIGIBLE MATCH -> WHATSAPP OFFER
//   -> PROVIDER ACCEPTANCE -> EXPLICIT OWNER ASSIGNMENT
//   -> CUSTOMER CONFIRMATION -> FULFILLMENT -> COMPLETION
//
// Every step is driven through a real Freshline-facing surface — the customer
// host, the partner host, the Owner host, the WhatsApp webhook — and never by
// writing the state it is supposed to be proving. A fixture that reached into
// the database to set PROVIDER_ACCEPTED would prove nothing about whether a
// provider can actually accept.
//
// No live messaging, no production credentials, no live customer or partner is
// contacted: the channel transport is the in-memory recording adapter and the
// webhook secret is synthetic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
    SCOPE,
    bootChannelWorld,
    channelOps,
    createApprovedProvider,
    createDemand,
    eventId,
    getChannelPool,
    ownerCall,
    shutdownChannelWorld,
    stateOf,
    webhook,
    type ChannelWorld
} from "../channel/channelTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** One row of the canonical trace G5-H §11 requires. */
interface TraceRow {
    step: string;
    objectId: string;
    fromState: string | null;
    toState: string;
    actionType: string | null;
    actorId: string | null;
    occurredAt: string;
    idempotencyKey: string | null;
}

/**
 * Reconstructs the authoritative lifecycle from persisted truth alone.
 *
 * Deliberately reads only `core_event` and `core_operational_action` — no UI
 * state, no channel row, no in-memory handle. If the journey cannot be
 * rebuilt from these, SCP is not the system of record.
 */
async function canonicalTrace(pool: Pool, requestId: string): Promise<TraceRow[]> {
    const { rows } = await pool.query<{
        object_id: string;
        from_state: string | null;
        to_state: string;
        action_type: string | null;
        actor_id: string | null;
        occurred_at: Date;
        idempotency_key: string | null;
    }>(
        // An action and the transition it caused are one fact, linked by the
        // governed idempotency key: the orchestrator stamps the action with
        // `<scope>:<key>` and the resulting event with `<scope>:<key>:request`.
        `SELECT e.object_id, e.from_state, e.to_state,
                a.action_type,
                COALESCE(a.actor_identity_id::text, e.actor_identity_id::text) AS actor_id,
                e.occurred_at, e.idempotency_key
           FROM core_event e
           LEFT JOIN core_operational_action a
             ON a.request_id = e.object_id
            AND e.idempotency_key = a.idempotency_key || ':request'
            AND a.outcome = 'ACCEPTED'
          WHERE e.object_type = 'SERVICE_REQUEST' AND e.object_id = $1
          ORDER BY e.event_id ASC`,
        [requestId]
    );
    return rows.map((r, i) => ({
        step: String(i + 1),
        objectId: r.object_id,
        fromState: r.from_state,
        toState: r.to_state,
        actionType: r.action_type,
        actorId: r.actor_id,
        occurredAt: r.occurred_at.toISOString(),
        idempotencyKey: r.idempotency_key
    }));
}

d("SCP-G5-H / the complete Freshline service-commerce journey", () => {
    let pool: Pool;
    let world: ChannelWorld;

    beforeEach(async () => {
        pool = getChannelPool();
        world = await bootChannelWorld(pool);
    });
    afterEach(async () => {
        await shutdownChannelWorld(world);
        await pool?.end();
    });

    it("H-J01 — customer to completion, every step through a governed surface", async () => {
        // --- SUPPLY SYNCHRONISATION: the partner exists because the partner
        //     journey ran, not because a row was inserted.
        const provider = await createApprovedProvider(world);

        // --- CUSTOMER REQUEST RECEIVED (customer host, HTTP)
        const demand = await createDemand(world);
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");

        // --- OWNER QUALIFICATION -> READY FOR MATCHING (Owner host)
        const qualified = await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        expect(qualified.status).toBe(200);

        // --- STRICT ELIGIBLE MATCH -> dispatch offer (Owner host)
        const dispatched = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(dispatched.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("PROVIDER_DISPATCHED");

        // --- WHATSAPP OFFER RECORDED (operations plane, Owner session)
        const offer = await pool.query<{ offer_id: string }>(
            `SELECT offer_id FROM core_dispatch_offer WHERE request_id = $1 AND state = 'OFFERED'`,
            [demand.requestId]
        );
        const sent = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
            body: { offerId: offer.rows[0]!.offer_id }
        });
        expect(sent.status).toBe(200);
        const offerMessage = sent.body["message"] as Record<string, string>;

        // --- PROVIDER ACCEPTANCE RECORDED (inbound WhatsApp webhook)
        const handle = await pool.query<{ channel_handle: string }>(
            `SELECT i.channel_handle FROM core_provider p
               JOIN core_identity i ON i.identity_id = p.identity_id
              WHERE p.provider_id = $1`,
            [provider.providerId]
        );
        const accepted = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: handle.rows[0]!.channel_handle,
            text: "ACCEPT",
            correlationToken: offerMessage["correlationToken"]
        });
        expect(accepted.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("PROVIDER_ACCEPTED");

        // Provider acceptance is NOT owner assignment.
        expect(await stateOf(pool, demand.requestId)).not.toBe("OWNER_ASSIGNED");

        // --- EXPLICIT OWNER ASSIGNMENT (Owner host)
        const assigned = await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(assigned.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("OWNER_ASSIGNED");

        // --- CUSTOMER BOOKING CONFIRMATION (Owner requests, customer answers
        //     over the channel — two distinct governed steps)
        const askedFor = await ownerCall(world, "POST", "/api/owner/request-confirmation", {
            body: { requestId: demand.requestId }
        });
        expect(askedFor.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("AWAITING_CUSTOMER_CONFIRMATION");

        const confirmationMessage = await channelOps(
            world,
            "POST",
            "/api/operations/channel/customer-confirmation",
            { body: { requestId: demand.requestId } }
        );
        expect(confirmationMessage.status).toBe(200);
        const confirmMsg = confirmationMessage.body["message"] as Record<string, string>;

        const customer = await pool.query<{ channel_handle: string }>(
            `SELECT i.channel_handle FROM core_service_request r
               JOIN core_identity i ON i.identity_id = r.customer_identity_id
              WHERE r.request_id = $1`,
            [demand.requestId]
        );
        const confirmed = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: customer.rows[0]!.channel_handle,
            text: "YES",
            correlationToken: confirmMsg["correlationToken"]
        });
        expect(confirmed.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("CUSTOMER_CONFIRMED");

        // --- SERVICE FULFILLMENT (Owner host)
        const started = await ownerCall(world, "POST", "/api/owner/start-fulfillment", {
            body: { requestId: demand.requestId }
        });
        expect(started.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("FULFILLMENT_ACTIVE");

        // --- SERVICE COMPLETION / RESULT (Owner host)
        const completed = await ownerCall(world, "POST", "/api/owner/complete-service", {
            body: { requestId: demand.requestId }
        });
        expect(completed.status).toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("SERVICE_COMPLETED");

        // --- CANONICAL TRACE, rebuilt from persisted truth alone
        const trace = await canonicalTrace(pool, demand.requestId);
        // eslint-disable-next-line no-console
        console.log("G5H_TRACE " + JSON.stringify(trace, null, 2));

        // The journey is the sequence of governed transitions, in order, each
        // predecessor-valid: every step's `from` is the previous step's `to`.
        expect(trace.map((t) => t.toState)).toEqual([
            "PENDING_ACCEPTANCE",
            "PROVIDER_DISPATCHED",
            "PROVIDER_ACCEPTED",
            "OWNER_ASSIGNED",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CUSTOMER_CONFIRMED",
            "FULFILLMENT_ACTIVE",
            "SERVICE_COMPLETED"
        ]);
        expect(trace[0]!.fromState).toBeNull();
        for (let i = 1; i < trace.length; i += 1) {
            expect(trace[i]!.fromState, `step ${i + 1} predecessor`).toBe(trace[i - 1]!.toState);
        }
        // QUALIFY_REQUEST is deliberately a decision that moves nothing, so it
        // produces no state transition. It must still be persisted, accepted
        // and actor-attributed — the Owner's judgement is auditable even though
        // it is not a lifecycle move.
        const qualification = await pool.query<{ n: string; actor: string | null }>(
            `SELECT count(*) AS n, max(actor_identity_id::text) AS actor
               FROM core_operational_action
              WHERE request_id = $1 AND action_type = 'QUALIFY_REQUEST' AND outcome = 'ACCEPTED'`,
            [demand.requestId]
        );
        expect(Number(qualification.rows[0]!.n)).toBe(1);
        expect(qualification.rows[0]!.actor).toBeTruthy();

        // Every consequential transition is actor-attributed and timestamped.
        for (const row of trace.slice(1)) {
            expect(row.actionType, `step ${row.step} action`).toBeTruthy();
            expect(row.actorId, `step ${row.step} actor`).toBeTruthy();
            expect(Number.isNaN(Date.parse(row.occurredAt))).toBe(false);
        }
        // Timestamps are monotonic.
        for (let i = 1; i < trace.length; i += 1) {
            expect(Date.parse(trace[i]!.occurredAt)).toBeGreaterThanOrEqual(
                Date.parse(trace[i - 1]!.occurredAt)
            );
        }
    }, 120_000);

    it("H-J02 — the journey survives a client/process restart mid-flight", async () => {
        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        const before = await canonicalTrace(pool, demand.requestId);

        // Terminate every Freshline-facing surface. Nothing in memory survives.
        await world.channelHost.close();
        await world.ownerHost.close();
        await world.partnerHost.close();
        await world.customerHost.close();

        // A fresh session reconstructs the journey from SCP-held truth alone.
        const after = await canonicalTrace(pool, demand.requestId);
        expect(after).toEqual(before);
        expect(await stateOf(pool, demand.requestId)).toBe("PROVIDER_DISPATCHED");

        // And the offer is still resolvable, so the journey can continue.
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_dispatch_offer
              WHERE request_id = $1 AND state = 'OFFERED'`,
            [demand.requestId]
        );
        expect(Number(rows[0]!.n)).toBe(1);
    }, 120_000);

    it("H-J03 — adversarial: no step of the journey can be skipped", async () => {
        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);

        // Dispatch before qualification — the R39 invariant, at the boundary.
        const unqualified = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(unqualified.status).not.toBe(200);
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");

        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });

        // Assignment before any provider acceptance.
        const prematureAssign = await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(prematureAssign.status).not.toBe(200);

        // Confirmation before assignment.
        const prematureConfirm = await ownerCall(world, "POST", "/api/owner/request-confirmation", {
            body: { requestId: demand.requestId }
        });
        expect(prematureConfirm.status).not.toBe(200);

        // Fulfillment before confirmation.
        const prematureFulfil = await ownerCall(world, "POST", "/api/owner/start-fulfillment", {
            body: { requestId: demand.requestId }
        });
        expect(prematureFulfil.status).not.toBe(200);

        // Completion before fulfillment.
        const prematureComplete = await ownerCall(world, "POST", "/api/owner/complete-service", {
            body: { requestId: demand.requestId }
        });
        expect(prematureComplete.status).not.toBe(200);

        // Nothing moved. The request is exactly where the governed path left it.
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
        const trace = await canonicalTrace(pool, demand.requestId);
        expect(trace.map((t) => t.toState)).toEqual(["PENDING_ACCEPTANCE"]);
    }, 120_000);

    it("H-J04 — an unauthorized actor cannot drive any step of the journey", async () => {
        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);

        // The partner holds a real, valid session — for the wrong role.
        for (const path of [
            "/api/owner/qualify",
            "/api/owner/dispatch",
            "/api/owner/assign",
            "/api/owner/request-confirmation",
            "/api/owner/start-fulfillment",
            "/api/owner/complete-service"
        ]) {
            const asProvider = await ownerCall(world, "POST", path, {
                token: provider.token,
                body: { requestId: demand.requestId, providerId: provider.providerId }
            });
            expect([401, 403], `${path} must refuse a partner session`).toContain(
                asProvider.status
            );
            const anonymous = await ownerCall(world, "POST", path, {
                token: "",
                body: { requestId: demand.requestId }
            });
            expect([401, 403], `${path} must refuse an anonymous caller`).toContain(
                anonymous.status
            );
        }
        expect(await stateOf(pool, demand.requestId)).toBe("PENDING_ACCEPTANCE");
    }, 120_000);

    it("H-J05 — scope: the journey is owned by one tenant, market and environment", async () => {
        const demand = await createDemand(world);
        const { rows } = await pool.query<{
            tenant_id: string;
            market_id: string;
            environment: string;
        }>(
            `SELECT i.tenant_id, r.market_id, i.environment
               FROM core_service_request r
               JOIN core_demand_ingress i ON i.request_id = r.request_id
              WHERE r.request_id = $1`,
            [demand.requestId]
        );
        expect({
            t: rows[0]!.tenant_id,
            m: rows[0]!.market_id,
            e: rows[0]!.environment
        }).toEqual({ t: SCOPE.tenantId, m: SCOPE.marketId, e: SCOPE.environment });
    }, 120_000);
});
