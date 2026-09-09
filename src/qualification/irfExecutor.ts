// SCP-RUNTIME-Q01B-QCP2A — the IRF independent reproof execution bridge.
//
// Proof infrastructure, not product architecture. This exists so IRF can reach
// into the preserved qualification topology and run its own attacks, rather
// than reading someone else's account of them.
//
// It is deliberately NOT part of the SCP Reference Runtime being qualified:
// nothing in the candidate depends on it, it owns no canonical truth, and it
// creates no second authoritative mutation path. Every write it can perform
// goes either to the dedicated q01b_* qualification tables or through raw SQL
// that IRF itself authored and can see.
//
// Independence is the whole point. EXE builds this; EXE does not drive it.
// Each endpoint returns raw output — rows, fields, stdout, stderr, exit codes,
// timestamps, process identity — never a summary or a verdict.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type Pool, type PoolClient, type FieldDef } from "pg";
import { createPool } from "../db/pool";

const PORT = Number(process.env["PORT"] ?? 8080);
const TOKEN = process.env["IRF_BRIDGE_TOKEN"] ?? "";
const CANDIDATE = process.env["CANDIDATE_URL"] ?? "http://scp-command-runtime.railway.internal:8080";
const BATTERY = "tests/runtime/g11Topology.integration.test.ts";

const pool = createPool();

/** Long-lived IRF-controlled sessions. Real connections, held open until IRF says otherwise. */
const sessions = new Map<string, Client>();

interface BatteryRun {
    state: "RUNNING" | "COMPLETE";
    startedAt: string;
    finishedAt?: string;
    battery: { path: string; sha256: string; bytes: number };
    identityBefore: Record<string, unknown>;
    identityAfter?: Record<string, unknown>;
    result?: Record<string, unknown>;
}
/** Raw run output, retained for IRF retrieval. */
const runs = new Map<string, BatteryRun>();

function authorised(req: IncomingMessage): boolean {
    if (!TOKEN) return false;
    const given = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const p = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(p) });
    res.end(p);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Raw query result — rows AND field metadata AND errors, nothing filtered. */
type Queryable = Pick<Client, "query"> | Pick<Pool, "query"> | Pick<PoolClient, "query">;

