// SCP-G5-G — the governed inbound channel boundary.
//
// WHATSAPP CARRIES COMMUNICATION. SCP GOVERNS CONSEQUENCE.
//
// One pipeline, in one order, and only the last step can change canonical
// state:
//
//   1. authenticity        the bytes came from the configured transport
//   2. payload             a CLOSED contract; nothing else is accepted
//   3. replay              this provider event id has a durable boundary
//   4. correlation         the token resolves to one message we actually sent
//   5. actor               the sender resolves to the identity we sent it TO
//   6. scope               tenant / market / environment agree
//   7. intent              unambiguous, and applicable to THIS message type
//   8. governed SCP action executeOperationalAction — Core validates the rest
//   9. audit               the event is recorded whatever the outcome
//
// Steps 1-7 can only ever REFUSE. Step 8 is the single place a consequence can
// happen, and it is not this module's code — it is the G4 orchestrator, which
// re-derives authority, predecessor state and idempotency from persisted truth
// and would refuse this call exactly as it refuses any other.
//
// Nothing here interprets. There is no model, no fuzzy matching, no "probably
// meant yes". Ambiguous text is refused, because a channel that guesses is a
// channel that eventually guesses wrong about somebody's money.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { executeOperationalAction, type OperationalOutcome } from "../lifecycle/orchestrator";
import type { OperationalActionType } from "../lifecycle/actions";
import type { MarketId } from "../config/marketConfig";
import { identityForChannelHandle } from "../core/identity/authority";
import { normalizeText } from "../adapters/channel/whatsappChannelAdapter";
import { recordRuntimeEvidence } from "../runtime/evidence";
import type { IdentityLineage } from "../runtime/identity";
import { messageByToken, type ChannelMessage, type ChannelMessageType } from "./outbound";
import type { ChannelReason } from "./reasons";

// -----------------------------------------------------------------------------
// The closed inbound contract
// -----------------------------------------------------------------------------

export const DECLARED_WEBHOOK_FIELDS = [
    "eventId",
    "channel",
    "from",
    "text",
    "correlationToken",
    "receipt",
    "messageId"
] as const;

export interface InboundEvent {
    eventId: string;
    channel: string;
    from: string;
    text: string | null;
    correlationToken: string | null;
    /** A delivery/read receipt rather than a human response. */
    receipt: "DELIVERED" | "READ" | null;
    messageId: string | null;
}

export interface ParseFinding {
    field: string;
    message: string;
}

export type ParseResult =
    | { ok: true; event: InboundEvent }
    | { ok: false; findings: ParseFinding[] };

/**
 * Parses the webhook body against a CLOSED contract.
 *
 * Deliberately absent, and why: no `providerId`, `requestId`, `offerId`,
 * `identityId`, `decision`, `state` or `intent`. A sender may say what they
 * typed and which conversation it belongs to. Everything else is resolved from
 * what SCP already knows, so there is no field through which a caller could
 * name the object it wants to affect.
 */
export function parseInboundEvent(body: unknown): ParseResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, findings: [{ field: "<body>", message: "body must be a JSON object" }] };
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set<string>(DECLARED_WEBHOOK_FIELDS);
    const findings: ParseFinding[] = [];
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            findings.push({
                field: key,
                message: `${key} is not part of the inbound channel contract and is not accepted`
            });
        }
    }

    const text = (field: string, required: boolean): string | null => {
        const value = record[field];
        if (value === undefined || value === null) {
            if (required) {
                findings.push({ field, message: `${field} is required` });
            }
            return null;
        }
        if (typeof value !== "string" || value.trim() === "") {
            findings.push({ field, message: `${field} must be a non-empty string` });
            return null;
        }
        if (value.length > 4096) {
            findings.push({ field, message: `${field} exceeds the accepted length` });
            return null;
        }
        return value.trim();
    };

    const eventId = text("eventId", true);
    const channel = text("channel", true);
    const from = text("from", true);
    const messageText = text("text", false);
    const correlationToken = text("correlationToken", false);
    const messageId = text("messageId", false);

    let receipt: "DELIVERED" | "READ" | null = null;
    const rawReceipt = record["receipt"];
    if (rawReceipt !== undefined && rawReceipt !== null) {
        if (rawReceipt === "DELIVERED" || rawReceipt === "READ") {
            receipt = rawReceipt;
        } else {
            findings.push({ field: "receipt", message: "receipt must be DELIVERED or READ" });
        }
    }

    if (findings.length > 0 || eventId === null || channel === null || from === null) {
        return { ok: false, findings };
    }
    return {
        ok: true,
        event: { eventId, channel, from, text: messageText, correlationToken, receipt, messageId }
    };
}

