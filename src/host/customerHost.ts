// SCP-G5-D — the bounded Freshline customer host.
//
// This is a TRANSPORT over the G5-C runtime spine, and nothing else. It has no
// configuration loader, no tenant identity of its own, no persistence layer and
// no lifecycle opinion. It starts by calling `startRuntime`, and if that refuses
// — unreachable database, incompatible schema, missing identity, no active or
// invalid configuration — the host never listens. There is no degraded mode and
// no in-memory fallback, because a customer surface that accepts bookings it
// cannot persist is worse than one that is down.
//
// R21 (bounded customer host over the runtime spine) is addressed here: the ONLY
// path to a serving process runs through `startRuntime`, so a second
// runtime/configuration/identity/persistence truth path cannot be constructed
// without deleting this file's first statement.
//
// Ordering that matters: the canonical Service Request is committed BEFORE any
// channel handoff is attempted. WhatsApp is offered the message afterwards, its
// result is recorded as operational evidence, and it changes nothing — a failed
// handoff leaves a perfectly valid canonical request, and a successful one
// advances no state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool";
import { startRuntime, type RuntimeContext, type StartupFailureCode } from "../runtime/bootstrap";
import { recordRuntimeEvidence } from "../runtime/evidence";
import { lineageOf } from "../runtime/identity";
import type { IdentityInput } from "../runtime/identity";
import { projectCatalogue, type CatalogueProjection } from "../customer/catalogueProjection";
import { buildCustomerProjection } from "../customer/projection";
import { submitCustomerDemand, type AcceptedDemand } from "../customer/demandIngress";
import { ingressHttpStatus } from "../customer/reasons";
import { renderCustomerPage } from "./page";

export const CUSTOMER_SOURCE_CHANNEL = "WEB_CUSTOMER_SURFACE";
export const INGRESS_PATH = "/api/customer/requests";
export const CONFIGURATION_PATH = "/api/customer/configuration";

/** Bodies larger than this are refused before parsing. */
const MAX_BODY_BYTES = 16 * 1024;

export interface CustomerHostInput {
    pool: Pool;
    /** Typically from environment variables. All three are required. */
    identity: IdentityInput;
    port?: number;
    /** Not activated in G5-D. Present so the boundary is exercisable. */
    enableWhatsAppTransport?: boolean;
    /**
     * Project the ACTIVE governed catalogue into Core at startup. On by default:
     * a host serving a catalogue Core cannot price would accept intent it must
     * then refuse.
     */
    projectCatalogueOnStart?: boolean;
}

export interface CustomerHost {
    server: Server;
    runtime: RuntimeContext;
    port: number;
    origin: string;
    projection: CatalogueProjection | null;
    close(): Promise<void>;
}

export type HostStartOutcome =
    | { ok: true; host: CustomerHost }
    | { ok: false; code: StartupFailureCode | "CATALOGUE_PROJECTION_FAILED"; message: string };

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

async function readBody(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
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
    if (size === 0) {
        return { ok: false, message: "request body is empty" };
    }
    try {
        return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
        return { ok: false, message: "request body is not valid JSON" };
    }
}

/**
 * Offers the accepted request to a coordination channel AFTER it is committed.
 *
 * Everything about this function is deliberately inconsequential to SCP truth:
 * it runs post-commit, its result is recorded as operational evidence, and its
 * return value is discarded by the caller. That is what "WhatsApp cannot create,
 * confirm, assign, fulfill or complete canonical service state" looks like when
 * it is structural rather than promised.
 */
export async function handoffAfterIngress(
    pool: Pool,
    runtime: RuntimeContext,
    accepted: AcceptedDemand
): Promise<void> {
    const lineage = lineageOf(runtime.identity);
    const result = await runtime.adapters.send(
        "WHATSAPP",
        {
            correlationId: accepted.correlationId,
            idempotencyKey: `${accepted.idempotencyKey}:handoff`,
            lineage
        },
        {
            channel: "WHATSAPP",
            recipientHandle: accepted.acknowledgement.requestReference,
            body: `Request ${accepted.requestId} received`
        }
    );

    await withTransaction(pool, (client) =>
        recordRuntimeEvidence(client, {
            kind: "CHANNEL_HANDOFF_ATTEMPTED",
            lineage,
            outcome: result.transported ? "OK" : "REFUSED",
            reasonCode: result.transported ? null : result.code,
            configurationVersion: accepted.configurationVersion,
            configurationChecksum: accepted.configurationChecksum,
            detail: {
                requestId: accepted.requestId,
                correlationId: accepted.correlationId,
                // Recorded explicitly so the record itself states the boundary.
                advancesCanonicalState: result.advancesCanonicalState
            }
        })
    );
}

/**
 * Starts the customer host. Returns a refusal — and listens on nothing — if the
 * runtime spine will not start.
 */