async function runQuery(
    client: Queryable,
    sql: string,
    params: unknown[]
): Promise<Record<string, unknown>> {
    const startedAt = new Date().toISOString();
    try {
        const r = await (client as Pick<Client, "query">).query(sql, params);
        return {
            ok: true,
            startedAt,
            finishedAt: new Date().toISOString(),
            command: r.command,
            rowCount: r.rowCount,
            fields: (r.fields ?? []).map((f: FieldDef) => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: r.rows
        };
    } catch (e) {
        const err = e as { message?: string; code?: string; detail?: string; severity?: string };
        return {
            ok: false,
            startedAt,
            finishedAt: new Date().toISOString(),
            error: { message: err.message, code: err.code, detail: err.detail, severity: err.severity }
        };
    }
}

function bridgeIdentity(): Record<string, unknown> {
    return {
        role: "IRF_QCP2_REPROOF_EXECUTOR",
        authoritative: false,
        canonicalOwnership: "NONE",
        bridgeCommitSHA: process.env["SCP_COMMIT_SHA"] ?? null,
        bridgeTreeSHA: process.env["SCP_TREE_SHA"] ?? null,
        railwayDeploymentId: process.env["RAILWAY_DEPLOYMENT_ID"] ?? null,
        railwayServiceId: process.env["RAILWAY_SERVICE_ID"] ?? null,
        railwayServiceName: process.env["RAILWAY_SERVICE_NAME"] ?? null,
        railwayEnvironmentName: process.env["RAILWAY_ENVIRONMENT_NAME"] ?? null,
        railwayReplicaId: process.env["RAILWAY_REPLICA_ID"] ?? null,
        nodeVersion: process.version,
        dbHost: process.env["PGHOST"] ?? null,
        dbPort: process.env["PGPORT"] ?? null,
        candidateUrl: CANDIDATE,
        observedAt: new Date().toISOString()
    };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p === "/healthz") return json(res, 200, { status: "SERVING", role: "IRF_BRIDGE" });
    if (!authorised(req)) return json(res, 401, { error: "UNAUTHORIZED" });

    // ---- A4 / 6.1 custody -------------------------------------------------
    if (p === "/custody") {
        const bridge = bridgeIdentity();
        let candidate: unknown = null;
        let candidateError: string | null = null;
        try {
            const r = await fetch(`${CANDIDATE}/identity`, { signal: AbortSignal.timeout(15_000) });
            candidate = await r.json();
        } catch (e) {
            candidateError = String(e);
        }
        const db = await runQuery(
            pool,
            `SELECT version() AS version, current_setting('default_transaction_isolation') AS isolation,
                    current_setting('max_connections') AS max_connections,
                    host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port,
                    pg_backend_pid() AS backend_pid, current_database() AS database`,
            []
        );
        return json(res, 200, { bridge, candidate, candidateError, database: db });
    }

    // ---- 6.2 independent hashing -----------------------------------------
    if (p === "/hash") {
        const target = url.searchParams.get("path") ?? BATTERY;
        try {
            const buf = readFileSync(target);
            return json(res, 200, {
                path: target,
                sha256: createHash("sha256").update(buf).digest("hex"),
                bytes: buf.length,
                observedAt: new Date().toISOString()
            });
        } catch (e) {
            return json(res, 404, { path: target, error: String(e) });
        }
    }

    // ---- 6.3 low-level DB / session control ------------------------------
    if (p === "/sql" && req.method === "POST") {
        const body = await readBody(req);
        const sql = String(body["sql"] ?? "");
        if (!sql) return json(res, 422, { error: "sql required" });
        const c = await pool.connect();
        try {
            return json(res, 200, await runQuery(c, sql, (body["params"] as unknown[]) ?? []));
        } finally {
            c.release();
        }
    }

    if (p === "/session/open" && req.method === "POST") {
        const client = new Client({
            host: process.env["PGHOST"],
            port: Number(process.env["PGPORT"] ?? 5432),
            database: process.env["PGDATABASE"],
            user: process.env["PGUSER"],
            password: process.env["PGPASSWORD"]
        });
        await client.connect();
        const id = randomUUID();
        sessions.set(id, client);
        const pid = await runQuery(client, `SELECT pg_backend_pid() AS backend_pid`, []);
        return json(res, 200, { sessionId: id, backend: pid, openSessions: sessions.size });
    }

    if (p.startsWith("/session/") && req.method === "POST") {
        const [, , id, action] = p.split("/");
        const client = sessions.get(id ?? "");
        if (!client) return json(res, 404, { error: "no such session", sessionId: id });

        if (action === "query") {
            const body = await readBody(req);
            const sql = String(body["sql"] ?? "");
            if (!sql) return json(res, 422, { error: "sql required" });
            return json(res, 200, await runQuery(client, sql, (body["params"] as unknown[]) ?? []));
        }
        if (action === "close") {
            await client.end().catch(() => undefined);
            sessions.delete(id!);
            return json(res, 200, { closed: id, openSessions: sessions.size });
        }
        if (action === "destroy") {
            // Uncontrolled loss: rip the socket out without a graceful close, so
            // IRF can observe what the server does with an abandoned session.
            type WithStream = { connection?: { stream?: { destroy?: () => void } } };
            (client as unknown as WithStream).connection?.stream?.destroy?.();
            sessions.delete(id!);
            return json(res, 200, { destroyed: id, openSessions: sessions.size });
        }
        return json(res, 404, { error: "unknown session action", action });
    }

    // ---- 6.4 pinned G11 execution ----------------------------------------
    // Asynchronous by design. The battery deliberately terminates database
    // backends, which can take a synchronous HTTP request down with it — and a
    // proof that cannot deliver its own result is not much of a proof. IRF
    // starts a run, gets a runId, and retrieves raw stdout/stderr/exit
    // independently, however long it takes and whatever the battery does.
    if (p === "/g11/runs" && req.method === "GET") {
        return json(res, 200, {
            runs: [...runs.entries()].map(([id, r]) => ({ id, state: r.state, startedAt: r.startedAt }))
        });
    }
    if (p.startsWith("/g11/") && req.method === "GET") {
        const id = p.split("/")[2] ?? "";
        const r = runs.get(id);
        if (!r) return json(res, 404, { error: "no such run", runId: id });
        return json(res, 200, { runId: id, ...r });
    }
    if (p === "/g11" && req.method === "POST") {
        const buf = readFileSync(BATTERY);
        const identityBefore = bridgeIdentity();
        const started = Date.now();
        const runId = randomUUID();
        runs.set(runId, {
            state: "RUNNING",
            startedAt: new Date().toISOString(),
            battery: {
                path: BATTERY,
                sha256: createHash("sha256").update(buf).digest("hex"),
                bytes: buf.length
            },
            identityBefore
        });
        void new Promise<Record<string, unknown>>((resolve) => {
            execFile(
                process.execPath,
                [
                    "node_modules/vitest/vitest.mjs",
                    "run",
                    BATTERY,
                    "--testTimeout=300000",
                    "--hookTimeout=200000",
                    "--no-file-parallelism",
                    "--reporter=basic"
                ],
                {
                    cwd: process.cwd(),
                    env: { ...process.env, RUN_INTEGRATION: "1" },
                    maxBuffer: 32 * 1024 * 1024,
                    timeout: 600_000
                },
                (err, stdout, stderr) => {
                    resolve({
                        exitCode: (err as { code?: number } | null)?.code ?? 0,
                        stdout,
                        stderr,
                        durationMs: Date.now() - started
                    });
                }
            );
        }).then((out) => {
            const existing = runs.get(runId);
            if (existing) {
                existing.state = "COMPLETE";
                existing.finishedAt = new Date().toISOString();
                existing.identityAfter = bridgeIdentity();
                existing.result = out;
            }
        });
        return json(res, 202, { runId, state: "RUNNING", retrieveAt: `/g11/${runId}` });
    }

    // ---- 6.5 remote failure injection against the candidate ---------------
    if (p === "/candidate" && req.method === "POST") {
        const body = await readBody(req);
        const path = String(body["path"] ?? "/identity");
        const started = new Date().toISOString();
        try {
            const r = await fetch(`${CANDIDATE}${path}`, { signal: AbortSignal.timeout(30_000) });
            const text = await r.text();
            return json(res, 200, {
                requestedAt: started,
                respondedAt: new Date().toISOString(),
                status: r.status,
                body: text
            });
        } catch (e) {
            // A transport failure IS the observation IRF is looking for here.
            return json(res, 200, {
                requestedAt: started,
                failedAt: new Date().toISOString(),
                status: null,
                transportError: String(e)
            });
        }
    }

    json(res, 404, { error: "NOT_FOUND", path: p });
}

createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(res, 500, { error: e.message, stack: e.stack }));
}).listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log("IRF QCP2A bridge listening", JSON.stringify(bridgeIdentity()));
});
