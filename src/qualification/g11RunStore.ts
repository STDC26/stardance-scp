// SCP-RUNTIME-Q01B-QCP2A-R01 — durable custody for pinned G11 proof runs.
//
// Proof infrastructure, not product architecture. Nothing in the SCP candidate
// reads these tables, no product code path writes them, and they carry no
// canonical business truth. They exist so that a proof survives the process
// that produced it.
//
// WHY THIS FILE EXISTS. Fresh IRF ran A10 against the previous bridge and
// falsified its G11 contract (QCP2A_IRF_EXECUTION_BRIDGE_NONCONFORMANT). The
// bridge kept run state in a Map. The pinned battery's G11-T11 terminates every
// other backend on the database, which killed the bridge's own idle pooled
// connections; pg-pool re-emitted that as an unhandled 'error' and the process
// died. Four runs, four crashes, zero retrievable results.
//
// The lesson is not "stop the crash". It is that proof custody must not live in
// the memory of the thing being crashed. So run state is written to PostgreSQL
// before the battery starts and updated incrementally while it runs.
//
// The awkward part, and the reason this file is not just a couple of INSERTs:
// G11-T11 terminates *every other backend on this database*, which includes the
// connections this store is using to record the very run that is doing the
// terminating. The store therefore has to survive its own storage being killed
// mid-write. Every write goes through `durable()`, which treats connection loss
// as expected and retries on a fresh backend.

import type { Pool } from "pg";
import { createPool } from "../db/pool";

export type RunState = "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";
export type Stream = "stdout" | "stderr";

/**
 * SQLSTATEs that mean "the connection went away", not "the query was wrong".
 *
 * 57P01 (admin_shutdown) is the one G11-T11 produces via pg_terminate_backend:
 * "terminating connection due to administrator command". The 08* class covers
 * the socket being torn out underneath us.
 */
const CONNECTION_LOSS_SQLSTATES = new Set([
    "57P01", // admin_shutdown — pg_terminate_backend, i.e. exactly what T11 does
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
    "08000", // connection_exception
    "08003", // connection_does_not_exist
    "08006" // connection_failure
]);

const CONNECTION_LOSS_PATTERN =
    /terminating connection due to administrator command|connection terminated|server closed the connection|ECONNRESET|EPIPE|Client has encountered a connection error|connection not open/i;

export function isConnectionLoss(e: unknown): boolean {
    const err = e as { code?: string; message?: string } | null;
    if (!err) return false;
    if (err.code && CONNECTION_LOSS_SQLSTATES.has(err.code)) return true;
    return typeof err.message === "string" && CONNECTION_LOSS_PATTERN.test(err.message);
}

export function describeError(e: unknown): Record<string, unknown> {
    const err = e as { message?: string; code?: string; severity?: string; detail?: string } | null;
    return {
        message: err?.message ?? String(e),
        code: err?.code ?? null,
        severity: err?.severity ?? null,
        detail: err?.detail ?? null,
        connectionLoss: isConnectionLoss(e),
        observedAt: new Date().toISOString()
    };
}

const DDL = `
CREATE TABLE IF NOT EXISTS qcp2a_g11_runs (
    run_id                     uuid PRIMARY KEY,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    started_at                 timestamptz,
    completed_at               timestamptz,
    state                      text NOT NULL,
    battery_path               text NOT NULL,
    battery_sha256             text NOT NULL,
    battery_bytes              integer NOT NULL,
    battery_test_count         integer,
    bridge_deployment_id       text,
    bridge_process_identity    text,
    candidate_deployment_id    text,
    candidate_runtime_identity jsonb,
    database_identity          jsonb,
    stdout_raw                 text,
    stderr_raw                 text,
    exit_code                  integer,
    duration_ms                integer,
    termination_reason         text,
    bridge_restart_observed    boolean NOT NULL DEFAULT false,
    error_json                 jsonb,
    result_summary_json        jsonb,
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Append-only. State transitions and raw output chunks are never updated in
-- place, so the full history of a run is reconstructable even if the summary
-- row was mid-write when the process died.
CREATE TABLE IF NOT EXISTS qcp2a_g11_run_events (
    event_id  bigserial PRIMARY KEY,
    run_id    uuid NOT NULL,
    at        timestamptz NOT NULL DEFAULT now(),
    kind      text NOT NULL,
    stream    text,
    seq       integer,
    chunk     text,
    detail    jsonb
);

CREATE INDEX IF NOT EXISTS qcp2a_g11_run_events_run_idx
    ON qcp2a_g11_run_events (run_id, event_id);

-- Makes chunk persistence idempotent: a retry after connection loss cannot
-- double-append the same chunk.
CREATE UNIQUE INDEX IF NOT EXISTS qcp2a_g11_run_events_chunk_idx
    ON qcp2a_g11_run_events (run_id, stream, seq)
    WHERE kind = 'OUTPUT_CHUNK';
`;

export interface RunSeed {
    runId: string;
    batteryPath: string;
    batterySha256: string;
    batteryBytes: number;
    batteryTestCount: number | null;
    bridgeDeploymentId: string | null;
    bridgeProcessIdentity: string;
    candidateDeploymentId: string | null;
    candidateRuntimeIdentity: unknown;
    databaseIdentity: unknown;
}

