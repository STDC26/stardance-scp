// SCP-RUNTIME-Q01B — the qualification command runtime.
//
// Qualification-only instantiation. This exists so the locked reference
// architecture has something to BE: a server-side canonical command runtime
// that reaches managed PostgreSQL over the private path, deployed remotely, so
// the guarantees can be attacked where they will actually run rather than on a
// developer laptop.
//
// It adds no SCP capability. It boots the Owner host — an existing governed
// command surface — and exposes three qualification endpoints beside it:
//
//   GET  /identity   runtime self-identity for §11 at-test-time custody
//   GET  /probe      §14 behavioral intermediary / session-semantics probe,
//                    executed on the ACTUAL consequential path from inside the
//                    deployed runtime, not from a laptop through a proxy
//   POST /uncertain  §18 remote uncertain-outcome attack: commit durably, then
//                    destroy the response before the caller can learn of it
//
// Nothing here can transition canonical lifecycle state on its own; /uncertain
// writes to a dedicated qualification table so the attack is real without
// putting governed truth at risk.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPool, withTransaction } from "../db/pool";

const PORT = Number(process.env["PORT"] ?? 8080);
const pool = createPool();

/** §11 — enough identity to prove the same deployment executed the test. */
function identity(): Record<string, unknown> {
    return {
        // Bound at build time by the deploy, so the running process can prove
        // which source produced it.
        repositoryCommitSHA: process.env["SCP_COMMIT_SHA"] ?? null,
        repositoryTreeSHA: process.env["SCP_TREE_SHA"] ?? null,
        railwayDeploymentId: process.env["RAILWAY_DEPLOYMENT_ID"] ?? null,
        railwayServiceId: process.env["RAILWAY_SERVICE_ID"] ?? null,
        railwayServiceName: process.env["RAILWAY_SERVICE_NAME"] ?? null,
        railwayEnvironmentId: process.env["RAILWAY_ENVIRONMENT_ID"] ?? null,
        railwayEnvironmentName: process.env["RAILWAY_ENVIRONMENT_NAME"] ?? null,
        railwayProjectId: process.env["RAILWAY_PROJECT_ID"] ?? null,
        railwayReplicaId: process.env["RAILWAY_REPLICA_ID"] ?? null,
        railwaySnapshotId: process.env["RAILWAY_SNAPSHOT_ID"] ?? null,
        railwayGitCommitSha: process.env["RAILWAY_GIT_COMMIT_SHA"] ?? null,
        railwayGitBranch: process.env["RAILWAY_GIT_BRANCH"] ?? null,
        nodeVersion: process.version,
        // The database endpoint this process will actually use. Host and port
        // only — never the credential.
        dbHost: process.env["PGHOST"] ?? null,
        dbPort: process.env["PGPORT"] ?? null,
        dbName: process.env["PGDATABASE"] ?? null,
        processStartedAt: new Date(startedAt).toISOString(),
        observedAt: new Date().toISOString()
    };
}
const startedAt = Date.now();

/**
 * §14 — behavioral intermediary probe on the real path.
 *
 * A connection-string label is not proof. These observations are the kind a
 * transaction-mode pooler or multiplexer cannot fake: whether a backend PID is
 * stable for the life of a checkout, whether transaction-scoped advisory locks
 * survive to the end of their transaction and are gone after it, and whether
 * session-local state set on one checkout leaks onto a different backend.
 */
