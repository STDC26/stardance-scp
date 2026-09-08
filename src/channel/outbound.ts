// SCP-G5-G — governed outbound channel communication.
//
// A message may only exist because canonical SCP truth already does. This
// module reads an existing offer or confirmation context, records the intent to
// communicate, hands the bytes to a replaceable transport, and records what the
// transport said.
//
// The status column tracks the NETWORK and nothing else:
//
//   CREATED      SCP authorized a communication
//   SENT         the transport accepted it
//   SEND_FAILED  the transport refused it — and the business object is untouched
//   DELIVERED    the network says it arrived
//   READ         the network says it was opened
//
// None of those is agreement. A provider who reads an offer has not accepted
// it, and there is no column here in which that could be recorded, which is why
// a delivery receipt cannot fabricate a business outcome.

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { AdapterSpine } from "../adapters/spine/adapter";
import { recordRuntimeEvidence } from "../runtime/evidence";
import type { IdentityLineage } from "../runtime/identity";

export type ChannelMessageType = "PROVIDER_OFFER" | "CUSTOMER_CONFIRMATION_REQUEST";
export type ChannelMessageStatus = "CREATED" | "SENT" | "SEND_FAILED" | "DELIVERED" | "READ";

export interface ChannelMessage {
    messageId: string;
    tenantId: string;
    marketId: string;
    environment: string;
    channel: string;
    messageType: ChannelMessageType;
    requestId: string;
    offerId: string | null;
    confirmationId: string | null;
    recipientIdentityId: string;
    recipientHandle: string;
    correlationToken: string;
    body: string;
    status: ChannelMessageStatus;
    attempt: number;
    externalMessageId: string | null;
    failureCode: string | null;
}

const COLUMNS = `message_id, tenant_id, market_id, environment, channel, message_type,
                 request_id, offer_id, confirmation_id, recipient_identity_id,
                 recipient_handle, correlation_token, body, status, attempt,
                 external_message_id, failure_code`;

function toMessage(row: Record<string, unknown>): ChannelMessage {
    return {
        messageId: row["message_id"] as string,
        tenantId: row["tenant_id"] as string,
        marketId: row["market_id"] as string,
        environment: row["environment"] as string,
        channel: row["channel"] as string,
        messageType: row["message_type"] as ChannelMessageType,
        requestId: row["request_id"] as string,
        offerId: (row["offer_id"] as string | null) ?? null,
        confirmationId: (row["confirmation_id"] as string | null) ?? null,
        recipientIdentityId: row["recipient_identity_id"] as string,
        recipientHandle: row["recipient_handle"] as string,
        correlationToken: row["correlation_token"] as string,
        body: row["body"] as string,
        status: row["status"] as ChannelMessageStatus,
        attempt: row["attempt"] as number,
        externalMessageId: (row["external_message_id"] as string | null) ?? null,
        failureCode: (row["failure_code"] as string | null) ?? null
    };
}

/** 256 bits from the OS CSPRNG. A correlation token is not guessable. */
export function newCorrelationToken(): string {
    return randomBytes(24).toString("base64url");
}

export async function loadMessage(
    client: PoolClient,
    messageId: string
): Promise<ChannelMessage | null> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_channel_message WHERE message_id = $1`,
        [messageId]
    );
    return rows[0] ? toMessage(rows[0]) : null;
}

export async function messageByToken(
    client: PoolClient,
    correlationToken: string
): Promise<ChannelMessage | null> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_channel_message WHERE correlation_token = $1`,
        [correlationToken]
    );
    return rows[0] ? toMessage(rows[0]) : null;
}

