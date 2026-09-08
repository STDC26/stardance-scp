// G5-G — the governed channel boundary, end to end through the real gates.
//
// WHATSAPP CARRIES COMMUNICATION. SCP GOVERNS CONSEQUENCE.
//
// Every fixture is built by driving the actual G5-D demand ingress, G5-E
// partner path, G5-F Owner authority and G4 orchestrator. Nothing inserts an
// offer, a confirmation context or a channel message by hand, because a fixture
// that forged the path would prove nothing about whether the path works.
//
// No live messaging: the transport is the in-memory recording adapter and the
// webhook secret is synthetic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { createRecordingTransport } from "../../src/adapters/spine/transports";
import { signPayload } from "../../src/channel/authenticity";
import { startChannelHost } from "../../src/host/channelHost";
import {
    bootChannelWorld,
    channelOps,
    confirmationOnTheChannel,
    count,
    createApprovedProvider,
    createDemand,
    eventId,
    getChannelPool,
    offerOnTheChannel,
    ownerCall,
    recordProviderAcceptance,
    shutdownChannelWorld,
    stateOf,
    webhook,
    SCOPE,
    WEBHOOK_SECRET,
    type ChannelWorld
} from "./channelTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G5-G / outbound: a message may only exist because SCP truth already does", () => {
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

    it("communicates a canonical offer and records durable correlation", async () => {
        const offered = await offerOnTheChannel(world);

        const { rows } = await pool.query<{
            message_type: string;
            request_id: string;
            offer_id: string;
            confirmation_id: string | null;
            status: string;
            tenant_id: string;
            market_id: string;
            environment: string;
            correlation_token: string;
            external_message_id: string | null;
        }>(`SELECT * FROM core_channel_message WHERE message_id = $1`, [offered.messageId]);
        const message = rows[0]!;

        expect(message.message_type).toBe("PROVIDER_OFFER");
        expect(message.request_id).toBe(offered.requestId);
        expect(message.offer_id).toBe(offered.offerId);
        expect(message.confirmation_id).toBeNull();
        expect(message.status).toBe("SENT");
        expect(message.external_message_id).toBeTruthy();
        expect({ t: message.tenant_id, m: message.market_id, e: message.environment }).toEqual({
            t: SCOPE.tenantId,
            m: SCOPE.marketId,
            e: SCOPE.environment
        });
        expect(message.correlation_token.length).toBeGreaterThanOrEqual(24);
        // The transport carried it; the state did not move because of that.
        expect((world.recording as never as { sent: unknown[] }).sent).toHaveLength(1);
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_DISPATCHED");
    });

    it("refuses to message an offer that is not currently open", async () => {
        const offered = await offerOnTheChannel(world);
        await recordProviderAcceptance(
            world,
            offered.requestId,
            offered.providerIdentityId,
            offered.providerId
        );
        const again = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
            body: { offerId: offered.offerId }
        });
        expect(again.status).toBe(422);
        expect(again.body["error"]).toBe("OFFER_NOT_CURRENT");
    });

    it("refuses to send a confirmation message with no live confirmation context", async () => {
        const offered = await offerOnTheChannel(world);
        const attempt = await channelOps(
            world,
            "POST",
            "/api/operations/channel/customer-confirmation",
            { body: { requestId: offered.requestId } }
        );
        expect(attempt.status).toBe(422);
        expect(attempt.body["error"]).toBe("CONFIRMATION_NOT_CURRENT");
        expect(await count(pool, "core_channel_message", "message_type = 'CUSTOMER_CONFIRMATION_REQUEST'")).toBe(0);
    });

    it("the outbound plane requires Owner authority", async () => {
        const offered = await offerOnTheChannel(world);
        for (const token of ["", "not-a-token"]) {
            const attempt = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
                token,
                body: { offerId: offered.offerId }
            });
            expect(attempt.status).toBe(401);
        }
        const provider = await createApprovedProvider(world);
        const asProvider = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
            token: provider.token,
            body: { offerId: offered.offerId }
        });
        expect(asProvider.status).toBe(403);
    });

    it("a message identity is immutable; only delivery status may move", async () => {
        const offered = await offerOnTheChannel(world);
        await expect(
            pool.query(`UPDATE core_channel_message SET body = 'tampered' WHERE message_id = $1`, [
                offered.messageId
            ])
        ).rejects.toThrow(/immutable/);
        await expect(
            pool.query(
                `UPDATE core_channel_message SET correlation_token = 'x' WHERE message_id = $1`,
                [offered.messageId]
            )
        ).rejects.toThrow(/immutable/);
        // Status is allowed to move — that is what it is for.
        await pool.query(`UPDATE core_channel_message SET status = 'DELIVERED' WHERE message_id = $1`, [
            offered.messageId
        ]);
    });
});

