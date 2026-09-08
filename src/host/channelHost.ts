// SCP-G5-G — the bounded channel host.
//
// A transport over the G5-C runtime spine, exactly as the customer, partner and
// owner hosts are. It starts by calling `startRuntime` and never listens if
// that refuses.
//
// Two planes with very different trust:
//
//   POST /webhooks/whatsapp    unauthenticated by session, authenticated by
//                              HMAC over the RAW body. Everything consequential
//                              downstream is re-derived from persisted state.
//   /api/operations/channel/*  requires an OWNER session, reusing the same
//                              server-verified session machinery G5-E built.
//
// The webhook handler buffers the raw bytes and verifies the signature over
// exactly those bytes before parsing. Verifying a re-serialized object would
// let a payload the sender never sent pass a signature the sender did make.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { startRuntime, type RuntimeContext, type StartupFailureCode } from "../runtime/bootstrap";
import { lineageOf, type IdentityInput } from "../runtime/identity";
import { AdapterSpine, type TransportAdapter } from "../adapters/spine/adapter";
import { createRecordingTransport } from "../adapters/spine/transports";
import { resolveSession } from "../provider/session";
import { SIGNATURE_HEADER, verifyWebhook } from "../channel/authenticity";
import { ingestChannelEvent, type IngressContext } from "../channel/ingress";
import {
    messagesForRequest,
    recordDeliveryReceipt,
    sendCustomerConfirmationMessage,
    sendProviderOfferMessage
} from "../channel/outbound";
import { channelHttpStatus, type ChannelReason } from "../channel/reasons";

export const WEBHOOK_PATH = "/webhooks/whatsapp";
export const CHANNEL = "WHATSAPP";

const MAX_BODY_BYTES = 128 * 1024;

export interface ChannelHostInput {
    pool: Pool;
    identity: IdentityInput;
    port?: number;
    /**
     * Webhook signing secret. Synthetic/test only — no production credential is
     * authorized for this gate. Absent means inbound events are refused
     * WEBHOOK_NOT_CONFIGURED rather than accepted unsigned.
     */
    webhookSecret?: string;
    /**
     * The outbound transport. Defaults to the in-memory recording transport, so
     * nothing leaves the process and no real Freshline customer or provider is
     * ever contacted by this build.
     */
    transport?: TransportAdapter;
}

export interface ChannelHost {
    server: Server;
    runtime: RuntimeContext;
    port: number;
    origin: string;
    /** The registered transport, so tests can inspect what was sent. */
    transport: TransportAdapter;
    close(): Promise<void>;
}

export type ChannelHostOutcome =
    | { ok: true; host: ChannelHost }
    | { ok: false; code: StartupFailureCode; message: string };

function json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
    });
    response.end(payload);
}

/** Buffers the exact bytes. Signature verification depends on them. */
async function readRaw(
    request: IncomingMessage
): Promise<{ ok: true; body: Buffer } | { ok: false; message: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            return { ok: false, message: "request body exceeds the accepted size" };
        }
        chunks.push(buffer);
    }
    return { ok: true, body: Buffer.concat(chunks) };
}

export async function startChannelHost(input: ChannelHostInput): Promise<ChannelHostOutcome> {
    const started = await startRuntime({ pool: input.pool, identity: input.identity });
    if (!started.ok) {
        return { ok: false, code: started.code, message: started.message };
    }
    const runtime = started.runtime;

    // Synthetic by default. The recording transport is the G5-C boundary
    // reused unchanged: substituting it changes what leaves the process and
    // nothing about SCP truth.
    const transport = input.transport ?? createRecordingTransport(CHANNEL);
    const adapters = new AdapterSpine().register(transport);

    const server = createServer((request, response) => {
        handle(input, runtime, adapters, request, response).catch(() => {
            json(response, 500, { error: "INTERNAL", message: "the request could not be completed" });
        });
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port ?? 0, "127.0.0.1", () => {
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
    });

    return {
        ok: true,
        host: {
            server,
            runtime,
            port,
            origin: `http://127.0.0.1:${port}`,
            transport,
            close: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                })
        }
    };
}