export class G11RunStore {
    private readonly pool: Pool;

    constructor(pool?: Pool) {
        this.pool = pool ?? createPool({ max: 4 });
        // Without this, a pooled connection killed by G11-T11 while idle becomes
        // an unhandled 'error' on the pool and takes the process down — the
        // original QCP2A-D01-A defect, in the store instead of the bridge.
        this.pool.on("error", () => {
            // Deliberately inert. The store's job here is only to stop an idle
            // pooled client's death from being fatal; classification, durable
            // recording and visibility are handled by the bridge's own pool
            // error handler, which has the run context to attribute it.
        });
    }

    /**
     * Every write in this file goes through here.
     *
     * The battery deliberately kills the connections this store writes over, so
     * connection loss is an expected condition rather than a failure: retry on a
     * fresh backend. A non-connection error is a real fault and propagates.
     */
    private async durable<T>(fn: (pool: Pool) => Promise<T>, attempts = 6): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i < attempts; i += 1) {
            try {
                return await fn(this.pool);
            } catch (e) {
                lastError = e;
                if (!isConnectionLoss(e)) throw e;
                // Backend was terminated. Give Postgres a moment to accept a new
                // connection, then try again on a fresh one.
                await new Promise((r) => setTimeout(r, 150 * (i + 1)));
            }
        }
        throw lastError;
    }

    async initSchema(): Promise<void> {
        await this.durable((p) => p.query(DDL));
    }

    async createRun(seed: RunSeed): Promise<void> {
        await this.durable((p) =>
            p.query(
                `INSERT INTO qcp2a_g11_runs (
                     run_id, state, battery_path, battery_sha256, battery_bytes,
                     battery_test_count, bridge_deployment_id, bridge_process_identity,
                     candidate_deployment_id, candidate_runtime_identity, database_identity,
                     stdout_raw, stderr_raw
                 ) VALUES ($1,'CREATED',$2,$3,$4,$5,$6,$7,$8,$9,$10,'','')
                 ON CONFLICT (run_id) DO NOTHING`,
                [
                    seed.runId,
                    seed.batteryPath,
                    seed.batterySha256,
                    seed.batteryBytes,
                    seed.batteryTestCount,
                    seed.bridgeDeploymentId,
                    seed.bridgeProcessIdentity,
                    seed.candidateDeploymentId,
                    JSON.stringify(seed.candidateRuntimeIdentity ?? null),
                    JSON.stringify(seed.databaseIdentity ?? null)
                ]
            )
        );
        await this.appendEvent(seed.runId, "CREATED", { bridgeProcessIdentity: seed.bridgeProcessIdentity });
    }

    async markRunning(runId: string): Promise<void> {
        await this.durable((p) =>
            p.query(
                `UPDATE qcp2a_g11_runs
                    SET state='RUNNING', started_at=COALESCE(started_at, now()), updated_at=now()
                  WHERE run_id=$1`,
                [runId]
            )
        );
        await this.appendEvent(runId, "RUNNING", null);
    }

    async appendEvent(
        runId: string,
        kind: string,
        detail: unknown,
        stream?: Stream,
        seq?: number,
        chunk?: string
    ): Promise<void> {
        try {
            await this.durable((p) =>
                p.query(
                    `INSERT INTO qcp2a_g11_run_events (run_id, kind, stream, seq, chunk, detail)
                     VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT DO NOTHING`,
                    [runId, kind, stream ?? null, seq ?? null, chunk ?? null, JSON.stringify(detail ?? null)]
                )
            );
        } catch {
            // An event write that cannot be recovered must not abort the run or
            // the process. The run row and surviving events remain the evidence;
            // losing one event is visible as a gap in seq, which is honest.
        }
    }

    /** Incremental raw output capture — the point is that it lands before the end of the run. */
    async appendChunk(runId: string, stream: Stream, seq: number, chunk: string): Promise<void> {
        await this.appendEvent(runId, "OUTPUT_CHUNK", { bytes: Buffer.byteLength(chunk) }, stream, seq, chunk);
    }

    async recordPoolError(runId: string | null, err: unknown, expected: boolean): Promise<void> {
        const detail = { ...describeError(err), expected };
        if (runId) {
            await this.appendEvent(runId, expected ? "POOL_ERROR_EXPECTED" : "POOL_ERROR_UNEXPECTED", detail);
            if (!expected) {
                // An unexpected pool failure must stay visible in the run record,
                // not just in the event log. It may legitimately fail the run.
                await this.durable((p) =>
                    p.query(
                        `UPDATE qcp2a_g11_runs
                            SET error_json = COALESCE(error_json,'[]'::jsonb) || $2::jsonb,
                                updated_at = now()
                          WHERE run_id=$1`,
                        [runId, JSON.stringify([detail])]
                    )
                ).catch(() => undefined);
            }
        }
    }

    async completeRun(
        runId: string,
        out: {
            state: Extract<RunState, "COMPLETED" | "FAILED">;
            exitCode: number | null;
            durationMs: number;
            stdout: string;
            stderr: string;
            terminationReason: string | null;
            summary: unknown;
            error?: unknown;
        }
    ): Promise<void> {
        await this.durable((p) =>
            p.query(
                `UPDATE qcp2a_g11_runs
                    SET state=$2, completed_at=now(), exit_code=$3, duration_ms=$4,
                        stdout_raw=$5, stderr_raw=$6, termination_reason=$7,
                        result_summary_json=$8::jsonb,
                        error_json = CASE WHEN $9::jsonb IS NULL THEN error_json
                                          ELSE COALESCE(error_json,'[]'::jsonb) || $9::jsonb END,
                        updated_at=now()
                  WHERE run_id=$1`,
                [
                    runId,
                    out.state,
                    out.exitCode,
                    out.durationMs,
                    out.stdout,
                    out.stderr,
                    out.terminationReason,
                    JSON.stringify(out.summary ?? null),
                    out.error === undefined ? null : JSON.stringify([describeError(out.error)])
                ]
            )
        );
        await this.appendEvent(runId, out.state, {
            exitCode: out.exitCode,
            durationMs: out.durationMs,
            terminationReason: out.terminationReason
        });
    }

    /**
     * R5 — restart reconciliation.
     *
     * A run left CREATED/RUNNING by a process that is no longer alive did not
     * finish; it was interrupted. It is marked INTERRUPTED, never COMPLETED, and
     * never PASS. The previous owner's identity and the reason are recorded so
     * IRF can see exactly what happened rather than inferring it.
     */
    async reconcileOnStartup(currentProcessIdentity: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.durable((p) =>
            p.query<{ run_id: string; bridge_process_identity: string | null; state: string }>(
                `SELECT run_id, bridge_process_identity, state
                   FROM qcp2a_g11_runs
                  WHERE state IN ('CREATED','RUNNING')
                    AND bridge_process_identity IS DISTINCT FROM $1`,
                [currentProcessIdentity]
            )
        );
        for (const r of rows) {
            await this.durable((p) =>
                p.query(
                    `UPDATE qcp2a_g11_runs
                        SET state='INTERRUPTED',
                            bridge_restart_observed=true,
                            termination_reason=$2,
                            completed_at=COALESCE(completed_at, now()),
                            updated_at=now()
                      WHERE run_id=$1`,
                    [
                        r.run_id,
                        `verifier process restart: run was ${r.state} under process ` +
                            `${r.bridge_process_identity ?? "unknown"}, reconciled by ${currentProcessIdentity}`
                    ]
                )
            );
            await this.appendEvent(r.run_id, "RECONCILED_INTERRUPTED", {
                previousProcessIdentity: r.bridge_process_identity,
                previousState: r.state,
                reconciledBy: currentProcessIdentity,
                reconciledAt: new Date().toISOString(),
                reason: "verifier process restart; no active child process owns this run"
            });
        }
        return rows.map((r) => ({
            runId: r.run_id,
            previousState: r.state,
            previousProcessIdentity: r.bridge_process_identity
        }));
    }

    async getRun(runId: string): Promise<Record<string, unknown> | null> {
        const { rows } = await this.durable((p) =>
            p.query(`SELECT * FROM qcp2a_g11_runs WHERE run_id=$1`, [runId])
        );
        const run = rows[0];
        if (!run) return null;

        const events = await this.durable((p) =>
            p.query(
                `SELECT event_id, at, kind, stream, seq, detail
                   FROM qcp2a_g11_run_events
                  WHERE run_id=$1 AND kind <> 'OUTPUT_CHUNK'
                  ORDER BY event_id`,
                [runId]
            )
        );

        // Reconstruct raw output from the append-only chunks. This is what makes
        // a mid-run crash survivable: the summary columns may never have been
        // written, but every chunk that landed is still here.
        const chunks = await this.durable((p) =>
            p.query<{ stream: string; chunk: string }>(
                `SELECT stream, chunk FROM qcp2a_g11_run_events
                  WHERE run_id=$1 AND kind='OUTPUT_CHUNK'
                  ORDER BY stream, seq`,
                [runId]
            )
        );
        const joined = { stdout: "", stderr: "" };
        for (const c of chunks.rows) {
            if (c.stream === "stdout") joined.stdout += c.chunk;
            else if (c.stream === "stderr") joined.stderr += c.chunk;
        }

        const r = run as Record<string, unknown>;
        return {
            ...r,
            // Prefer the finalised columns; fall back to reconstructed chunks
            // when the run never reached completion.
            stdout_raw: (r["stdout_raw"] as string) || joined.stdout,
            stderr_raw: (r["stderr_raw"] as string) || joined.stderr,
            stdoutFromChunks: joined.stdout,
            stderrFromChunks: joined.stderr,
            events: events.rows
        };
    }

    async listRuns(): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.durable((p) =>
            p.query(
                `SELECT run_id, state, created_at, started_at, completed_at, exit_code,
                        bridge_restart_observed, bridge_process_identity
                   FROM qcp2a_g11_runs ORDER BY created_at DESC LIMIT 100`
            )
        );
        return rows as Array<Record<string, unknown>>;
    }
}
