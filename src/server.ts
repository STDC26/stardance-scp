// LAB-INFRA-01A — the single Node entrypoint for the SCP Experience Lab.
//
// This file exists for one reason: to make the existing SCP runtime deployable
// as a Node application, on a platform that would otherwise look for a static
// output directory and find none. It is a TRANSPORT, in the same sense as the
// hosts in `src/host/*` — it owns no canonical configuration, no tenant truth,
// no persistence and no lifecycle semantics.
//
// What it deliberately does NOT do, and must not grow into:
//
//   - resolve canonical price, availability or provider eligibility;
//   - create commitment, assignment or fulfillment;
//   - read `config/<marketId>.market.json` (directly or otherwise) in place of
//     the config plane — see AGENTS.md Rule 1;
//   - hold an in-memory copy of anything the database is authoritative for;
//   - duplicate host logic. When Freshline surfaces mount here (LAB-1A), they
//     mount by REUSING the existing hosts' request handlers, not by copying
//     their bodies into this file.
//
// The health route answers from process-local facts only. It performs no
// database work, which is why it is safe to answer before `startRuntime` has
// ever been called. That is a deliberate boundary and not an oversight: a
// liveness probe that needs the canonical database cannot tell you the
// difference between "the process is down" and "the database is down".
// Database readiness is a SEPARATE signal and is added in LAB-INFRA-01B, where
// it must fail loudly rather than fall back (spec §13).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** The canonical Experience Lab path namespace. An HTTP path, not a directory. */
export const LABS_PREFIX = "/labs";

/** The first — and, until 01B, only — Experience Lab route. */
export const LABS_HEALTH_PATH = "/labs/health";

/**
 * What `/labs/health` reports. Process-local facts only: no secrets, no host
 * names, no connection strings, no customer or provider data (spec §13).
 */
export interface LabsHealthBody {
    service: "stardance-scp";
    environment: "experience-lab";
    status: "ok";
}

const HEALTH_BODY: LabsHealthBody = {
    service: "stardance-scp",
    environment: "experience-lab",
    status: "ok"
};

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload);

    res.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        // A health answer that can be served from a cache is not a health
        // answer — it is a memory of one.
        "cache-control": "no-store"
    });

    res.end(body);
}

/**
 * The Experience Lab request handler.
 *
 * Exported separately from the server so that the same routing decision runs
 * under a long-lived `listen()` (local development, container hosts) and under
 * a platform that invokes a request handler per request. Those two are the same
 * code path by construction, so a route cannot pass locally and be absent in
 * the Lab.
 */
export function handleLabsRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only the path is read. The base is a placeholder to satisfy the URL
    // parser; it is never used to construct an outbound address.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === LABS_HEALTH_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
            sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
        }

        sendJson(res, 200, HEALTH_BODY);
        return;
    }

    sendJson(res, 404, { error: "NOT_FOUND" });
}

/** Creates the Lab server without binding it. Callers decide when to listen. */
export function createLabServer(): Server {
    return createServer(handleLabsRequest);
}

/**
 * Binds the Lab server.
 *
 * `PORT` is read here and nowhere else in this file's call graph, so the port
 * is a transport concern that never reaches application code.
 */
export function startLabServer(port: number = Number(process.env["PORT"] ?? 3000)): Server {
    const server = createLabServer();
    server.listen(port);
    return server;
}

// Bind only when executed directly. When this module is imported — by the
// Vercel adapter in `api/index.ts`, or by a test — importing it must not
// occupy a port.
if (require.main === module) {
    startLabServer();
}