async function probe(): Promise<Record<string, unknown>> {
    const server = await pool.query<{
        version: string;
        iso: string;
        maxconn: string;
        addr: string | null;
        port: number | null;
    }>(
        `SELECT version() AS version,
                current_setting('default_transaction_isolation') AS iso,
                current_setting('max_connections') AS maxconn,
                host(inet_server_addr()) AS addr,
                inet_server_port() AS port`
    );

    // Backend identity across independent checkouts.
    const pids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
        const c = await pool.connect();
        try {
            pids.push((await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        } finally {
            c.release();
        }
    }

    // PID stability WITHIN one checkout. A transaction-mode pooler can hand
    // different backends to consecutive statements on what the client believes
    // is one connection.
    const held = await pool.connect();
    let stableWithinCheckout = true;
    let firstPid = 0;
    try {
        firstPid = (await held.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
        for (let i = 0; i < 5; i += 1) {
            const again = (await held.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!
                .pid;
            if (again !== firstPid) stableWithinCheckout = false;
        }
    } finally {
        held.release();
    }

    // Transaction-scoped advisory lock: visible inside its transaction, gone
    // after commit. A pooler that returned the connection mid-transaction, or
    // multiplexed it, would break one of these two observations.
    let lockVisibleInTx = false;
    await withTransaction(pool, async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["q01b:probe"]);
        const n = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
        );
        lockVisibleInTx = Number(n.rows[0]!.n) > 0;
    });
    const afterCommit = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`
    );

    // Session-local state leakage onto a different backend.
    const setter = await pool.connect();
    const setterPid = (await setter.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!
        .pid;
    await setter.query(`SET application_name = 'q01b-leak-probe'`);
    setter.release();
    let leaked = false;
    for (let i = 0; i < 6; i += 1) {
        const c = await pool.connect();
        const r = await c.query<{ name: string; pid: number }>(
            `SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid`
        );
        if (r.rows[0]!.name === "q01b-leak-probe" && r.rows[0]!.pid !== setterPid) leaked = true;
        c.release();
    }

    return {
        server: server.rows[0],
        distinctBackendPidsAcrossCheckouts: new Set(pids).size,
        backendPidSamples: pids,
        backendPidStableWithinOneCheckout: stableWithinCheckout,
        advisoryLockVisibleInsideTransaction: lockVisibleInTx,
        advisoryLocksHeldAfterCommit: Number(afterCommit.rows[0]!.n),
        sessionStateLeakedToDifferentBackend: leaked
    };
}

/**
 * §18 — the remote uncertain-outcome attack.
 *
 * Commits durably, then makes the caller unable to learn that it did: the
 * response is destroyed after commit and before it can be written. The caller
 * must be able to retry with the same governed idempotency identity and
 * converge on exactly one consequence.
 */
async function uncertain(
    key: string,
    mode: "commit-then-kill" | "commit-then-hangup" | "normal"
): Promise<{ applied: number }> {
    return withTransaction(pool, async (c) => {
        const r = await c.query(
            `INSERT INTO q01b_uncertain (idem_key, applied_by_deployment)
             VALUES ($1, $2) ON CONFLICT (idem_key) DO NOTHING`,
            [key, process.env["RAILWAY_DEPLOYMENT_ID"] ?? "unknown"]
        );
        return { applied: r.rowCount ?? 0 };
    }).then((res) => {
        if (mode === "commit-then-kill") {
            // Durable commit has happened. Terminate the process before the
            // response can be written — the caller learns nothing.
            setTimeout(() => process.exit(1), 5);
        }
        return res;
    });
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/identity") return json(res, 200, identity());
    if (url.pathname === "/healthz") return json(res, 200, { status: "SERVING" });
    if (url.pathname === "/probe") return json(res, 200, await probe());
    if (url.pathname === "/uncertain-init") {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS q01b_uncertain (
                 idem_key text PRIMARY KEY,
                 applied_by_deployment text NOT NULL,
                 applied_at timestamptz NOT NULL DEFAULT now()
             )`
        );
        return json(res, 200, { ok: true });
    }
    if (url.pathname === "/uncertain") {
        const key = url.searchParams.get("key");
        const mode = (url.searchParams.get("mode") ?? "normal") as Parameters<typeof uncertain>[1];
        if (!key) return json(res, 422, { error: "key required" });
        if (mode === "commit-then-hangup") {
            const out = await uncertain(key, "normal");
            // Commit is durable; destroy the socket so no response arrives.
            void out;
            req.socket.destroy();
            return;
        }
        return json(res, 200, await uncertain(key, mode));
    }
    if (url.pathname === "/uncertain-state") {
        const { rows } = await pool.query(
            `SELECT idem_key, applied_by_deployment, applied_at FROM q01b_uncertain ORDER BY applied_at`
        );
        return json(res, 200, { rows });
    }
    json(res, 404, { error: "NOT_FOUND" });
}

createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(res, 500, { error: e.message }));
}).listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Q01B qualification runtime listening on ${PORT}`, JSON.stringify(identity()));
});
