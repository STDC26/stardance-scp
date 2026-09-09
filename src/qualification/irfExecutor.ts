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
import { spawn } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type Pool, type PoolClient, type FieldDef } from "pg";
import { createPool } from "../db/pool";
import { G11RunStore, describeError, isConnectionLoss } from "./g11RunStore";

const PORT = Number(process.env["PORT"] ?? 8080);
const TOKEN = process.env["IRF_BRIDGE_TOKEN"] ?? "";
const CANDIDATE = process.env["CANDIDATE_URL"] ?? "http://scp-command-runtime.railway.internal:8080";
const BATTERY = "tests/runtime/g11Topology.integration.test.ts";

const pool = createPool();
const store = new G11RunStore();

/**
 * QCP2A-R01 — this process's own identity.
 *
 * RAILWAY_REPLICA_ID survives a process restart within the same replica, so it
 * cannot distinguish "this process" from "the process that died". A per-boot
 * UUID can, and that distinction is what restart reconciliation is built on:
 * a run owned by a different boot id is by definition orphaned.
 */
const BOOT_ID = randomUUID();
const PROCESS_IDENTITY = `${process.env["RAILWAY_REPLICA_ID"] ?? "local"}:${BOOT_ID}`;

/** The run currently executing, so pool errors can be attributed to it. */
let activeRunId: string | null = null;

/**
 * QCP2A-R01-A — safe pool error handling.
 *
 * The pinned battery's G11-T11 terminates every other backend on this database,
 * which includes this bridge's idle pooled connections. node-pg surfaces that as
 * an 'error' event on the pool; with no listener, Node treats it as an unhandled
 * error event and kills the process. That is precisely what made the previous
 * bridge NONCONFORMANT.
 *
 * Containment is not suppression. An expected destructive-test effect is
 * recorded against the active run and execution continues. Anything else is
 * recorded as UNEXPECTED, attached to the run's error_json, and left visible for
 * IRF to adjudicate — it may legitimately fail the run. Nothing here converts a
 * pool error into success.
 */
pool.on("error", (err: Error) => {
    const expected = isConnectionLoss(err) && activeRunId !== null;
    // eslint-disable-next-line no-console
    console.log(
        expected ? "POOL_ERROR_EXPECTED" : "POOL_ERROR_UNEXPECTED",
        JSON.stringify({ runId: activeRunId, ...describeError(err) })
    );
    void store.recordPoolError(activeRunId, err, expected);
});

/** Long-lived IRF-controlled sessions. Real connections, held open until IRF says otherwise. */
const sessions = new Map<string, Client>();

/** Last transport-level error seen on a session, so a killed session reports why. */
const lastSessionError = new Map<string, Record<string, unknown>>();

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
        return {
            ok: false,
            startedAt,
            finishedAt: new Date().toISOString(),
            // QCP2A-R02 §14: allowlisted. A pg error can carry a reference to the
            // client that raised it, and that client holds the password.
            error: describeError(e)
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
        // Per-boot identity. The replica id survives a restart, so it cannot show
        // IRF that the process changed; this can, and restart survival is exactly
        // what A10 has to be able to test.
        bridgeProcessIdentity: PROCESS_IDENTITY,
        bridgeBootId: BOOT_ID,
        bridgeProcessStartedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
        // QCP2A-R02 — a single named, non-secret probe variable. It exists to
        // prove that a Railway restart picks up updated service variables
        // WITHOUT creating a new deployment, which had to be established on the
        // disposable bridge before the same mechanism could be relied on to
        // deliver a rotated credential to the preserved candidate (R02 §17).
        // Deliberately one fixed non-secret key, never an environment dump.
        restartProbe: process.env["R02_RESTART_PROBE"] ?? null,
        nodeVersion: process.version,
        dbHost: process.env["PGHOST"] ?? null,
        dbPort: process.env["PGPORT"] ?? null,
        candidateUrl: CANDIDATE,
        observedAt: new Date().toISOString()
    };
}

/**
 * A convenience index over the raw output. It deliberately adjudicates nothing:
 * R01 §19 and §22 are explicit that EXE evidence establishes repair readiness
 * only, and that reading 12/12 as sufficient is exactly the mistake to avoid.
 * `stdout_raw`, `stderr_raw` and `exit_code` remain the authoritative record.
 */
