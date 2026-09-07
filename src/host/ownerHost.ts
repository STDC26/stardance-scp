// SCP-G5-F — the bounded Freshline Owner host.
//
// A transport over the G5-C runtime spine, exactly as the customer and partner
// hosts are. It has no configuration loader, no tenant identity of its own, no
// persistence layer and no lifecycle opinion. It starts by calling
// `startRuntime`, and if that refuses the host never listens.
//
// Every route under /api/owner requires an OWNER session, resolved by the same
// server-verified session machinery G5-E established. A PROVIDER session is
// refused before any body is read, because the role is read from the database
// and there is no field a holder can send that widens it.
//
// The host contains no operational logic whatsoever. Reads go to the
// projections in src/owner; writes go to the command boundary, which goes to
// the G4 orchestrator. Nothing here decides anything.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { startRuntime, type RuntimeContext, type StartupFailureCode } from "../runtime/bootstrap";
import { lineageOf, type IdentityInput } from "../runtime/identity";
import { recordRuntimeEvidence } from "../runtime/evidence";
import { resolveSession, type ResolvedSession } from "../provider/session";
// Reused rather than reimplemented: minting Owner authority is one governed act
// and it should have one implementation, wherever the operator happens to be
// standing.
import { issueOwnerSession } from "./partnerHost";
import { ownerQueue, ownerRequestDetail, type OwnerQueueScope } from "../owner/queue";
import { strictMatch, supplySnapshot } from "../owner/matching";
import {
    assignProviderCommand,
    cancelRequest,
    dispatchProvider,
    fulfillmentCommand,
    qualifyRequest,
    requestCustomerConfirmation,
    type OwnerCommandContext,
    type OwnerCommandOutcome
} from "../owner/commands";
import { ownerHttpStatus, type OwnerReason } from "../owner/reasons";
import { buildOwnerProjection, renderOwnerConsole } from "./ownerPage";

export const OWNER_SESSION_HEADER = "x-owner-session";

const MAX_JSON_BYTES = 64 * 1024;

export interface OwnerHostInput {
    pool: Pool;
    identity: IdentityInput;
    port?: number;
}

export interface OwnerHost {
    server: Server;
    runtime: RuntimeContext;
    port: number;
    origin: string;
    close(): Promise<void>;
}

export type OwnerHostOutcome =
    | { ok: true; host: OwnerHost }
    | { ok: false; code: StartupFailureCode; message: string };

export { issueOwnerSession };

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

function html(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
    });
    response.end(body);
}

async function readJson(
    request: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_JSON_BYTES) {
            return { ok: false, message: "request body exceeds the accepted size" };
        }
        chunks.push(buffer);
    }
    if (size === 0) {
        return { ok: true, value: {} };
    }
    try {
        return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
        return { ok: false, message: "request body is not valid JSON" };
    }
}

export async function startOwnerHost(input: OwnerHostInput): Promise<OwnerHostOutcome> {
    const started = await startRuntime({ pool: input.pool, identity: input.identity });
    if (!started.ok) {
        return { ok: false, code: started.code, message: started.message };
    }
    const runtime = started.runtime;

    const server = createServer((request, response) => {
        handle(input.pool, runtime, request, response).catch(() => {
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
            close: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                })
        }
    };
}

function sessionToken(request: IncomingMessage): string | undefined {
    const value = request.headers[OWNER_SESSION_HEADER];
    if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
    }
    const auth = request.headers["authorization"];
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }
    return undefined;
}

/**
 * Resolves an OWNER session, or refuses.
 *
 * The role comes from the database row the token resolves to. A header, a body
 * field or a query parameter claiming OWNER reaches nothing.
 */
async function requireOwner(
    client: PoolClient,
    runtime: RuntimeContext,
    request: IncomingMessage
): Promise<
    { ok: true; session: ResolvedSession } | { ok: false; reason: OwnerReason; message: string }
> {
    const resolved = await resolveSession(client, sessionToken(request), lineageOf(runtime.identity));
    if (!resolved.ok) {
        return {
            ok: false,
            reason: resolved.code === "SESSION_SCOPE_MISMATCH" ? "SESSION_SCOPE_MISMATCH" : "SESSION_INVALID",
            message: resolved.message
        };
    }
    if (resolved.session.role !== "OWNER") {
        return {
            ok: false,
            reason: "OWNER_AUTHORITY_REQUIRED",
            message: "this command requires an Owner session"
        };
    }
    return { ok: true, session: resolved.session };
}

function scopeOf(runtime: RuntimeContext): OwnerQueueScope {
    return lineageOf(runtime.identity);
}

function contextFor(
    runtime: RuntimeContext,
    session: ResolvedSession,
    correlationId: string
): OwnerCommandContext {
    return {
        configuration: runtime.configuration,
        ownerIdentityId: session.identityId,
        correlationId
    };
}

function respond(response: ServerResponse, outcome: OwnerCommandOutcome, correlationId: string): void {
    if (outcome.ok) {
        json(response, 200, { ...outcome.value, correlationId });
        return;
    }
    json(response, ownerHttpStatus(outcome.reason), {
        error: outcome.reason,
        message: outcome.message,
        findings: outcome.findings ?? [],
        ...(outcome.canonicalReason ? { canonicalReason: outcome.canonicalReason } : {}),
        correlationId
    });
}