// -----------------------------------------------------------------------------
// Intent
// -----------------------------------------------------------------------------

export type ChannelIntent =
    | "PROVIDER_ACCEPT"
    | "PROVIDER_DECLINE"
    | "CUSTOMER_CONFIRM"
    | "CUSTOMER_DECLINE"
    | "AMBIGUOUS"
    | "NONE";

const ACCEPT_RE = /\b(accept|accepted|yes|ya|ok|oke|setuju)\b/i;
const CONFIRM_RE = /\b(confirm|confirmed|yes|ya|ok|oke|setuju)\b/i;
const DECLINE_RE = /\b(decline|declined|reject|rejected|no|tidak|batal|cancel)\b/i;

/**
 * Classifies a response IN THE CONTEXT of the message it replies to.
 *
 * The same word means different things in different conversations, so the
 * message type — which SCP chose when it sent the message — decides which
 * vocabulary applies. A provider cannot confirm a customer's booking by typing
 * "confirm", because the message they are replying to is an offer.
 */
export function classifyResponse(messageType: ChannelMessageType, raw: string): ChannelIntent {
    const text = normalizeText(raw);
    const positive = messageType === "PROVIDER_OFFER" ? ACCEPT_RE.test(text) : CONFIRM_RE.test(text);
    const negative = DECLINE_RE.test(text);
    if (positive && negative) {
        return "AMBIGUOUS";
    }
    if (positive) {
        return messageType === "PROVIDER_OFFER" ? "PROVIDER_ACCEPT" : "CUSTOMER_CONFIRM";
    }
    if (negative) {
        return messageType === "PROVIDER_OFFER" ? "PROVIDER_DECLINE" : "CUSTOMER_DECLINE";
    }
    return "NONE";
}

// -----------------------------------------------------------------------------
// The pipeline
// -----------------------------------------------------------------------------

export interface IngressContext {
    lineage: IdentityLineage;
    configurationVersion: number;
    configurationChecksum: string;
    correlationId: string;
    /** Result of the authenticity gate the host already ran. */
    authenticity: { ok: true } | { ok: false; code: ChannelReason; message: string };
    /** The exact bytes the authenticity check ran over. */
    rawBody: Buffer | string;
    now?: Date;
}

export interface IngressAccepted {
    eventId: number;
    outcome: "ACCEPTED" | "REPLAYED";
    intent: ChannelIntent | "RECEIPT";
    messageId: string | null;
    requestId: string | null;
    actionId: string | null;
    actionType: OperationalActionType | null;
    canonicalState: string | null;
}

export type IngressOutcome =
    | { ok: true; value: IngressAccepted }
    | {
          ok: false;
          eventId: number | null;
          reason: ChannelReason;
          message: string;
          canonicalReason?: string;
          findings?: ParseFinding[];
      };

function digestOf(body: Buffer | string): string {
    return createHash("sha256")
        .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
        .digest("hex");
}

interface EventRecord {
    providerEventId: string;
    senderHandle: string;
    authenticity: "VERIFIED" | "REJECTED";
    correlationToken: string | null;
    correlatedMessageId: string | null;
    resolvedIntent: string | null;
    outcome: "ACCEPTED" | "REFUSED" | "REPLAYED";
    reasonCode: string | null;
    requestId: string | null;
    actionId: string | null;
    channel: string;
}

/** Records the inbound event. Always happens — a refusal is still evidence. */
async function recordEvent(
    client: PoolClient,
    context: IngressContext,
    record: EventRecord
): Promise<number> {
    const { rows } = await client.query<{ event_id: string }>(
        `INSERT INTO core_channel_event
            (tenant_id, market_id, environment, channel, provider_event_id, sender_handle,
             raw_body_sha256, authenticity, correlation_token, correlated_message_id,
             resolved_intent, outcome, reason_code, request_id, action_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING event_id`,
        [
            context.lineage.tenantId,
            context.lineage.marketId,
            context.lineage.environment,
            record.channel,
            record.providerEventId,
            record.senderHandle,
            digestOf(context.rawBody),
            record.authenticity,
            record.correlationToken,
            record.correlatedMessageId,
            record.resolvedIntent,
            record.outcome,
            record.reasonCode,
            record.requestId,
            record.actionId
        ]
    );
    return Number(rows[0]!.event_id);
}