d("G5-G / provider ACCEPT and DECLINE through the governed boundary (R38)", () => {
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

    it("a real provider ACCEPT produces canonical acceptance and nothing more", async () => {
        const offered = await offerOnTheChannel(world);
        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });

        expect(response.status).toBe(200);
        expect(response.body["intent"]).toBe("PROVIDER_ACCEPT");
        expect(response.body["actionType"]).toBe("RECORD_PROVIDER_ACCEPTANCE");
        expect(response.body["canonicalState"]).toBe("PROVIDER_ACCEPTED");
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_ACCEPTED");
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(1);

        // The channel event carries the canonical action it caused.
        const { rows } = await pool.query<{
            outcome: string;
            authenticity: string;
            action_id: string;
            resolved_intent: string;
        }>(`SELECT outcome::text, authenticity::text, action_id, resolved_intent
              FROM core_channel_event WHERE event_id = $1`, [response.body["eventId"]]);
        expect(rows[0]).toMatchObject({
            outcome: "ACCEPTED",
            authenticity: "VERIFIED",
            resolved_intent: "PROVIDER_ACCEPT"
        });
        expect(rows[0]!.action_id).toBeTruthy();
    });

    it("PROVIDER_ACCEPTED is not OWNER_ASSIGNED", async () => {
        const offered = await offerOnTheChannel(world);
        await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(await count(pool, "core_assignment")).toBe(0);
        expect(await count(pool, "core_customer_confirmation", "status = 'CONFIRMED'")).toBe(0);
        expect(await count(pool, "core_fulfillment")).toBe(0);

        // Assignment still requires the explicit Owner act.
        const assigned = await ownerCall(world, "POST", "/api/owner/assign", {
            body: { requestId: offered.requestId, providerId: offered.providerId }
        });
        expect(assigned.status).toBe(200);
        expect(await stateOf(pool, offered.requestId)).toBe("OWNER_ASSIGNED");
    });

    it("a real provider DECLINE releases the request through governed behaviour", async () => {
        const offered = await offerOnTheChannel(world);
        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "decline",
            correlationToken: offered.correlationToken
        });
        expect(response.status).toBe(200);
        expect(response.body["intent"]).toBe("PROVIDER_DECLINE");
        expect(response.body["actionType"]).toBe("RECORD_PROVIDER_REJECTION");
        // Decline is an offer outcome; the request returns to the pool.
        expect(await stateOf(pool, offered.requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await count(pool, "core_assignment")).toBe(0);
    });
});