function ownerToken(request: IncomingMessage): string | undefined {
    const value = request.headers["x-owner-session"];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function requireOwner(
    client: PoolClient,
    runtime: RuntimeContext,
    request: IncomingMessage
): Promise<{ ok: true; identityId: string } | { ok: false; status: number; message: string }> {
    const resolved = await resolveSession(client, ownerToken(request), lineageOf(runtime.identity));
    if (!resolved.ok) {
        return { ok: false, status: 401, message: resolved.message };
    }
    if (resolved.session.role !== "OWNER") {
        return { ok: false, status: 403, message: "this command requires an Owner session" };
    }
    return { ok: true, identityId: resolved.session.identityId };
}

function sendContext(runtime: RuntimeContext, adapters: AdapterSpine, correlationId: string) {
    return {
        lineage: lineageOf(runtime.identity),
        adapters,
        channel: CHANNEL,
        configurationVersion: runtime.configuration.provenance.configurationVersion,
        configurationChecksum: runtime.configuration.provenance.checksum,
        correlationId
    };
}

async function handle(
    input: ChannelHostInput,
    runtime: RuntimeContext,
    adapters: AdapterSpine,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const correlationId = randomUUID();
    const pool = input.pool;

    if (method === "GET" && path === "/healthz") {
        json(response, 200, {
            status: "SERVING",
            surface: "CHANNEL",
            channel: CHANNEL,
            configuration: runtime.describe(),
            transport: adapters.channels()
        });
        return;
    }

    // ---- the webhook --------------------------------------------------
    if (path === WEBHOOK_PATH) {
        if (method !== "POST") {
            json(response, 405, { error: "METHOD_NOT_ALLOWED", message: "use POST" });
            return;
        }
        const raw = await readRaw(request);
        if (!raw.ok) {
            json(response, 400, { error: "PAYLOAD_MALFORMED", message: raw.message });
            return;
        }

        // Authenticity, over the exact bytes, before anything is parsed.
        const presented = request.headers[SIGNATURE_HEADER];
        const verified = verifyWebhook(
            input.webhookSecret,
            raw.body,
            typeof presented === "string" ? presented : undefined
        );

        let parsedBody: unknown = {};
        try {
            parsedBody = raw.body.length > 0 ? JSON.parse(raw.body.toString("utf8")) : {};
        } catch {
            parsedBody = null;
        }

        const context: IngressContext = {
            lineage: lineageOf(runtime.identity),
            configurationVersion: runtime.configuration.provenance.configurationVersion,
            configurationChecksum: runtime.configuration.provenance.checksum,
            correlationId,
            authenticity: verified.ok
                ? { ok: true }
                : { ok: false, code: verified.code as ChannelReason, message: verified.message },
            rawBody: raw.body
        };

        const outcome = await withTransaction(pool, async (client) => {
            const ingested = await ingestChannelEvent(client, context, parsedBody);
            // A verified delivery receipt also advances the outbound row, which
            // is a transport fact and touches no business object.
            if (
                ingested.ok &&
                ingested.value.intent === "RECEIPT" &&
                ingested.value.messageId &&
                typeof parsedBody === "object" &&
                parsedBody !== null
            ) {
                const receipt = (parsedBody as Record<string, unknown>)["receipt"];
                if (receipt === "DELIVERED" || receipt === "READ") {
                    await recordDeliveryReceipt(
                        client,
                        {
                            lineage: context.lineage,
                            configurationVersion: context.configurationVersion,
                            configurationChecksum: context.configurationChecksum,
                            correlationId
                        },
                        ingested.value.messageId,
                        receipt
                    );
                }
            }
            return ingested;
        });

        if (outcome.ok) {
            json(response, 200, { ...outcome.value, correlationId });
            return;
        }
        json(response, channelHttpStatus(outcome.reason), {
            error: outcome.reason,
            message: outcome.message,
            ...(outcome.canonicalReason ? { canonicalReason: outcome.canonicalReason } : {}),
            findings: outcome.findings ?? [],
            eventId: outcome.eventId,
            correlationId
        });
        return;
    }

    // ---- operations plane ---------------------------------------------
    if (path.startsWith("/api/operations/channel/")) {
        const raw = await readRaw(request);
        if (!raw.ok) {
            json(response, 400, { error: "PAYLOAD_MALFORMED", message: raw.message });
            return;
        }
        let body: Record<string, unknown> = {};
        if (raw.body.length > 0) {
            try {
                body = JSON.parse(raw.body.toString("utf8")) as Record<string, unknown>;
            } catch {
                json(response, 400, { error: "PAYLOAD_MALFORMED", message: "body is not valid JSON" });
                return;
            }
        }

        const result = await withTransaction(pool, async (client) => {
            const auth = await requireOwner(client, runtime, request);
            if (!auth.ok) {
                return { kind: "REFUSED" as const, status: auth.status, message: auth.message };
            }

            if (method === "GET" && path === "/api/operations/channel/messages") {
                const requestId = url.searchParams.get("requestId");
                if (!requestId) {
                    return { kind: "REFUSED" as const, status: 422, message: "requestId is required" };
                }
                return {
                    kind: "DATA" as const,
                    body: { messages: await messagesForRequest(client, requestId) }
                };
            }
            if (method !== "POST") {
                return { kind: "NOT_FOUND" as const };
            }

            if (path === "/api/operations/channel/provider-offer") {
                const offerId = body["offerId"];
                if (typeof offerId !== "string") {
                    return { kind: "REFUSED" as const, status: 422, message: "offerId is required" };
                }
                const sent = await sendProviderOfferMessage(
                    client,
                    sendContext(runtime, adapters, correlationId),
                    offerId
                );
                return sent.ok
                    ? { kind: "DATA" as const, body: { message: sent.message, transported: sent.transported, failureCode: sent.failureCode } }
                    : { kind: "REFUSED" as const, status: 422, message: sent.message, code: sent.code };
            }
            if (path === "/api/operations/channel/customer-confirmation") {
                const requestId = body["requestId"];
                if (typeof requestId !== "string") {
                    return { kind: "REFUSED" as const, status: 422, message: "requestId is required" };
                }
                const sent = await sendCustomerConfirmationMessage(
                    client,
                    sendContext(runtime, adapters, correlationId),
                    requestId
                );
                return sent.ok
                    ? { kind: "DATA" as const, body: { message: sent.message, transported: sent.transported, failureCode: sent.failureCode } }
                    : { kind: "REFUSED" as const, status: 422, message: sent.message, code: sent.code };
            }
            return { kind: "NOT_FOUND" as const };
        });

        if (result.kind === "REFUSED") {
            json(response, result.status, {
                error: (result as { code?: string }).code ?? "REFUSED",
                message: result.message,
                correlationId
            });
            return;
        }
        if (result.kind === "NOT_FOUND") {
            json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
            return;
        }
        json(response, 200, { ...result.body, correlationId });
        return;
    }

    json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
}
