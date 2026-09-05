// Freshline Studio Bali — MSOS Phase 0/1
// REQ-OPS-TIMEOUT-09: scan for appointments stuck in CONTRACTOR_DISPATCHED
// longer than the timeout window and revert them to PENDING_ACCEPTANCE.
//
// RACE THIS MUST SURVIVE: a provider acceptance webhook (see
// dispatchAcceptance.ts) can land at the exact same millisecond the sweep
// fires for the same appointment_id. Both paths must never both "win" —
// exactly one status_history row may record the terminal transition off
// CONTRACTOR_DISPATCHED, and the loser must observe that it lost, not throw
// or silently double-write.
//
// STRATEGY: candidate IDs are discovered with a lock-free scan (cheap, can
// run at any frequency), but the actual transition happens one row at a
// time inside SELECT ... FOR UPDATE. Postgres blocks the second transaction
// attempting FOR UPDATE on that row until the first COMMITs; once unblocked,
// the second transaction's SELECT re-reads the now-committed row (this is
// standard READ COMMITTED MVCC behavior, not a bug to work around) — so the
// re-check of `status` after acquiring the lock is what actually prevents
// the double-transition, not the isolation level. The `version` column is
// kept as defense-in-depth for any future code path that mutates
// appointments outside this lock discipline.

import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import type { RecoveryResult } from "../types";

export const DEFAULT_TIMEOUT_MINUTES = 15;
const SWEEP_ACTOR = "SYSTEM_TIMEOUT_SWEEP";

export interface TimeoutRecoveryOptions {
    timeoutMinutes?: number;
    /** Cap on candidates processed per sweep call, to bound worst-case runtime. */
    batchSize?: number;
    /** Injectable for tests; defaults to `new Date()`. */
    now?: () => Date;
}

async function findCandidateIds(
    client: PoolClient,
    cutoff: Date,
    batchSize: number
): Promise<string[]> {
    const { rows } = await client.query<{ appointment_id: string }>(
        `SELECT appointment_id
           FROM appointments
          WHERE status = 'CONTRACTOR_DISPATCHED'
            AND dispatched_at < $1
          ORDER BY dispatched_at ASC
          LIMIT $2`,
        [cutoff, batchSize]
    );
    return rows.map((r) => r.appointment_id);
}

/**
 * Attempts to revert exactly one candidate appointment. Re-validates the
 * expiry condition *after* acquiring the row lock, because the row may have
 * changed between the lock-free scan and this transaction acquiring the
 * lock (e.g. a webhook accepted it in the interim). Returns which outcome
 * occurred so the caller can build an accurate RecoveryResult.
 */
async function revertOneIfStillExpired(
    pool: Pool,
    appointmentId: string,
    cutoff: Date
): Promise<"REVERTED" | "ALREADY_RESOLVED" | "NOT_YET_EXPIRED"> {
    return withTransaction(
        pool,
        async (client) => {
            const { rows } = await client.query<{
                status: string;
                dispatched_at: Date | null;
                version: number;
            }>(
                `SELECT status, dispatched_at, version
                   FROM appointments
                  WHERE appointment_id = $1
                  FOR UPDATE`,
                [appointmentId]
            );

            const row = rows[0];
            if (!row) {
                return "ALREADY_RESOLVED";
            }

            if (row.status !== "CONTRACTOR_DISPATCHED") {
                // Lost the race: a webhook (or something else) already
                // moved this row off CONTRACTOR_DISPATCHED while we were
                // waiting for the lock. This is the expected, safe outcome
                // of the race — not an error.
                return "ALREADY_RESOLVED";
            }

            if (!row.dispatched_at || row.dispatched_at >= cutoff) {
                // Re-check: by the time we got the lock, this appointment
                // may no longer be past the timeout threshold (defensive;
                // shouldn't happen given dispatched_at is immutable once
                // set, but costs nothing to guard).
                return "NOT_YET_EXPIRED";
            }

            const updateResult = await client.query(
                `UPDATE appointments
                    SET status = 'PENDING_ACCEPTANCE',
                        contractor_id = NULL,
                        dispatched_at = NULL,
                        version = version + 1
                  WHERE appointment_id = $1
                    AND version = $2`,
                [appointmentId, row.version]
            );

            if (updateResult.rowCount === 0) {
                // Version guard tripped (defense-in-depth path — should be
                // unreachable given the FOR UPDATE lock above, but if it
                // ever fires it means something mutated this row without
                // taking the lock, which is exactly the bug class this
                // guard exists to catch).
                return "ALREADY_RESOLVED";
            }

            await client.query(
                `INSERT INTO appointment_status_history
                    (appointment_id, from_status, to_status, version_at_change, changed_by, reason)
                 VALUES ($1, 'CONTRACTOR_DISPATCHED', 'PENDING_ACCEPTANCE', $2, $3, $4)`,
                [
                    appointmentId,
                    row.version + 1,
                    SWEEP_ACTOR,
                    `Reverted: no contractor response within timeout window (dispatched_at=${row.dispatched_at.toISOString()})`
                ]
            );

            return "REVERTED";
        },
        { isolation: "READ COMMITTED" }
    );
}

/**
 * Scans for appointments that have sat in CONTRACTOR_DISPATCHED past the
 * timeout window and reverts each to PENDING_ACCEPTANCE. Safe to call
 * concurrently with itself and with dispatch-acceptance webhooks; each
 * candidate is resolved independently so one slow/contended row never
 * blocks the rest of the batch from being scanned (though it does block
 * until that specific row's lock is released).
 */
export async function recoverExpiredDispatches(
    pool: Pool,
    options: TimeoutRecoveryOptions = {}
): Promise<RecoveryResult> {
    const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
    const batchSize = options.batchSize ?? 200;
    const now = (options.now ?? (() => new Date()))();
    const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);

    const result: RecoveryResult = {
        scannedCandidates: 0,
        reverted: [],
        skippedAlreadyResolved: [],
        errors: []
    };

    const client = await pool.connect();
    let candidateIds: string[];
    try {
        candidateIds = await findCandidateIds(client, cutoff, batchSize);
    } finally {
        client.release();
    }
    result.scannedCandidates = candidateIds.length;

    for (const appointmentId of candidateIds) {
        try {
            const outcome = await revertOneIfStillExpired(pool, appointmentId, cutoff);
            if (outcome === "REVERTED") {
                result.reverted.push(appointmentId);
            } else if (outcome === "ALREADY_RESOLVED") {
                result.skippedAlreadyResolved.push(appointmentId);
            }
            // NOT_YET_EXPIRED: silently skipped, will be picked up by a
            // later sweep if it's still dispatched by then.
        } catch (err) {
            result.errors.push({
                appointmentId,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    return result;
}