d("G5-G / provider adversarial matrix", () => {
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

    async function assertInert(requestId: string): Promise<void> {
        expect(await stateOf(pool, requestId)).toBe("PROVIDER_DISPATCHED");
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(0);
        expect(await count(pool, "core_assignment")).toBe(0);
    }

    it("a forged webhook is refused and mutates nothing", async () => {
        const offered = await offerOnTheChannel(world);
        for (const signature of ["sha256=deadbeef", "", "sha256=" + "0".repeat(64)]) {
            const response = await webhook(
                world,
                {
                    eventId: eventId(),
                    channel: "WHATSAPP",
                    from: offered.providerHandle,
                    text: "ACCEPT",
                    correlationToken: offered.correlationToken
                },
                { signature }
            );
            expect(response.status).toBe(401);
        }
        // Signed with the wrong secret.
        const wrongSecret = await webhook(
            world,
            {
                eventId: eventId(),
                channel: "WHATSAPP",
                from: offered.providerHandle,
                text: "ACCEPT",
                correlationToken: offered.correlationToken
            },
            { secret: "not-the-secret" }
        );
        expect(wrongSecret.status).toBe(401);
        await assertInert(offered.requestId);

        // Every rejected event is still recorded, and every one is inert.
        const rejected = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_channel_event
              WHERE authenticity = 'REJECTED' AND action_id IS NULL AND outcome = 'REFUSED'`
        );
        expect(Number(rejected.rows[0]!.n)).toBeGreaterThanOrEqual(4);
    });

    it("a signature valid for different bytes does not authenticate this body", async () => {
        const offered = await offerOnTheChannel(world);
        const honest = JSON.stringify({
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "DECLINE",
            correlationToken: offered.correlationToken
        });
        const tampered = honest.replace("DECLINE", "ACCEPT!");
        const response = await webhook(world, null, {
            rawBody: tampered,
            signature: signPayload(WEBHOOK_SECRET, honest)
        });
        expect(response.status).toBe(401);
        await assertInert(offered.requestId);
    });

    it("the wrong provider holding a valid token is refused", async () => {
        const offered = await offerOnTheChannel(world);
        const other = await createApprovedProvider(world, { displayName: "Someone Else" });
        const otherHandle = await pool.query<{ channel_handle: string }>(
            `SELECT i.channel_handle FROM core_provider p
               JOIN core_identity i ON i.identity_id = p.identity_id
              WHERE p.provider_id = $1`,
            [other.providerId]
        );

        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: otherHandle.rows[0]!.channel_handle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(response.status).toBe(403);
        expect(response.body["error"]).toBe("WRONG_RECIPIENT");
        await assertInert(offered.requestId);
    });

    it("an unknown sender, an unknown token and no token at all are all refused", async () => {
        const offered = await offerOnTheChannel(world);

        const unknownSender = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: "+628990000000",
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(unknownSender.body["error"]).toBe("NO_SENDER_IDENTITY");

        const unknownToken = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        });
        expect(unknownToken.body["error"]).toBe("CORRELATION_UNKNOWN");

        const noToken = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT"
        });
        expect(noToken.body["error"]).toBe("NO_CORRELATION");

        await assertInert(offered.requestId);
    });

    it("a stale token is not an evergreen authority", async () => {
        const offered = await offerOnTheChannel(world);
        // The provider declines, which closes the offer. The old message token
        // still exists — and must no longer do anything.
        await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "DECLINE",
            correlationToken: offered.correlationToken
        });
        expect(await stateOf(pool, offered.requestId)).toBe("PENDING_ACCEPTANCE");

        const late = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(late.status).toBe(422);
        expect(late.body["error"]).toBe("CANONICAL_REFUSAL");
        expect(late.body["canonicalReason"]).toBe("STALE_DISPATCH_RESPONSE");
        expect(await stateOf(pool, offered.requestId)).toBe("PENDING_ACCEPTANCE");
        expect(await count(pool, "core_assignment")).toBe(0);
    });

    it("a cross-scope message is refused", async () => {
        const offered = await offerOnTheChannel(world);

        // Re-scoping an existing message is refused by the database itself —
        // the identity of a message is what correlation depends on.
        await expect(
            pool.query(
                `UPDATE core_channel_message SET tenant_id = 'another-tenant' WHERE message_id = $1`,
                [offered.messageId]
            )
        ).rejects.toThrow(/immutable/);

        // So the attack has to plant a foreign-scoped message instead. The
        // ingress refuses it on scope before it reaches anything consequential.
        const foreign = await pool.query<{ correlation_token: string }>(
            `INSERT INTO core_channel_message
                (tenant_id, market_id, environment, channel, message_type, request_id,
                 offer_id, recipient_identity_id, recipient_handle, correlation_token,
                 body, status, sent_at, external_message_id)
             SELECT 'another-tenant', market_id, environment, channel, message_type, request_id,
                    offer_id, recipient_identity_id, recipient_handle,
                    'FOREIGNTOKEN' || correlation_token, body, status, sent_at, external_message_id
               FROM core_channel_message WHERE message_id = $1
             RETURNING correlation_token`,
            [offered.messageId]
        );

        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: foreign.rows[0]!.correlation_token
        });
        expect(response.status).toBe(403);
        expect(response.body["error"]).toBe("CROSS_SCOPE_REFUSED");
        await assertInert(offered.requestId);
    });

    it("ambiguous and non-consequential text bind nothing", async () => {
        const offered = await offerOnTheChannel(world);
        for (const [text, reason] of [
            ["accept, no wait, decline", "AMBIGUOUS_FREE_TEXT"],
            ["what time is it?", "NO_CONSEQUENTIAL_INTENT"],
            ["👍", "NO_CONSEQUENTIAL_INTENT"]
        ] as const) {
            const response = await webhook(world, {
                eventId: eventId(),
                channel: "WHATSAPP",
                from: offered.providerHandle,
                text,
                correlationToken: offered.correlationToken
            });
            expect(response.body["error"], text).toBe(reason);
        }
        await assertInert(offered.requestId);
    });

    it("an undeclared field in the payload is refused", async () => {
        const offered = await offerOnTheChannel(world);
        for (const field of ["requestId", "offerId", "decision", "providerId", "state"]) {
            const response = await webhook(world, {
                eventId: eventId(),
                channel: "WHATSAPP",
                from: offered.providerHandle,
                text: "ACCEPT",
                correlationToken: offered.correlationToken,
                [field]: "forged"
            });
            expect(response.status, field).toBe(422);
            expect(response.body["error"], field).toBe("UNDECLARED_FIELD");
        }
        await assertInert(offered.requestId);
    });
});

d("G5-G / customer confirmation and the R37 falsification", () => {
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

    it("a correlated customer CONFIRM produces canonical confirmation and no fulfillment", async () => {
        const conf = await confirmationOnTheChannel(world);
        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: conf.customerHandle,
            text: "CONFIRM",
            correlationToken: conf.correlationToken
        });

        expect(response.status).toBe(200);
        expect(response.body["intent"]).toBe("CUSTOMER_CONFIRM");
        expect(response.body["actionType"]).toBe("RECORD_CUSTOMER_CONFIRMATION");
        expect(await stateOf(pool, conf.requestId)).toBe("CUSTOMER_CONFIRMED");
        // Confirming is not starting.
        expect(await count(pool, "core_fulfillment")).toBe(0);
    });

    it("a correlated customer DECLINE uses the existing cancellation contract", async () => {
        const conf = await confirmationOnTheChannel(world);
        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: conf.customerHandle,
            text: "cancel",
            correlationToken: conf.correlationToken
        });
        expect(response.status).toBe(200);
        expect(response.body["intent"]).toBe("CUSTOMER_DECLINE");
        expect(response.body["actionType"]).toBe("CANCEL_SERVICE");
        expect(await stateOf(pool, conf.requestId)).toBe("CANCELLED");
    });

    it("R37 — Owner SERVICEABLE eligibility cannot manufacture a confirmation", async () => {
        // The exact attack: a request is judged serviceable, no confirmation
        // context has been opened, and the customer sends a plausible
        // confirmation anyway.
        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        const customer = await pool.query<{ identity_id: string; channel_handle: string }>(
            `SELECT i.identity_id, i.channel_handle FROM core_service_request r
               JOIN core_identity i ON i.identity_id = r.customer_identity_id
              WHERE r.request_id = $1`,
            [demand.requestId]
        );
        // The role IS granted — that is what R37 describes.
        const roles = await pool.query<{ role: string }>(
            `SELECT role::text AS role FROM core_identity_role WHERE identity_id = $1`,
            [customer.rows[0]!.identity_id]
        );
        expect(roles.rows.map((r) => r.role)).toContain("CUSTOMER");

        // Attack 1 — through the channel, with no confirmation message ever sent
        // and therefore no correlation token to hold.
        const viaChannel = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: customer.rows[0]!.channel_handle,
            text: "CONFIRM",
            correlationToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        });
        expect(viaChannel.status).toBe(422);
        expect(viaChannel.body["error"]).toBe("CORRELATION_UNKNOWN");

        // Attack 2 — bypassing the channel entirely and calling the governed
        // action directly with the customer's own identity.
        const direct = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CUSTOMER_CONFIRMATION",
                marketId: "bali",
                requestId: demand.requestId,
                actorIdentityId: customer.rows[0]!.identity_id,
                idempotencyKey: `r37:${demand.requestId}`
            })
        );
        expect(direct.ok).toBe(false);
        if (!direct.ok) {
            expect(direct.reasonCode).toBe("INVALID_PREDECESSOR_STATE");
        }

        // Attack 3 — the customer holds a token for a DIFFERENT conversation:
        // the provider's offer message.
        const dispatched = await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        expect(dispatched.status).toBe(200);
        const offerRow = await pool.query<{ offer_id: string }>(
            `SELECT offer_id FROM core_dispatch_offer WHERE request_id = $1 AND state = 'OFFERED'`,
            [demand.requestId]
        );
        const sent = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
            body: { offerId: offerRow.rows[0]!.offer_id }
        });
        const providerMessage = sent.body["message"] as Record<string, string>;
        const stolen = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: customer.rows[0]!.channel_handle,
            text: "CONFIRM",
            correlationToken: providerMessage["correlationToken"]!
        });
        expect(stolen.status).toBe(403);
        expect(stolen.body["error"]).toBe("WRONG_RECIPIENT");

        // Nothing consequential happened in any of the three.
        expect(await count(pool, "core_customer_confirmation", "status = 'CONFIRMED'")).toBe(0);
        expect(await count(pool, "core_fulfillment")).toBe(0);
        expect(await stateOf(pool, demand.requestId)).toBe("PROVIDER_DISPATCHED");
    });

    it("a stale confirmation token is refused after the context moves on", async () => {
        const conf = await confirmationOnTheChannel(world);
        await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: conf.customerHandle,
            text: "CONFIRM",
            correlationToken: conf.correlationToken
        });
        expect(await stateOf(pool, conf.requestId)).toBe("CUSTOMER_CONFIRMED");

        const again = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: conf.customerHandle,
            text: "CONFIRM",
            correlationToken: conf.correlationToken
        });
        expect(again.status).toBe(422);
        expect(again.body["error"]).toBe("CANONICAL_REFUSAL");
        expect(await count(pool, "core_customer_confirmation", "status = 'CONFIRMED'")).toBe(1);
    });
});

d("G5-G / idempotency, replay, concurrency, failure and durability", () => {
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

    it("an identical webhook redelivery produces one canonical acceptance", async () => {
        const offered = await offerOnTheChannel(world);
        const payload = {
            eventId: eventId("dup"),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        };
        const first = await webhook(world, payload);
        const second = await webhook(world, payload);

        expect(first.body["outcome"]).toBe("ACCEPTED");
        expect(second.status).toBe(200);
        expect(second.body["outcome"]).toBe("REPLAYED");
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(1);
        expect(
            await count(pool, "core_operational_action", "action_type = 'RECORD_PROVIDER_ACCEPTANCE'")
        ).toBe(1);
    });

    it("the same event id carrying different bytes is a conflict, not a replay", async () => {
        const offered = await offerOnTheChannel(world);
        const id = eventId("conflict");
        await webhook(world, {
            eventId: id,
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "DECLINE",
            correlationToken: offered.correlationToken
        });
        const conflicting = await webhook(world, {
            eventId: id,
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(conflicting.status).toBe(409);
        expect(conflicting.body["error"]).toBe("EVENT_ID_CONFLICT");
        expect(await stateOf(pool, offered.requestId)).toBe("PENDING_ACCEPTANCE");
    });

    it("six concurrent redeliveries produce one canonical transition", async () => {
        const offered = await offerOnTheChannel(world);
        const payload = {
            eventId: eventId("race"),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        };
        const responses = await Promise.all(
            Array.from({ length: 6 }, () => webhook(world, payload))
        );
        for (const response of responses) {
            expect([200, 409]).toContain(response.status);
        }
        expect(responses.filter((r) => r.body["outcome"] === "ACCEPTED")).toHaveLength(1);
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(1);
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_ACCEPTED");
    });

    it("distinct events expressing the same intent still yield one acceptance", async () => {
        const offered = await offerOnTheChannel(world);
        const send = () =>
            webhook(world, {
                eventId: eventId("distinct"),
                channel: "WHATSAPP",
                from: offered.providerHandle,
                text: "ACCEPT",
                correlationToken: offered.correlationToken
            });
        const first = await send();
        const second = await send();
        expect(first.status).toBe(200);
        // The second is a NEW channel event, judged on current state by Core.
        expect(second.status).toBe(422);
        expect(second.body["canonicalReason"]).toBe("STALE_DISPATCH_RESPONSE");
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(1);
    });

    it("a delivery or read receipt never fabricates a business outcome", async () => {
        const offered = await offerOnTheChannel(world);
        for (const receipt of ["DELIVERED", "READ"] as const) {
            const response = await webhook(world, {
                eventId: eventId("receipt"),
                channel: "WHATSAPP",
                from: offered.providerHandle,
                receipt,
                messageId: offered.messageId
            });
            expect(response.status).toBe(200);
            expect(response.body["intent"]).toBe("RECEIPT");
            expect(response.body["actionId"]).toBeNull();
        }
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_DISPATCHED");
        expect(await count(pool, "core_dispatch_offer", "state = 'ACCEPTED'")).toBe(0);
        expect(await count(pool, "core_operational_action")).toBeGreaterThan(0);

        const { rows } = await pool.query<{ status: string }>(
            `SELECT status::text AS status FROM core_channel_message WHERE message_id = $1`,
            [offered.messageId]
        );
        expect(rows[0]!.status).toBe("READ");
    });

    it("a send failure leaves the canonical offer exactly as it was", async () => {
        await shutdownChannelWorld(world);
        world = await bootChannelWorld(pool, {
            transport: createRecordingTransport("WHATSAPP", {
                fail: { code: "TRANSPORT_UNAVAILABLE", message: "simulated outage" }
            })
        });

        const provider = await createApprovedProvider(world);
        const demand = await createDemand(world);
        await ownerCall(world, "POST", "/api/owner/qualify", {
            body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
        });
        await ownerCall(world, "POST", "/api/owner/dispatch", {
            body: { requestId: demand.requestId, providerId: provider.providerId }
        });
        const offer = await pool.query<{ offer_id: string; state: string }>(
            `SELECT offer_id, state::text AS state FROM core_dispatch_offer WHERE request_id = $1`,
            [demand.requestId]
        );

        const sent = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
            body: { offerId: offer.rows[0]!.offer_id }
        });
        expect(sent.status).toBe(200);
        expect(sent.body["transported"]).toBe(false);
        expect(sent.body["failureCode"]).toBe("TRANSPORT_UNAVAILABLE");

        // The offer and the request are untouched by the transport's failure.
        const after = await pool.query<{ state: string }>(
            `SELECT state::text AS state FROM core_dispatch_offer WHERE offer_id = $1`,
            [offer.rows[0]!.offer_id]
        );
        expect(after.rows[0]!.state).toBe("OFFERED");
        expect(await stateOf(pool, demand.requestId)).toBe("PROVIDER_DISPATCHED");
        const message = await pool.query<{ status: string; failure_code: string }>(
            `SELECT status::text AS status, failure_code FROM core_channel_message
              WHERE request_id = $1`,
            [demand.requestId]
        );
        expect(message.rows[0]).toMatchObject({
            status: "SEND_FAILED",
            failure_code: "TRANSPORT_UNAVAILABLE"
        });
    });

    it("an unconfigured webhook secret refuses rather than admits", async () => {
        await shutdownChannelWorld(world);
        world = await bootChannelWorld(pool, { webhookSecret: "" });
        const offered = await offerOnTheChannel(world);

        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(response.status).toBe(503);
        expect(response.body["error"]).toBe("WEBHOOK_NOT_CONFIGURED");
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_DISPATCHED");
    });

    it("canonical truth and pending correlation survive a restart", async () => {
        const offered = await offerOnTheChannel(world);
        const before = await pool.query(
            `SELECT correlation_token, status::text AS status FROM core_channel_message
              WHERE message_id = $1`,
            [offered.messageId]
        );

        await world.channelHost.close();
        const restarted = await startChannelHost({
            pool,
            identity: {
                tenantId: SCOPE.tenantId,
                marketId: SCOPE.marketId,
                environment: SCOPE.environment
            },
            webhookSecret: WEBHOOK_SECRET,
            transport: createRecordingTransport("WHATSAPP")
        });
        expect(restarted.ok).toBe(true);
        if (!restarted.ok) return;
        world = { ...world, channelHost: restarted.host };

        // Same database, fresh host process: the correlation is still resolvable.
        const after = await pool.query(
            `SELECT correlation_token, status::text AS status FROM core_channel_message
              WHERE message_id = $1`,
            [offered.messageId]
        );
        expect(after.rows[0]).toEqual(before.rows[0]);

        const response = await webhook(world, {
            eventId: eventId("restart"),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        expect(response.status).toBe(200);
        expect(await stateOf(pool, offered.requestId)).toBe("PROVIDER_ACCEPTED");
    });

    it("the inbound event log is append-only", async () => {
        const offered = await offerOnTheChannel(world);
        const response = await webhook(world, {
            eventId: eventId(),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });
        await expect(
            pool.query(`UPDATE core_channel_event SET outcome = 'REFUSED' WHERE event_id = $1`, [
                response.body["eventId"]
            ])
        ).rejects.toThrow(/append-only/);
        await expect(
            pool.query(`DELETE FROM core_channel_event WHERE event_id = $1`, [
                response.body["eventId"]
            ])
        ).rejects.toThrow(/append-only/);
    });
});

d("G5-G / audit lineage", () => {
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

    it("reconstructs canonical object -> message -> event -> action -> state", async () => {
        const offered = await offerOnTheChannel(world);
        const accepted = await webhook(world, {
            eventId: eventId("lineage"),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "ACCEPT",
            correlationToken: offered.correlationToken
        });

        const { rows } = await pool.query<{
            offer_id: string;
            message_id: string;
            message_status: string;
            event_id: string;
            authenticity: string;
            resolved_intent: string;
            event_outcome: string;
            action_type: string;
            action_outcome: string;
            actor_role: string;
            to_state: string;
        }>(
            `SELECT o.offer_id,
                    m.message_id, m.status::text AS message_status,
                    e.event_id, e.authenticity::text AS authenticity, e.resolved_intent,
                    e.outcome::text AS event_outcome,
                    a.action_type, a.outcome::text AS action_outcome, a.actor_role,
                    ev.to_state
               FROM core_dispatch_offer o
               JOIN core_channel_message m ON m.offer_id = o.offer_id
               JOIN core_channel_event e ON e.correlated_message_id = m.message_id
               JOIN core_operational_action a ON a.action_id = e.action_id
               JOIN core_event ev ON ev.object_id = o.request_id
                                 AND ev.to_state = 'PROVIDER_ACCEPTED'
              WHERE o.offer_id = $1`,
            [offered.offerId]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            message_status: "SENT",
            authenticity: "VERIFIED",
            resolved_intent: "PROVIDER_ACCEPT",
            event_outcome: "ACCEPTED",
            action_type: "RECORD_PROVIDER_ACCEPTANCE",
            action_outcome: "ACCEPTED",
            actor_role: "PROVIDER",
            to_state: "PROVIDER_ACCEPTED"
        });
        expect(rows[0]!.event_id).toBe(String(accepted.body["eventId"]));

        // Every stage is separately recorded as runtime evidence too.
        const evidence = await pool.query<{ kind: string }>(
            `SELECT DISTINCT kind::text AS kind FROM core_runtime_evidence
              WHERE kind::text LIKE 'CHANNEL_%' ORDER BY kind`
        );
        const kinds = evidence.rows.map((r) => r.kind);
        expect(kinds).toContain("CHANNEL_MESSAGE_CREATED");
        expect(kinds).toContain("CHANNEL_MESSAGE_SENT");
        expect(kinds).toContain("CHANNEL_ACTION_INVOKED");
        expect(kinds).toContain("CHANNEL_EVENT_ACCEPTED");
    });

    it("a refused event is auditable evidence with a reason and no action", async () => {
        const offered = await offerOnTheChannel(world);
        await webhook(world, {
            eventId: eventId("refused"),
            channel: "WHATSAPP",
            from: offered.providerHandle,
            text: "maybe later",
            correlationToken: offered.correlationToken
        });
        const { rows } = await pool.query<{
            outcome: string;
            reason_code: string;
            action_id: string | null;
            resolved_intent: string | null;
        }>(
            `SELECT outcome::text AS outcome, reason_code, action_id, resolved_intent
               FROM core_channel_event WHERE reason_code = 'NO_CONSEQUENTIAL_INTENT'`
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.outcome).toBe("REFUSED");
        expect(rows[0]!.action_id).toBeNull();
    });
});
