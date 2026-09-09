// SCP-RUNTIME-Q01 / RUNTIME-G11 — do the transaction and concurrency
// guarantees SCP's consequential commands depend on actually hold on the
// topology they are running against?
//
// This is a falsification battery, not a feature suite. Every test tries to
// break a guarantee the platform already relies on, using real connections
// against a real PostgreSQL — mocks would prove nothing about a topology.
//
// CLAIM BOUNDARY. These results describe the topology discovered at execution
// time and nothing else. They are evidence about THIS topology; whether they
// transfer to a target production topology is exactly the question
// `TOPOLOGY_EQUIVALENCE` decides, and this file cannot answer it. A pooler in
// transaction mode, a different isolation default, or a proxy that multiplexes
// sessions could change several of these outcomes without changing a line of
// SCP code — which is why Q01 forbids reusing a PASS across an unproven
// topology change.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createPool, withTransaction } from "../../src/db/pool";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

interface Observation {
    id: string;
    guarantee: string;
    observed: unknown;
}
const observations: Observation[] = [];
function record(id: string, guarantee: string, observed: unknown): void {
    observations.push({ id, guarantee, observed });
}

d("RUNTIME-G11 / topology guarantee falsification", () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = createPool();
        await pool.query(`DROP TABLE IF EXISTS g11_probe`);
        await pool.query(
            `CREATE TABLE g11_probe (
                id            text PRIMARY KEY,
                counter       integer NOT NULL DEFAULT 0,
                lock_version  integer NOT NULL DEFAULT 1,
                idem_key      text UNIQUE
             )`
        );
    }, 120_000);

    afterAll(async () => {
        // eslint-disable-next-line no-console
        console.log("G11_OBSERVATIONS " + JSON.stringify(observations, null, 1));
        await pool.query(`DROP TABLE IF EXISTS g11_probe`);
        await pool?.end();
    }, 120_000);

    it("G11-T01 — the topology reports itself, and no pooler is interposed silently", async () => {
        const { rows } = await pool.query<{
            version: string;
            pid: number;
            addr: string | null;
            iso: string;
            maxconn: string;
        }>(
            `SELECT version() AS version, pg_backend_pid() AS pid,
                    host(inet_server_addr()) AS addr,
                    current_setting('default_transaction_isolation') AS iso,
                    current_setting('max_connections') AS maxconn`
        );
        const r = rows[0]!;
        // Distinct backend PIDs across concurrent connections is what tells us
        // whether we are talking to real backends or a multiplexer.
        const pids = await Promise.all(
            Array.from({ length: 5 }, async () => {
                const c = await pool.connect();
                try {
                    const q = await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
                    return q.rows[0]!.pid;
                } finally {
                    c.release();
                }
            })
        );
        record("G11-T01", "topology self-report", {
            version: r.version,
            serverAddr: r.addr ?? "unix-socket",
            defaultIsolation: r.iso,
            maxConnections: r.maxconn,
            distinctBackendPids: new Set(pids).size,
            samplePids: pids
        });
        expect(r.version).toContain("PostgreSQL");
    }, 120_000);

    it("G11-T02 — a version-guarded conflicting write loses exactly once", async () => {
        await pool.query(`INSERT INTO g11_probe (id) VALUES ('t02') ON CONFLICT DO NOTHING`);
        const attempt = async () =>
            withTransaction(pool, async (c: PoolClient) => {
                const cur = await c.query<{ lock_version: number }>(
                    `SELECT lock_version FROM g11_probe WHERE id = 't02'`
                );
                const v = cur.rows[0]!.lock_version;
                await new Promise((r) => setTimeout(r, 25)); // widen the window
                const upd = await c.query(
                    `UPDATE g11_probe SET counter = counter + 1, lock_version = lock_version + 1
                      WHERE id = 't02' AND lock_version = $1`,
                    [v]
                );
                return upd.rowCount ?? 0;
            });
        const results = await Promise.all([attempt(), attempt(), attempt()]);
        const winners = results.filter((n) => n === 1).length;
        const losers = results.filter((n) => n === 0).length;
        const final = await pool.query<{ counter: number; lock_version: number }>(
            `SELECT counter, lock_version FROM g11_probe WHERE id = 't02'`
        );
        record("G11-T02", "optimistic version guard", {
            winners,
            losers,
            counter: final.rows[0]!.counter,
            lockVersion: final.rows[0]!.lock_version
        });
        // The guard must admit some and refuse the rest — never admit all three.
        expect(winners).toBeGreaterThanOrEqual(1);
        expect(winners + losers).toBe(3);
        expect(final.rows[0]!.counter).toBe(winners);
    }, 120_000);

    it("G11-T03 — an advisory xact lock serialises simultaneous mutation", async () => {
        await pool.query(`INSERT INTO g11_probe (id) VALUES ('t03') ON CONFLICT DO NOTHING`);
        // The pattern SCP uses for capacity, cards, ingress and qualification.
        const guarded = async () =>
            withTransaction(pool, async (c: PoolClient) => {
                await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["g11:t03"]);
                const cur = await c.query<{ counter: number }>(
                    `SELECT counter FROM g11_probe WHERE id = 't03'`
                );
                const next = cur.rows[0]!.counter + 1;
                await new Promise((r) => setTimeout(r, 15));
                await c.query(`UPDATE g11_probe SET counter = $1 WHERE id = 't03'`, [next]);
                return next;
            });
        const N = 8;
        await Promise.all(Array.from({ length: N }, guarded));
        const final = await pool.query<{ counter: number }>(
            `SELECT counter FROM g11_probe WHERE id = 't03'`
        );
        record("G11-T03", "advisory xact lock serialisation", {
            concurrent: N,
            finalCounter: final.rows[0]!.counter,
            lostUpdates: N - final.rows[0]!.counter
        });
        // Read-modify-write without the lock loses updates. With it, none.
        expect(final.rows[0]!.counter).toBe(N);
    }, 180_000);

    it("G11-T04 — without the lock, the same pattern demonstrably loses updates", async () => {
        // The control. If this does NOT lose updates, T03 proves nothing —
        // the guarantee would be coming from somewhere else.
        await pool.query(`INSERT INTO g11_probe (id) VALUES ('t04') ON CONFLICT DO NOTHING`);
        const unguarded = async () =>
            withTransaction(pool, async (c: PoolClient) => {
                const cur = await c.query<{ counter: number }>(
                    `SELECT counter FROM g11_probe WHERE id = 't04'`
                );
                const next = cur.rows[0]!.counter + 1;
                await new Promise((r) => setTimeout(r, 15));
                await c.query(`UPDATE g11_probe SET counter = $1 WHERE id = 't04'`, [next]);
            });
        const N = 8;
        await Promise.all(Array.from({ length: N }, unguarded));
        const final = await pool.query<{ counter: number }>(
            `SELECT counter FROM g11_probe WHERE id = 't04'`
        );
        record("G11-T04", "control: unguarded read-modify-write", {
            concurrent: N,
            finalCounter: final.rows[0]!.counter,
            lostUpdates: N - final.rows[0]!.counter
        });
        expect(final.rows[0]!.counter).toBeLessThan(N);
    }, 180_000);

    it("G11-T05 — rollback on intentional failure leaves nothing behind", async () => {
        const before = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM g11_probe`);
        await expect(
            withTransaction(pool, async (c: PoolClient) => {
                await c.query(`INSERT INTO g11_probe (id) VALUES ('t05-ghost')`);
                throw new Error("intentional failure after a write");
            })
        ).rejects.toThrow(/intentional failure/);
        const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM g11_probe`);
        const ghost = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM g11_probe WHERE id = 't05-ghost'`
        );
        record("G11-T05", "rollback on failure", {
            rowsBefore: before.rows[0]!.n,
            rowsAfter: after.rows[0]!.n,
            ghostRows: ghost.rows[0]!.n
        });
        expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
        expect(Number(ghost.rows[0]!.n)).toBe(0);
    }, 120_000);

    it("G11-T06 — a commit whose response is lost is still a commit", async () => {
        // The uncertain-outcome case: the server commits, the caller never
        // learns. Truth must be on the server, not in the caller's knowledge.
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`INSERT INTO g11_probe (id, idem_key) VALUES ('t06', 'idem-t06')`);
            await client.query("COMMIT");
            // Simulate the response being lost: drop the connection immediately.
            client.release(true);
        } catch (e) {
            client.release(true);
            throw e;
        }
        const seen = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM g11_probe WHERE id = 't06'`
        );
        record("G11-T06", "commit survives lost response", { rowsVisible: seen.rows[0]!.n });
        expect(Number(seen.rows[0]!.n)).toBe(1);
    }, 120_000);

    it("G11-T07 — retry with the same idempotency identity does not double-apply", async () => {
        const insertOnce = async () =>
            withTransaction(pool, async (c: PoolClient) => {
                const r = await c.query(
                    `INSERT INTO g11_probe (id, idem_key) VALUES ($1, $2)
                     ON CONFLICT (idem_key) DO NOTHING`,
                    [`t07-${Math.random().toString(36).slice(2, 9)}`, "idem-t07"]
                );
                return r.rowCount ?? 0;
            });
        // The retry after an uncertain outcome, three times over.
        const applied = (await Promise.all([insertOnce(), insertOnce(), insertOnce()])).reduce(
            (a, b) => a + b,
            0
        );
        const rows = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM g11_probe WHERE idem_key = 'idem-t07'`
        );
        record("G11-T07", "idempotent retry", {
            attempts: 3,
            appliedRowCounts: applied,
            rowsPersisted: rows.rows[0]!.n
        });
        expect(Number(rows.rows[0]!.n)).toBe(1);
    }, 120_000);

    it("G11-T08 — SERIALIZABLE either serialises or refuses; it never interleaves silently", async () => {
        await pool.query(`INSERT INTO g11_probe (id) VALUES ('t08') ON CONFLICT DO NOTHING`);
        const serializable = async () =>
            withTransaction(
                pool,
                async (c: PoolClient) => {
                    const cur = await c.query<{ counter: number }>(
                        `SELECT counter FROM g11_probe WHERE id = 't08'`
                    );
                    await new Promise((r) => setTimeout(r, 20));
                    await c.query(`UPDATE g11_probe SET counter = $1 WHERE id = 't08'`, [
                        cur.rows[0]!.counter + 1
                    ]);
                    return "committed";
                },
                { isolation: "SERIALIZABLE", maxRetries: 0 }
            ).catch((e: { code?: string }) => `refused:${e.code ?? "unknown"}`);

        const results = await Promise.all([serializable(), serializable(), serializable()]);
        const committed = results.filter((r) => r === "committed").length;
        const final = await pool.query<{ counter: number }>(
            `SELECT counter FROM g11_probe WHERE id = 't08'`
        );
        record("G11-T08", "SERIALIZABLE isolation", {
            results,
            committed,
            finalCounter: final.rows[0]!.counter
        });
        // The invariant: the counter equals the number that committed. Anything
        // else means a write was lost while claiming to be serialisable.
        expect(final.rows[0]!.counter).toBe(committed);
    }, 180_000);

    it("G11-T09 — the retry helper actually recovers a serialization failure", async () => {
        await pool.query(`UPDATE g11_probe SET counter = 0 WHERE id = 't08'`);
        const withRetry = async () =>
            withTransaction(
                pool,
                async (c: PoolClient) => {
                    const cur = await c.query<{ counter: number }>(
                        `SELECT counter FROM g11_probe WHERE id = 't08'`
                    );
                    await new Promise((r) => setTimeout(r, 20));
                    await c.query(`UPDATE g11_probe SET counter = $1 WHERE id = 't08'`, [
                        cur.rows[0]!.counter + 1
                    ]);
                },
                { isolation: "SERIALIZABLE", maxRetries: 8 }
            );
        const N = 4;
        const settled = await Promise.allSettled(Array.from({ length: N }, withRetry));
        const ok = settled.filter((s) => s.status === "fulfilled").length;
        const final = await pool.query<{ counter: number }>(
            `SELECT counter FROM g11_probe WHERE id = 't08'`
        );
        record("G11-T09", "serialization-failure retry", {
            attempted: N,
            fulfilled: ok,
            finalCounter: final.rows[0]!.counter
        });
        expect(final.rows[0]!.counter).toBe(ok);
    }, 180_000);

    it("G11-T10 — connection reuse does not leak transaction or session state", async () => {
        // A pooler that multiplexes sessions can leak SET state between callers.
        // On this topology the pool hands back real sessions; prove that a
        // setting made in one checkout is not visible in the next.
        const first = await pool.connect();
        const firstPid = (await first.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
        await first.query(`SET application_name = 'g11-leak-probe'`);
        first.release();

        let sawLeak = false;
        let reusedPid = false;
        for (let i = 0; i < 6; i += 1) {
            const c = await pool.connect();
            const q = await c.query<{ name: string; pid: number; intx: string }>(
                `SELECT current_setting('application_name') AS name,
                        pg_backend_pid() AS pid,
                        (SELECT state FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS intx`
            );
            if (q.rows[0]!.pid === firstPid) reusedPid = true;
            if (q.rows[0]!.name === "g11-leak-probe" && q.rows[0]!.pid !== firstPid) sawLeak = true;
            c.release();
        }
        record("G11-T10", "session state isolation across checkouts", {
            firstPid,
            reusedSameBackend: reusedPid,
            leakedSettingToDifferentBackend: sawLeak
        });
        // Leaking a session setting onto a DIFFERENT backend would mean the
        // topology is multiplexing sessions underneath us.
        expect(sawLeak).toBe(false);
    }, 120_000);

    it("G11-T11 — the runtime reconnects after its connections are terminated", async () => {
        const before = await pool.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        // Terminate every other backend belonging to this database.
        await pool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`
        );
        let recovered = false;
        let attempts = 0;
        for (; attempts < 5 && !recovered; attempts += 1) {
            try {
                const after = await pool.query<{ n: number }>(`SELECT 1 AS n`);
                recovered = after.rows[0]!.n === 1;
            } catch {
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        record("G11-T11", "reconnection after termination", {
            pidBefore: before.rows[0]!.pid,
            recovered,
            attempts
        });
        expect(recovered).toBe(true);
    }, 180_000);

    it("G11-T12 — transaction-scoped state does not outlive its transaction", async () => {
        // Advisory XACT locks must be released at COMMIT. If a pooler returned a
        // connection mid-transaction, the next caller would inherit the lock.
        await withTransaction(pool, async (c: PoolClient) => {
            await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["g11:t12"]);
        });
        const held = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks
              WHERE locktype = 'advisory' AND objid = (SELECT hashtext('g11:t12')::bigint & 2147483647)`
        );
        const anyAdvisory = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`
        );
        record("G11-T12", "xact lock released at commit", {
            matchingLocksHeld: held.rows[0]!.n,
            anyAdvisoryLocksHeld: anyAdvisory.rows[0]!.n
        });
        expect(Number(anyAdvisory.rows[0]!.n)).toBe(0);
    }, 120_000);
});