async function evidence(
    client: PoolClient,
    context: IngressContext,
    kind:
        | "CHANNEL_WEBHOOK_REJECTED"
        | "CHANNEL_EVENT_ACCEPTED"
        | "CHANNEL_EVENT_REPLAYED"
        | "CHANNEL_INTENT_REFUSED"
        | "CHANNEL_ACTION_INVOKED",
    detail: Record<string, unknown>,
    reasonCode?: string
): Promise<void> {
    await recordRuntimeEvidence(client, {
        kind,
        lineage: context.lineage,
        outcome: kind === "CHANNEL_EVENT_ACCEPTED" || kind === "CHANNEL_ACTION_INVOKED" || kind === "CHANNEL_EVENT_REPLAYED" ? "OK" : "REFUSED",
        reasonCode: reasonCode ?? null,
        configurationVersion: context.configurationVersion,
        configurationChecksum: context.configurationChecksum,
        detail: { correlationId: context.correlationId, ...detail }
    });
}

/** Which governed action a validated intent maps to. No new vocabulary. */
function actionFor(intent: ChannelIntent): OperationalActionType | null {
    switch (intent) {
        case "PROVIDER_ACCEPT":
            return "RECORD_PROVIDER_ACCEPTANCE";
        case "PROVIDER_DECLINE":
            return "RECORD_PROVIDER_REJECTION";
        case "CUSTOMER_CONFIRM":
            return "RECORD_CUSTOMER_CONFIRMATION";
        case "CUSTOMER_DECLINE":
            // An existing contract: a customer may cancel their own request.
            return "CANCEL_SERVICE";
        default:
            return null;
    }
}

/**
 * The one entry point for inbound channel events. Must run inside a
 * transaction: the event record, any governed action and its canonical
 * consequence all land together or not at all.
 */