/** Vitest colourises its summary; the ANSI codes broke the R01 summary regexes. */
function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\[[0-9;]*m/g, "");
}

/**
 * QCP2A-R02 §12 — the parent bridge parses the harness's structured events
 * itself rather than trusting the child's exit code alone. `G11_HARNESS_EVENT`
 * / `G11_HARNESS_SUMMARY` lines are emitted by g11HarnessSetup.
 */
function parseHarness(stdout: string): {
    expectedConnectionLossEvents: unknown[];
    unexpectedErrorCount: number | null;
    summaryPresent: boolean;
} {
    const plain = stripAnsi(stdout);
    const summaryMatch = /G11_HARNESS_SUMMARY (\{[\s\S]*?\})\s*(?:\n|$)/.exec(plain);
    if (summaryMatch?.[1]) {
        try {
            const parsed = JSON.parse(summaryMatch[1]) as {
                events?: unknown[];
                unexpectedErrors?: number;
            };
            const events = (parsed.events ?? []) as Array<{ classification?: string }>;
            return {
                expectedConnectionLossEvents: events.filter(
                    (e) => e.classification === "EXPECTED_CONNECTION_LOSS"
                ),
                unexpectedErrorCount: parsed.unexpectedErrors ?? null,
                summaryPresent: true
            };
        } catch {
            // fall through to per-event reconstruction
        }
    }
    // The summary prints once at the end; if the run died before it, rebuild from
    // the per-event lines, which are emitted as they happen.
    const events: unknown[] = [];
    let unexpected = 0;
    for (const m of plain.matchAll(/G11_HARNESS_EVENT (\{.*?\})\s*(?:\n|$)/g)) {
        try {
            const e = JSON.parse(m[1]!) as { classification?: string };
            if (e.classification === "EXPECTED_CONNECTION_LOSS") events.push(e);
            else unexpected += 1;
        } catch {
            /* ignore malformed line */
        }
    }
    return {
        expectedConnectionLossEvents: events,
        unexpectedErrorCount: events.length || unexpected ? unexpected : null,
        summaryPresent: false
    };
}

function summarise(stdout: string, stderr: string): Record<string, unknown> {
    const both = stripAnsi(`${stdout}\n${stderr}`);
    const harness = parseHarness(stdout);
    return {
        testsLine: /^\s*Tests\s+(.+)$/m.exec(both)?.[1]?.trim() ?? null,
        testFilesLine: /^\s*Test Files\s+(.+)$/m.exec(both)?.[1]?.trim() ?? null,
        durationLine: /^\s*Duration\s+(.+)$/m.exec(both)?.[1]?.trim() ?? null,
        unhandledErrorsReported: /Vitest caught (\d+) unhandled error/.exec(both)?.[1] ?? "0",
        testIdsObserved: [...new Set([...both.matchAll(/G11-T\d{2}/g)].map((m) => m[0]))].sort(),
        observationsMarkerPresent: both.includes("G11_OBSERVATIONS"),
        harnessSummaryPresent: harness.summaryPresent,
        expectedConnectionLossCount: harness.expectedConnectionLossEvents.length,
        unexpectedErrorCount: harness.unexpectedErrorCount,
        note: "Raw stdout/stderr and exit_code are authoritative. This summary indexes them and adjudicates nothing."
    };
}

/**
 * Runs the unchanged pinned battery in a child process, persisting evidence as
 * it goes.
 *
 * The child boundary already existed and is preserved: the battery can terminate
 * backends, fail, or be signalled without requiring this process to die. What is
 * new is that output is checkpointed to durable storage while the suite runs, so
 * a crash at any point still leaves the evidence produced up to that point.
 */