async function handle(
    pool: Pool,
    runtime: RuntimeContext,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const correlationId = randomUUID();

    if (method === "GET" && path === "/healthz") {
        json(response, 200, {
            status: "SERVING",
            surface: "OWNER",
            configuration: runtime.describe(),
            requiredRelations: runtime.schema.present.length
        });
        return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
        html(response, 200, renderOwnerConsole(buildOwnerProjection(runtime.configuration)));
        return;
    }

    if (!path.startsWith("/api/owner/")) {
        json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
        return;
    }

    const detailMatch = path.match(/^\/api\/owner\/requests\/([0-9a-fA-F-]{36})(\/supply|\/match)?$/);

    const result = await withTransaction(pool, async (client) => {
        const auth = await requireOwner(client, runtime, request);
        if (!auth.ok) {
            await recordRuntimeEvidence(client, {
                kind: "OWNER_COMMAND_REFUSED",
                lineage: lineageOf(runtime.identity),
                outcome: "REFUSED",
                reasonCode: auth.reason,
                configurationVersion: runtime.configuration.provenance.configurationVersion,
                configurationChecksum: runtime.configuration.provenance.checksum,
                detail: { correlationId, path, method }
            });
            return { kind: "REFUSED" as const, reason: auth.reason, message: auth.message };
        }
        const session = auth.session;
        const context = contextFor(runtime, session, correlationId);

        // ---- reads --------------------------------------------------------
        if (method === "GET" && path === "/api/owner/queue") {
            const includeClosed = url.searchParams.get("includeClosed") === "true";
            const limitParam = Number(url.searchParams.get("limit") ?? "100");
            return {
                kind: "DATA" as const,
                body: {
                    queue: await ownerQueue(client, scopeOf(runtime), {
                        includeClosed,
                        limit: Number.isFinite(limitParam) ? limitParam : 100
                    })
                }
            };
        }
        if (method === "GET" && detailMatch) {
            const requestId = detailMatch[1]!;
            const entry = await ownerRequestDetail(client, scopeOf(runtime), requestId);
            if (!entry) {
                return {
                    kind: "REFUSED" as const,
                    reason: "REQUEST_UNKNOWN" as OwnerReason,
                    message: "no such request in this market"
                };
            }
            if (detailMatch[2] === "/supply") {
                const snapshot = await supplySnapshot(client, runtime.configuration, entry);
                await recordRuntimeEvidence(client, {
                    kind: "OWNER_SUPPLY_SYNCHRONIZED",
                    lineage: lineageOf(runtime.identity),
                    outcome: "OK",
                    configurationVersion: runtime.configuration.provenance.configurationVersion,
                    configurationChecksum: runtime.configuration.provenance.checksum,
                    detail: {
                        correlationId,
                        requestId,
                        approvedCount: snapshot.approvedCount,
                        coveringCount: snapshot.coveringCount
                    }
                });
                return { kind: "DATA" as const, body: { request: entry, supply: snapshot } };
            }
            if (detailMatch[2] === "/match") {
                const evaluated = await strictMatch(client, runtime.configuration, entry);
                if ("ok" in evaluated) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "NO_ELIGIBLE_MATCH" as OwnerReason,
                        message: evaluated.message
                    };
                }
                return {
                    kind: "DATA" as const,
                    body: {
                        request: entry,
                        match: evaluated.match,
                        outcome: evaluated.evaluation.outcome,
                        reasonCode: evaluated.reasonCode,
                        alternatives: evaluated.evaluation.alternatives,
                        supply: evaluated.supply
                    }
                };
            }
            return { kind: "DATA" as const, body: { request: entry } };
        }

        // ---- commands -----------------------------------------------------
        if (method !== "POST") {
            return { kind: "NOT_FOUND" as const };
        }
        const body = await readJson(request);
        if (!body.ok) {
            return { kind: "MALFORMED" as const, message: body.message };
        }

        switch (path) {
            case "/api/owner/qualify":
                return { kind: "COMMAND" as const, outcome: await qualifyRequest(client, context, body.value) };
            case "/api/owner/dispatch":
                return { kind: "COMMAND" as const, outcome: await dispatchProvider(client, context, body.value) };
            case "/api/owner/assign":
                return {
                    kind: "COMMAND" as const,
                    outcome: await assignProviderCommand(client, context, body.value)
                };
            case "/api/owner/request-confirmation":
                return {
                    kind: "COMMAND" as const,
                    outcome: await requestCustomerConfirmation(client, context, body.value)
                };
            case "/api/owner/cancel":
                return { kind: "COMMAND" as const, outcome: await cancelRequest(client, context, body.value) };
            case "/api/owner/start-fulfillment":
                return {
                    kind: "COMMAND" as const,
                    outcome: await fulfillmentCommand(client, context, "START_FULFILLMENT", body.value)
                };
            case "/api/owner/complete-service":
                return {
                    kind: "COMMAND" as const,
                    outcome: await fulfillmentCommand(client, context, "COMPLETE_SERVICE", body.value)
                };
            default:
                return { kind: "NOT_FOUND" as const };
        }
    });

    if (result.kind === "REFUSED") {
        json(response, ownerHttpStatus(result.reason), {
            error: result.reason,
            message: result.message,
            correlationId
        });
        return;
    }
    if (result.kind === "MALFORMED") {
        json(response, 400, { error: "MALFORMED_BODY", message: result.message });
        return;
    }
    if (result.kind === "NOT_FOUND") {
        json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
        return;
    }
    if (result.kind === "DATA") {
        json(response, 200, { ...result.body, correlationId });
        return;
    }
    respond(response, result.outcome, correlationId);
}