export async function ingestChannelEvent(
    client: PoolClient,
    context: IngressContext,
    body: unknown
): Promise<IngressOutcome> {
    // --- 1. authenticity -------------------------------------------------
    if (!context.authenticity.ok) {
        const parsed = parseInboundEvent(body);
        const eventId = await recordEvent(client, context, {
            providerEventId: parsed.ok
                ? parsed.event.eventId
                : `unauthenticated:${digestOf(context.rawBody).slice(0, 32)}`,
            senderHandle: parsed.ok ? parsed.event.from : "unknown",
            authenticity: "REJECTED",
            correlationToken: null,
            correlatedMessageId: null,
            resolvedIntent: null,
            outcome: "REFUSED",
            reasonCode: context.authenticity.code,
            requestId: null,
            actionId: null,
            channel: parsed.ok ? parsed.event.channel : "UNKNOWN"
        }).catch(() => null);
        await evidence(
            client,
            context,
            "CHANNEL_WEBHOOK_REJECTED",
            { canonicalMutation: false },
            context.authenticity.code
        );
        return {
            ok: false,
            eventId,
            reason: context.authenticity.code,
            message: context.authenticity.message
        };
    }

    // --- 2. payload ------------------------------------------------------
    const parsed = parseInboundEvent(body);
    if (!parsed.ok) {
        await evidence(
            client,
            context,
            "CHANNEL_INTENT_REFUSED",
            { findings: parsed.findings, canonicalMutation: false },
            "PAYLOAD_MALFORMED"
        );
        return {
            ok: false,
            eventId: null,
            reason: parsed.findings.some((f) => f.message.includes("not part of"))
                ? "UNDECLARED_FIELD"
                : "PAYLOAD_MALFORMED",
            message: "the inbound event does not satisfy the channel contract",
            findings: parsed.findings
        };
    }
    const event = parsed.event;

    // --- 3. replay -------------------------------------------------------
    // Serialize contenders for this event id, so simultaneous redeliveries
    // queue rather than racing the unique index into a raw 23505.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `channel-event:${context.lineage.tenantId}:${context.lineage.marketId}:${context.lineage.environment}:${event.eventId}`
    ]);
    const prior = await client.query<{
        event_id: string;
        raw_body_sha256: string;
        outcome: string;
        reason_code: string | null;
        request_id: string | null;
        action_id: string | null;
        resolved_intent: string | null;
        correlated_message_id: string | null;
    }>(
        `SELECT event_id, raw_body_sha256, outcome::text AS outcome, reason_code, request_id,
                action_id, resolved_intent, correlated_message_id
           FROM core_channel_event
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
            AND channel = $4 AND provider_event_id = $5`,
        [
            context.lineage.tenantId,
            context.lineage.marketId,
            context.lineage.environment,
            event.channel,
            event.eventId
        ]
    );
    if (prior.rows[0]) {
        const first = prior.rows[0];
        if (first.raw_body_sha256 !== digestOf(context.rawBody)) {
            // The same event id carrying different bytes is not a redelivery.
            await evidence(
                client,
                context,
                "CHANNEL_INTENT_REFUSED",
                { providerEventId: event.eventId, canonicalMutation: false },
                "EVENT_ID_CONFLICT"
            );
            return {
                ok: false,
                eventId: Number(first.event_id),
                reason: "EVENT_ID_CONFLICT",
                message: `event ${event.eventId} was already received with different content`
            };
        }
        await evidence(client, context, "CHANNEL_EVENT_REPLAYED", {
            providerEventId: event.eventId,
            originalOutcome: first.outcome,
            duplicateTransition: false
        });
        if (first.outcome === "REFUSED") {
            return {
                ok: false,
                eventId: Number(first.event_id),
                reason: (first.reason_code as ChannelReason) ?? "NO_CONSEQUENTIAL_INTENT",
                message: "this event was already received and refused"
            };
        }
        return {
            ok: true,
            value: {
                eventId: Number(first.event_id),
                outcome: "REPLAYED",
                intent: (first.resolved_intent as ChannelIntent) ?? "NONE",
                messageId: first.correlated_message_id,
                requestId: first.request_id,
                actionId: first.action_id,
                actionType: null,
                canonicalState: null
            }
        };
    }

    const refuse = async (
        reason: ChannelReason,
        message: string,
        record: Partial<EventRecord> = {},
        canonicalReason?: string
    ): Promise<IngressOutcome> => {
        const eventId = await recordEvent(client, context, {
            providerEventId: event.eventId,
            senderHandle: event.from,
            authenticity: "VERIFIED",
            correlationToken: event.correlationToken,
            correlatedMessageId: null,
            resolvedIntent: null,
            outcome: "REFUSED",
            reasonCode: reason,
            requestId: null,
            actionId: null,
            channel: event.channel,
            ...record
        });
        await evidence(
            client,
            context,
            "CHANNEL_INTENT_REFUSED",
            { providerEventId: event.eventId, message, canonicalMutation: false },
            reason
        );
        return canonicalReason
            ? { ok: false, eventId, reason, message, canonicalReason }
            : { ok: false, eventId, reason, message };
    };

    // --- a delivery receipt is a network fact and stops here --------------
    if (event.receipt) {
        const eventId = await recordEvent(client, context, {
            providerEventId: event.eventId,
            senderHandle: event.from,
            authenticity: "VERIFIED",
            correlationToken: event.correlationToken,
            correlatedMessageId: event.messageId,
            resolvedIntent: `RECEIPT:${event.receipt}`,
            outcome: "ACCEPTED",
            reasonCode: null,
            requestId: null,
            // No action. There is no branch from here into a governed command.
            actionId: null,
            channel: event.channel
        });
        return {
            ok: true,
            value: {
                eventId,
                outcome: "ACCEPTED",
                intent: "RECEIPT",
                messageId: event.messageId,
                requestId: null,
                actionId: null,
                actionType: null,
                canonicalState: null
            }
        };
    }

    // --- 4. correlation --------------------------------------------------
    if (!event.correlationToken) {
        return refuse(
            "NO_CORRELATION",
            "no correlation token accompanied this message; a phone number is not a correlation"
        );
    }
    const message: ChannelMessage | null = await messageByToken(client, event.correlationToken);
    if (!message) {
        return refuse("CORRELATION_UNKNOWN", "the correlation token does not resolve to a message");
    }

    // --- 5. scope --------------------------------------------------------
    if (
        message.tenantId !== context.lineage.tenantId ||
        message.marketId !== context.lineage.marketId ||
        message.environment !== context.lineage.environment
    ) {
        return refuse(
            "CROSS_SCOPE_REFUSED",
            "the correlated message belongs to a different tenant, market or environment",
            { correlatedMessageId: message.messageId }
        );
    }

    // --- 6. actor --------------------------------------------------------
    const identity = await identityForChannelHandle(client, message.marketId, event.from);
    if (!identity) {
        return refuse(
            "NO_SENDER_IDENTITY",
            `sender ${event.from} does not resolve to a verified identity`,
            { correlatedMessageId: message.messageId }
        );
    }
    if (identity.identityId !== message.recipientIdentityId) {
        // Somebody who is not the addressee is holding this token.
        return refuse(
            "WRONG_RECIPIENT",
            "this message was addressed to a different party",
            { correlatedMessageId: message.messageId }
        );
    }

    // --- 7. intent -------------------------------------------------------
    if (!event.text) {
        return refuse("NO_CONSEQUENTIAL_INTENT", "the message carried no text", {
            correlatedMessageId: message.messageId
        });
    }
    const intent = classifyResponse(message.messageType, event.text);
    if (intent === "AMBIGUOUS") {
        return refuse(
            "AMBIGUOUS_FREE_TEXT",
            "ambiguous free text cannot bind a canonical state transition",
            { correlatedMessageId: message.messageId, resolvedIntent: intent }
        );
    }
    if (intent === "NONE") {
        return refuse("NO_CONSEQUENTIAL_INTENT", "no consequential intent was expressed", {
            correlatedMessageId: message.messageId,
            resolvedIntent: intent
        });
    }
    const actionType = actionFor(intent);
    if (!actionType) {
        return refuse("INTENT_NOT_APPLICABLE", `intent ${intent} has no governed action`, {
            correlatedMessageId: message.messageId,
            resolvedIntent: intent
        });
    }

    // --- 8. governed SCP action ------------------------------------------
    // Everything that matters is validated HERE, by Core: authority, the
    // predecessor state, whether the offer is still current, whether the
    // confirmation context was superseded, idempotency, audit. The channel
    // supplies an authenticated actor and a correlated object and nothing else.
    const payload: Record<string, unknown> =
        message.messageType === "PROVIDER_OFFER"
            ? { attemptId: message.offerId, providerId: null }
            : intent === "CUSTOMER_DECLINE"
              ? { reasonCode: "CUSTOMER_CANCELLED" }
              : {};

    const outcome: OperationalOutcome = await executeOperationalAction(client, {
        actionType,
        marketId: message.marketId as MarketId,
        requestId: message.requestId,
        // The identity the message was ADDRESSED to, re-derived from persisted
        // state. Never a value the sender supplied.
        actorIdentityId: identity.identityId,
        idempotencyKey: `channel:${event.eventId}`,
        payload,
        ...(context.now ? { effectiveAt: context.now } : {})
    });

    if (!outcome.ok) {
        const eventId = await recordEvent(client, context, {
            providerEventId: event.eventId,
            senderHandle: event.from,
            authenticity: "VERIFIED",
            correlationToken: event.correlationToken,
            correlatedMessageId: message.messageId,
            resolvedIntent: intent,
            outcome: "REFUSED",
            reasonCode: outcome.reasonCode,
            requestId: message.requestId,
            actionId: null,
            channel: event.channel
        });
        await evidence(
            client,
            context,
            "CHANNEL_INTENT_REFUSED",
            {
                providerEventId: event.eventId,
                messageId: message.messageId,
                intent,
                canonicalReason: outcome.reasonCode,
                canonicalMutation: false
            },
            outcome.reasonCode
        );
        return {
            ok: false,
            eventId,
            reason: "CANONICAL_REFUSAL",
            message: outcome.message,
            canonicalReason: outcome.reasonCode
        };
    }

    // --- 9. audit --------------------------------------------------------
    const eventId = await recordEvent(client, context, {
        providerEventId: event.eventId,
        senderHandle: event.from,
        authenticity: "VERIFIED",
        correlationToken: event.correlationToken,
        correlatedMessageId: message.messageId,
        resolvedIntent: intent,
        outcome: "ACCEPTED",
        reasonCode: null,
        requestId: message.requestId,
        actionId: outcome.actionId,
        channel: event.channel
    });
    await evidence(client, context, "CHANNEL_ACTION_INVOKED", {
        providerEventId: event.eventId,
        messageId: message.messageId,
        intent,
        actionType,
        actionId: outcome.actionId,
        toState: outcome.toState,
        // Stated in the record: the channel asked; Core decided.
        decidedBy: "SCP_ORCHESTRATOR"
    });
    await evidence(client, context, "CHANNEL_EVENT_ACCEPTED", {
        providerEventId: event.eventId,
        requestId: message.requestId,
        toState: outcome.toState
    });

    return {
        ok: true,
        value: {
            eventId,
            outcome: "ACCEPTED",
            intent,
            messageId: message.messageId,
            requestId: message.requestId,
            actionId: outcome.actionId,
            actionType,
            canonicalState: outcome.toState
        }
    };
}