async function startBattery(runId: string): Promise<void> {
    activeRunId = runId;
    const started = Date.now();

    const child = spawn(
        process.execPath,
        [
            "node_modules/vitest/vitest.mjs",
            "run",
            BATTERY,
            // QCP2A-R02-D02. Qualification-only harness containment for the
            // connection terminations T11 deliberately causes. It adds error
            // listeners; it does not touch the battery, its assertions, or T11's
            // target population. See src/qualification/g11HarnessSetup.ts.
            "--setupFiles=src/qualification/g11HarnessSetup.ts",
            "--testTimeout=300000",
            "--hookTimeout=200000",
            "--no-file-parallelism",
            "--reporter=basic"
        ],
        {
            cwd: process.cwd(),
            env: { ...process.env, RUN_INTEGRATION: "1" },
            timeout: 900_000
        }
    );

    await store.markRunning(runId, child.pid ?? null);

    let stdout = "";
    let stderr = "";
    let pendingOut = "";
    let pendingErr = "";
    let seq = 0;
    let flushing = false;

    const flush = async (): Promise<void> => {
        if (flushing) return;
        flushing = true;
        try {
            if (pendingOut) {
                const c = pendingOut;
                pendingOut = "";
                seq += 1;
                await store.appendChunk(runId, "stdout", seq, c);
            }
            if (pendingErr) {
                const c = pendingErr;
                pendingErr = "";
                seq += 1;
                await store.appendChunk(runId, "stderr", seq, c);
            }
        } finally {
            flushing = false;
        }
    };

    child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stdout += s;
        pendingOut += s;
    });
    child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stderr += s;
        pendingErr += s;
    });

    // Durable checkpoints while the battery is still running (R01 §10.3).
    const ticker = setInterval(() => void flush(), 400);

    await new Promise<void>((resolve) => {
        child.on("error", (err: Error) => {
            clearInterval(ticker);
            void flush()
                .then(() =>
                    store.completeRun(runId, {
                        state: "FAILED",
                        exitCode: null,
                        durationMs: Date.now() - started,
                        stdout,
                        stderr,
                        terminationReason: "child process could not be executed",
                        summary: summarise(stdout, stderr),
                        error: err
                    })
                )
                .finally(() => {
                    activeRunId = null;
                    resolve();
                });
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            clearInterval(ticker);
            void flush()
                .then(() =>
                    store.completeRun(runId, {
                        // COMPLETED means the runner ran to completion, NOT that the
                        // battery passed. R01 §20: a non-zero exit is preserved
                        // exactly as observed and never coerced to zero. Whether the
                        // run is trustworthy is IRF's call, not the bridge's.
                        state: "COMPLETED",
                        exitCode: code,
                        durationMs: Date.now() - started,
                        stdout,
                        stderr,
                        terminationReason: signal ? `child terminated by signal ${signal}` : null,
                        summary: summarise(stdout, stderr),
                        signal: signal ?? null,
                        expectedConnectionLossEvents: parseHarness(stdout).expectedConnectionLossEvents,
                        unexpectedErrorCount: parseHarness(stdout).unexpectedErrorCount
                    })
                )
                .finally(() => {
                    activeRunId = null;
                    resolve();
                });
        });
    });
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
        const id = randomUUID();
        // QCP2A-R01-A, session scope. G11-T11 terminates every other backend on
        // this database, which includes IRF's own held sessions. An unhandled
        // 'error' on a pg Client is fatal to the process exactly as it is on a
        // Pool, so the same containment applies: record it against the session,
        // keep it observable through /session/{id}/query, do not die.
        client.on("error", (err: Error) => {
            lastSessionError.set(id, describeError(err));
            // eslint-disable-next-line no-console
            console.log("SESSION_CLIENT_ERROR", JSON.stringify({ sessionId: id, ...describeError(err) }));
        });
        await client.connect();
        sessions.set(id, client);
        const pid = await runQuery(client, `SELECT pg_backend_pid() AS backend_pid`, []);
        return json(res, 200, { sessionId: id, backend: pid, openSessions: sessions.size });
    }

    if (p.startsWith("/session/") && req.method === "POST") {
        const [, , id, action] = p.split("/");
        const client = sessions.get(id ?? "");
        if (!client)
            return json(res, 404, {
                error: "no such session",
                sessionId: id,
                // If the session died because the battery terminated its backend,
                // say so rather than leaving IRF to guess.
                lastSessionError: lastSessionError.get(id ?? "") ?? null
            });

        if (action === "query") {
            const body = await readBody(req);
            const sql = String(body["sql"] ?? "");
            if (!sql) return json(res, 422, { error: "sql required" });
            const out = await runQuery(client, sql, (body["params"] as unknown[]) ?? []);
            const transportError = lastSessionError.get(id ?? "");
            return json(res, 200, transportError ? { ...out, transportError } : out);
        }
        if (action === "close") {
            await client.end().catch(() => undefined);
            sessions.delete(id!);
            lastSessionError.delete(id!);
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
        return json(res, 200, { runs: await store.listRuns() });
    }
    if (p.startsWith("/g11/") && req.method === "GET") {
        const id = p.split("/")[2] ?? "";
        // Durable store, not process memory. A restart no longer erases a run.
        const r = await store.getRun(id);
        if (!r) return json(res, 404, { error: "no such run", runId: id });
        return json(res, 200, { runId: id, ...r });
    }
    if (p === "/g11" && req.method === "POST") {
        const buf = readFileSync(BATTERY);
        const runId = randomUUID();
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const testCount = (buf.toString("utf8").match(/^\s*(?:it|test)\(/gm) ?? []).length;

        let candidateIdentity: unknown = null;
        try {
            const r = await fetch(`${CANDIDATE}/identity`, { signal: AbortSignal.timeout(10_000) });
            candidateIdentity = await r.json();
        } catch (e) {
            candidateIdentity = { error: String(e) };
        }
        const dbIdentity = await runQuery(
            pool,
            `SELECT version() AS version, current_database() AS database,
                    host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port`,
            []
        );

        // Durable BEFORE the battery is launched (R01 §10.1). If this process
        // dies one statement from here, the run still exists and IRF can still
        // retrieve it — which is the entire point of the repair.
        await store.createRun({
            runId,
            batteryPath: BATTERY,
            batterySha256: sha256,
            batteryBytes: buf.length,
            batteryTestCount: testCount,
            bridgeDeploymentId: process.env["RAILWAY_DEPLOYMENT_ID"] ?? null,
            bridgeProcessIdentity: PROCESS_IDENTITY,
            candidateDeploymentId:
                (candidateIdentity as { railwayDeploymentId?: string } | null)?.railwayDeploymentId ?? null,
            candidateRuntimeIdentity: candidateIdentity,
            databaseIdentity: dbIdentity
        });
        await store.appendEvent(runId, "IDENTITY_BEFORE", bridgeIdentity());

        void startBattery(runId).catch((e: unknown) => {
            // A failure to even start the battery is itself run evidence, and an
            // unhandled rejection here would reintroduce the crash this repair
            // exists to remove.
            activeRunId = null;
            void store.completeRun(runId, {
                state: "FAILED",
                exitCode: null,
                durationMs: 0,
                stdout: "",
                stderr: "",
                terminationReason: "battery launch failed",
                summary: null,
                error: e
            });
        });
        return json(res, 202, { runId, state: "CREATED", retrieveAt: `/g11/${runId}` });
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

/**
 * R01 §12 — restart recovery.
 *
 * Schema first, then reconcile. Any run still marked CREATED/RUNNING under a
 * previous boot id cannot be running now, because the process that owned it no
 * longer exists. It is marked INTERRUPTED — never COMPLETED, never PASS — with
 * the previous owner and the reason recorded.
 */
async function bootstrap(): Promise<void> {
    await store.initSchema();
    const reconciled = await store.reconcileOnStartup(PROCESS_IDENTITY);
    // eslint-disable-next-line no-console
    console.log(
        "IRF QCP2A bridge bootstrap",
        JSON.stringify({
            processIdentity: PROCESS_IDENTITY,
            reconciledInterruptedRuns: reconciled.length,
            reconciled
        })
    );
}

createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(res, 500, { error: e.message, stack: e.stack }));
}).listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log("IRF QCP2A bridge listening", JSON.stringify({ ...bridgeIdentity(), processIdentity: PROCESS_IDENTITY }));
    void bootstrap().catch((e: unknown) => {
        // Serve regardless: /healthz and the durable read paths must stay
        // available so a storage problem is diagnosable rather than invisible.
        // eslint-disable-next-line no-console
        console.log("IRF QCP2A bridge bootstrap FAILED", JSON.stringify(describeError(e)));
    });
});