export async function messagesForRequest(
    client: PoolClient,
    requestId: string
): Promise<ChannelMessage[]> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_channel_message WHERE request_id = $1
          ORDER BY created_at ASC`,
        [requestId]
    );
    return rows.map(toMessage);
}

export type OutboundFailure =
    | "OFFER_NOT_CURRENT"
    | "CONFIRMATION_NOT_CURRENT"
    | "NO_RECIPIENT_HANDLE";

export type OutboundOutcome =
    | { ok: true; message: ChannelMessage; transported: boolean; failureCode: string | null }
    | { ok: false; code: OutboundFailure; message: string };

interface SendContext {
    lineage: IdentityLineage;
    adapters: AdapterSpine;
    channel: string;
    configurationVersion: number;
    configurationChecksum: string;
    correlationId: string;
}

async function persistAndSend(
    client: PoolClient,
    context: SendContext,
    draft: {
        messageType: ChannelMessageType;
        requestId: string;
        offerId: string | null;
        confirmationId: string | null;
        recipientIdentityId: string;
        recipientHandle: string;
        body: string;
    }
): Promise<OutboundOutcome> {
    const correlationToken = newCorrelationToken();
    const inserted = await client.query(
        `INSERT INTO core_channel_message
            (tenant_id, market_id, environment, channel, message_type, request_id,
             offer_id, confirmation_id, recipient_identity_id, recipient_handle,
             correlation_token, body, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CREATED')
         RETURNING ${COLUMNS}`,
        [
            context.lineage.tenantId,
            context.lineage.marketId,
            context.lineage.environment,
            context.channel,
            draft.messageType,
            draft.requestId,
            draft.offerId,
            draft.confirmationId,
            draft.recipientIdentityId,
            draft.recipientHandle,
            correlationToken,
            draft.body
        ]
    );
    let message = toMessage(inserted.rows[0]!);

    await recordRuntimeEvidence(client, {
        kind: "CHANNEL_MESSAGE_CREATED",
        lineage: context.lineage,
        outcome: "OK",
        configurationVersion: context.configurationVersion,
        configurationChecksum: context.configurationChecksum,
        detail: {
            correlationId: context.correlationId,
            messageId: message.messageId,
            messageType: message.messageType,
            requestId: message.requestId,
            // Stated in the record: authorizing a message is not an outcome.
            advancesCanonicalState: false
        }
    });

    // The transport is asked AFTER the intent is durable, so a crash mid-send
    // leaves a CREATED message to reconcile rather than nothing at all.
    const result = await context.adapters.send(
        context.channel,
        {
            correlationId: context.correlationId,
            idempotencyKey: `${message.messageId}:send`,
            lineage: context.lineage
        },
        {
            channel: context.channel,
            recipientHandle: draft.recipientHandle,
            body: draft.body
        }
    );

    if (result.transported) {
        const updated = await client.query(
            `UPDATE core_channel_message
                SET status = 'SENT', sent_at = now(), external_message_id = $2
              WHERE message_id = $1
          RETURNING ${COLUMNS}`,
            [message.messageId, result.externalReference]
        );
        message = toMessage(updated.rows[0]!);
        await recordRuntimeEvidence(client, {
            kind: "CHANNEL_MESSAGE_SENT",
            lineage: context.lineage,
            outcome: "OK",
            configurationVersion: context.configurationVersion,
            configurationChecksum: context.configurationChecksum,
            detail: {
                correlationId: context.correlationId,
                messageId: message.messageId,
                externalMessageId: result.externalReference,
                advancesCanonicalState: result.advancesCanonicalState
            }
        });
        return { ok: true, message, transported: true, failureCode: null };
    }

    // A send failure is a TRANSPORT fact. The offer or confirmation context it
    // was about is deliberately left exactly as it was.
    const failed = await client.query(
        `UPDATE core_channel_message
            SET status = 'SEND_FAILED', failure_code = $2
          WHERE message_id = $1
      RETURNING ${COLUMNS}`,
        [message.messageId, result.code]
    );
    message = toMessage(failed.rows[0]!);
    await recordRuntimeEvidence(client, {
        kind: "CHANNEL_SEND_FAILED",
        lineage: context.lineage,
        outcome: "REFUSED",
        reasonCode: result.code,
        configurationVersion: context.configurationVersion,
        configurationChecksum: context.configurationChecksum,
        detail: {
            correlationId: context.correlationId,
            messageId: message.messageId,
            message: result.message,
            // The originating business object is untouched by a failed send.
            canonicalObjectAltered: false
        }
    });
    return { ok: true, message, transported: false, failureCode: result.code };
}

/**
 * Communicates an existing SCP dispatch offer to its provider.
 *
 * The message may communicate the offer; it may not create one. If the offer is
 * not currently open, there is nothing to communicate and nothing is sent.
 */
export async function sendProviderOfferMessage(
    client: PoolClient,
    context: SendContext,
    offerId: string
): Promise<OutboundOutcome> {
    const { rows } = await client.query<{
        offer_id: string;
        request_id: string;
        provider_id: string;
        state: string;
        market_id: string;
        identity_id: string;
        channel_handle: string | null;
        expires_at: Date;
    }>(
        `SELECT o.offer_id, o.request_id, o.provider_id, o.state::text AS state, o.market_id,
                p.identity_id, i.channel_handle, o.expires_at
           FROM core_dispatch_offer o
           JOIN core_provider p ON p.provider_id = o.provider_id
           JOIN core_identity i ON i.identity_id = p.identity_id
          WHERE o.offer_id = $1`,
        [offerId]
    );
    const offer = rows[0];
    if (!offer || offer.state !== "OFFERED" || offer.market_id !== context.lineage.marketId) {
        return {
            ok: false,
            code: "OFFER_NOT_CURRENT",
            message: `offer ${offerId} is not a currently open offer in this market`
        };
    }
    if (!offer.channel_handle) {
        return {
            ok: false,
            code: "NO_RECIPIENT_HANDLE",
            message: "the provider has no verified channel handle to message"
        };
    }

    return persistAndSend(client, context, {
        messageType: "PROVIDER_OFFER",
        requestId: offer.request_id,
        offerId: offer.offer_id,
        confirmationId: null,
        recipientIdentityId: offer.identity_id,
        recipientHandle: offer.channel_handle,
        body:
            `New Freshline job. Reply ACCEPT or DECLINE.\n` +
            `Ref ${offer.offer_id}\n` +
            `Respond by ${offer.expires_at.toISOString()}`
    });
}

/**
 * Communicates an existing SCP customer-confirmation request to its customer.
 *
 * The message does not open confirmation eligibility — the governed
 * confirmation context already did, and if there is no live one there is
 * nothing to ask about.
 */
export async function sendCustomerConfirmationMessage(
    client: PoolClient,
    context: SendContext,
    requestId: string
): Promise<OutboundOutcome> {
    const { rows } = await client.query<{
        confirmation_id: string;
        request_id: string;
        status: string;
        market_id: string;
        customer_identity_id: string;
        channel_handle: string | null;
        state: string;
    }>(
        `SELECT c.confirmation_id, c.request_id, c.status::text AS status,
                r.market_id, r.customer_identity_id, i.channel_handle, r.state::text AS state
           FROM core_customer_confirmation c
           JOIN core_service_request r ON r.request_id = c.request_id
           JOIN core_identity i ON i.identity_id = r.customer_identity_id
          WHERE c.request_id = $1 AND c.status = 'PENDING'
          ORDER BY c.context_version DESC
          LIMIT 1`,
        [requestId]
    );
    const context_ = rows[0];
    if (!context_ || context_.market_id !== context.lineage.marketId) {
        return {
            ok: false,
            code: "CONFIRMATION_NOT_CURRENT",
            message: `request ${requestId} has no live customer-confirmation context in this market`
        };
    }
    if (!context_.channel_handle) {
        return {
            ok: false,
            code: "NO_RECIPIENT_HANDLE",
            message: "the customer has no verified channel handle to message"
        };
    }

    return persistAndSend(client, context, {
        messageType: "CUSTOMER_CONFIRMATION_REQUEST",
        requestId: context_.request_id,
        offerId: null,
        confirmationId: context_.confirmation_id,
        recipientIdentityId: context_.customer_identity_id,
        recipientHandle: context_.channel_handle,
        body:
            `Your Freshline booking is ready to confirm. Reply CONFIRM or DECLINE.\n` +
            `Ref ${context_.confirmation_id}`
    });
}

/**
 * Records a delivery or read receipt.
 *
 * Deliberately touches nothing but this row. There is no branch here that could
 * reach a Service-Commerce object, which is what makes "a receipt cannot
 * fabricate a business outcome" a property of the code rather than a promise.
 */
export async function recordDeliveryReceipt(
    client: PoolClient,
    context: Omit<SendContext, "adapters" | "channel">,
    messageId: string,
    receipt: "DELIVERED" | "READ"
): Promise<ChannelMessage | null> {
    const { rows } = await client.query(
        `UPDATE core_channel_message
            SET status = $2,
                delivered_at = COALESCE(delivered_at, now())
          WHERE message_id = $1 AND status IN ('SENT', 'DELIVERED', 'READ')
      RETURNING ${COLUMNS}`,
        [messageId, receipt]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    await recordRuntimeEvidence(client, {
        kind: "CHANNEL_DELIVERY_RECEIPT",
        lineage: context.lineage,
        outcome: "OK",
        configurationVersion: context.configurationVersion,
        configurationChecksum: context.configurationChecksum,
        detail: {
            correlationId: context.correlationId,
            messageId,
            receipt,
            // A receipt is a network fact. Stated here so the audit trail says
            // so in its own words.
            advancesCanonicalState: false
        }
    });
    return toMessage(row);
}