export async function startCustomerHost(input: CustomerHostInput): Promise<HostStartOutcome> {
    const started = await startRuntime({
        pool: input.pool,
        identity: input.identity,
        enableWhatsAppTransport: input.enableWhatsAppTransport === true
    });
    if (!started.ok) {
        return { ok: false, code: started.code, message: started.message };
    }
    const runtime = started.runtime;
    const lineage = lineageOf(runtime.identity);

    let projection: CatalogueProjection | null = null;
    if (input.projectCatalogueOnStart !== false) {
        const outcome = await withTransaction(input.pool, async (client) => {
            const projected = await projectCatalogue(client, runtime.configuration);
            if (!projected.ok) {
                return projected;
            }
            await recordRuntimeEvidence(client, {
                kind: "CATALOGUE_PROJECTED",
                lineage,
                outcome: "OK",
                configurationVersion: runtime.configuration.provenance.configurationVersion,
                configurationChecksum: runtime.configuration.provenance.checksum,
                detail: {
                    services: projected.projection.services.length,
                    extras: projected.projection.extras.length,
                    priceVersionsAppended: projected.projection.priceVersionsAppended,
                    // R16 travels with the projection rather than being asserted
                    // once in a document nobody reads at runtime.
                    durationProvenance: projected.projection.services[0]?.durationProvenance ?? null
                }
            });
            return projected;
        });
        if (!outcome.ok) {
            return { ok: false, code: "CATALOGUE_PROJECTION_FAILED", message: outcome.message };
        }
        projection = outcome.projection;
    }

    const server = createServer((request, response) => {
        handleCustomerRequest(input.pool, runtime, request, response).catch(() => {
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
            projection,
            close: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                })
        }
    };
}

// C2 (SCP-SHELL-04A-EXE-01A) — exported so the Experience Lab router can serve
// the SAME handler this host binds. Renamed and exported; the body is untouched.
// Every dependency was already a parameter, so there is no server-scope closure
// to unpick and no behavioural difference between the two call paths.
export async function handleCustomerRequest(
    pool: Pool,
    runtime: RuntimeContext,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
        json(response, 200, {
            status: "SERVING",
            configuration: runtime.describe(),
            adapters: runtime.adapters.channels(),
            requiredRelations: runtime.schema.present.length
        });
        return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const projection = buildCustomerProjection(runtime.configuration);
        html(
            response,
            200,
            renderCustomerPage({
                projection,
                locale: url.searchParams.get("lang") ?? projection.market.localeDefault,
                ingressPath: INGRESS_PATH
            })
        );
        return;
    }

    if (method === "GET" && url.pathname === CONFIGURATION_PATH) {
        json(response, 200, buildCustomerProjection(runtime.configuration));
        return;
    }

    if (url.pathname === INGRESS_PATH) {
        if (method !== "POST") {
            json(response, 405, { error: "METHOD_NOT_ALLOWED", message: "use POST" });
            return;
        }
        const body = await readBody(request);
        if (!body.ok) {
            json(response, 400, { error: "MALFORMED_BODY", message: body.message });
            return;
        }

        // A caller may ASSERT its context in headers. It is checked against the
        // runtime identity and never substituted for it.
        const claimed = {
            tenantId: header(request, "x-scp-tenant"),
            marketId: header(request, "x-scp-market"),
            environment: header(request, "x-scp-environment")
        };

        const correlationId = randomUUID();
        const outcome = await withTransaction(pool, (client) =>
            submitCustomerDemand(
                client,
                { identity: runtime.identity, configuration: runtime.configuration },
                {
                    body: body.value,
                    correlationId,
                    sourceChannel: CUSTOMER_SOURCE_CHANNEL,
                    claimed
                }
            )
        );

        if (!outcome.ok) {
            json(response, ingressHttpStatus(outcome.reason), {
                error: outcome.reason,
                message: outcome.message,
                findings: outcome.findings ?? [],
                correlationId
            });
            return;
        }

        // Committed. Only now is a channel offered the message, and its outcome
        // is not consulted before answering the customer.
        await handoffAfterIngress(pool, runtime, outcome.value).catch(() => {
            // A handoff failure is operational, not canonical. It is already
            // recorded as evidence where it could be; it must not turn a
            // persisted request into an error the customer sees.
        });

        json(response, outcome.value.disposition === "ACCEPTED" ? 201 : 200, {
            requestId: outcome.value.requestId,
            state: outcome.value.state,
            disposition: outcome.value.disposition,
            idempotencyKey: outcome.value.idempotencyKey,
            correlationId: outcome.value.correlationId,
            configurationVersion: outcome.value.configurationVersion,
            acknowledgement: outcome.value.acknowledgement
        });
        return;
    }

    json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${url.pathname}` });
}

function header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
    }
    return undefined;
}
