// Fixtures for the G5-G WhatsApp channel proofs.
//
// Composed from the real gates below: demand through G5-D, supply through
// G5-E, qualification/dispatch/assignment through G5-F, and the channel on top.
// Nothing inserts an offer, a confirmation context or a channel message
// directly, because the gate is about whether a real interaction can travel the
// governed path — a fixture that forged the path would prove nothing.
//
// No live messaging. The transport is the in-memory recording adapter, so
// nothing leaves the process and no real Freshline customer or provider is
// contacted.

import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { signPayload, SIGNATURE_HEADER } from "../../src/channel/authenticity";
import { startChannelHost, WEBHOOK_PATH, type ChannelHost } from "../../src/host/channelHost";
import { createRecordingTransport } from "../../src/adapters/spine/transports";
import type { TransportAdapter } from "../../src/adapters/spine/adapter";
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
} from "../owner/ownerTestDb";

export { SCOPE, createApprovedProvider, createDemand, ownerCall, recordProviderAcceptance };

/** Synthetic. Never a production credential. */
export const WEBHOOK_SECRET = "g5g-synthetic-webhook-secret";

export function getChannelPool(): Pool {
    return getOwnerPool();
}

export interface ChannelWorld extends OwnerWorld {
    channelHost: ChannelHost;
    recording: ReturnType<typeof createRecordingTransport>;
}

export async function bootChannelWorld(
    pool: Pool,
    options: { transport?: TransportAdapter; webhookSecret?: string } = {}
): Promise<ChannelWorld> {
    const world = await bootWorld(pool);
    const recording = createRecordingTransport("WHATSAPP");
    const outcome = await startChannelHost({
        pool,
        identity: {
            tenantId: SCOPE.tenantId,
            marketId: SCOPE.marketId,
            environment: SCOPE.environment
        },
        webhookSecret: options.webhookSecret === undefined ? WEBHOOK_SECRET : options.webhookSecret,
        transport: options.transport ?? recording
    });
    if (!outcome.ok) {
        throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    return { ...world, channelHost: outcome.host, recording };
}

export async function shutdownChannelWorld(world: ChannelWorld): Promise<void> {
    await world.channelHost.close();
    await shutdownWorld(world);
}

export interface Response {
    status: number;
    body: Record<string, unknown>;
}

/** Posts a webhook, signing the exact bytes the way the transport would. */
export async function webhook(
    world: ChannelWorld,
    payload: unknown,
    options: { secret?: string | null; signature?: string; rawBody?: string } = {}
): Promise<Response> {
    const raw = options.rawBody ?? JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.signature !== undefined) {
        headers[SIGNATURE_HEADER] = options.signature;
    } else if (options.secret !== null) {
        headers[SIGNATURE_HEADER] = signPayload(options.secret ?? WEBHOOK_SECRET, raw);
    }
    const response = await fetch(`${world.channelHost.origin}${WEBHOOK_PATH}`, {
        method: "POST",
        headers,
        body: raw
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

export async function channelOps(
    world: ChannelWorld,
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {}
): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = options.token === undefined ? world.ownerToken : options.token;
    if (token) {
        headers["x-owner-session"] = token;
    }
    const response = await fetch(`${world.channelHost.origin}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

let seq = 0;

export function eventId(prefix = "evt"): string {
    seq += 1;
    return `${prefix}-${seq}-${Math.abs(seq * 7919)}`;
}

/**
 * Drives a request all the way to an open dispatch offer through the real
 * gates, then sends the governed provider-offer message over the channel.
 */
export async function offerOnTheChannel(world: ChannelWorld): Promise<{
    requestId: string;
    providerId: string;
    providerIdentityId: string;
    providerHandle: string;
    offerId: string;
    messageId: string;
    correlationToken: string;
}> {
    const provider = await createApprovedProvider(world);
    const demand = await createDemand(world);
    await ownerCall(world, "POST", "/api/owner/qualify", {
        body: { requestId: demand.requestId, outcome: "SERVICEABLE" }
    });
    const dispatched = await ownerCall(world, "POST", "/api/owner/dispatch", {
        body: { requestId: demand.requestId, providerId: provider.providerId }
    });
    if (dispatched.status !== 200) {
        throw new Error(`dispatch failed: ${JSON.stringify(dispatched.body)}`);
    }
    const offer = await world.pool.query<{ offer_id: string }>(
        `SELECT offer_id FROM core_dispatch_offer WHERE request_id = $1 AND state = 'OFFERED'`,
        [demand.requestId]
    );
    const offerId = offer.rows[0]!.offer_id;

    const sent = await channelOps(world, "POST", "/api/operations/channel/provider-offer", {
        body: { offerId }
    });
    if (sent.status !== 200) {
        throw new Error(`offer message failed: ${JSON.stringify(sent.body)}`);
    }
    const message = sent.body["message"] as Record<string, string>;

    const handle = await world.pool.query<{ channel_handle: string }>(
        `SELECT i.channel_handle FROM core_provider p
           JOIN core_identity i ON i.identity_id = p.identity_id
          WHERE p.provider_id = $1`,
        [provider.providerId]
    );

    return {
        requestId: demand.requestId,
        providerId: provider.providerId,
        providerIdentityId: provider.providerIdentityId,
        providerHandle: handle.rows[0]!.channel_handle,
        offerId,
        messageId: message["messageId"]!,
        correlationToken: message["correlationToken"]!
    };
}

/**
 * Continues to an open customer-confirmation context and sends the governed
 * confirmation message over the channel.
 */
export async function confirmationOnTheChannel(world: ChannelWorld): Promise<{
    requestId: string;
    customerIdentityId: string;
    customerHandle: string;
    messageId: string;
    correlationToken: string;
    confirmationId: string;
}> {
    const offered = await offerOnTheChannel(world);
    await recordProviderAcceptance(
        world,
        offered.requestId,
        offered.providerIdentityId,
        offered.providerId
    );
    await ownerCall(world, "POST", "/api/owner/assign", {
        body: { requestId: offered.requestId, providerId: offered.providerId }
    });
    const asked = await ownerCall(world, "POST", "/api/owner/request-confirmation", {
        body: { requestId: offered.requestId }
    });
    if (asked.status !== 200) {
        throw new Error(`confirmation request failed: ${JSON.stringify(asked.body)}`);
    }

    const sent = await channelOps(world, "POST", "/api/operations/channel/customer-confirmation", {
        body: { requestId: offered.requestId }
    });
    if (sent.status !== 200) {
        throw new Error(`confirmation message failed: ${JSON.stringify(sent.body)}`);
    }
    const message = sent.body["message"] as Record<string, string>;

    const customer = await world.pool.query<{ identity_id: string; channel_handle: string }>(
        `SELECT i.identity_id, i.channel_handle
           FROM core_service_request r
           JOIN core_identity i ON i.identity_id = r.customer_identity_id
          WHERE r.request_id = $1`,
        [offered.requestId]
    );

    return {
        requestId: offered.requestId,
        customerIdentityId: customer.rows[0]!.identity_id,
        customerHandle: customer.rows[0]!.channel_handle,
        messageId: message["messageId"]!,
        correlationToken: message["correlationToken"]!,
        confirmationId: message["confirmationId"]!
    };
}

export async function stateOf(pool: Pool, requestId: string): Promise<string> {
    const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM core_service_request WHERE request_id = $1`,
        [requestId]
    );
    return rows[0]!.state;
}

export async function count(
    pool: Pool,
    table: string,
    where = "TRUE",
    params: unknown[] = []
): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params
    );
    return Number(rows[0]!.n);
}

export { withTransaction };
