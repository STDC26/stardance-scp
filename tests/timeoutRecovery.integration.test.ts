// Part C — REQ-OPS-TIMEOUT-09 CRITICAL STRESS CHECK.
//
// Runs against a REAL local Postgres instance (not mocked) because a race
// condition proof that mocks the database proves nothing about the actual
// lock discipline. Gated behind RUN_INTEGRATION=1 (see package.json
// `test:integration`) so the default unit-test run stays fast and
// DB-free.
//
// Setup (one-time, local Postgres already running on this machine):
//   npm run db:test:setup    # creates freshline_msos_test
//   npm run db:test:schema   # applies db/schema.sql
//   npm run test:integration

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { recoverExpiredDispatches } from "../src/services/timeoutRecovery";
import { resolveDispatch } from "../src/services/dispatchAcceptance";
import { getIntegrationPool, resetSchema, seedDispatchedAppointment } from "./testDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

// G1R-02: contractor identities are UUIDs (appointments.contractor_id is a
// UUID column). These fixtures were previously human-readable labels, which
// aborted the transaction with SQLSTATE 22P02 the moment the webhook path
// actually reached its UPDATE. Fixed, stable UUIDs — not generated — so a
// failing run names the same identity every time.
const CONTRACTOR_LATE_ARRIVAL = "3f2a9c14-6b7d-4e58-9a01-2d5c8e7b4f31";
const CONTRACTOR_RACE = "8c41d0e7-52b9-4a63-b17f-9e6a3c208d54";

d("Timeout sweep vs. acceptance webhook — same-millisecond race (REQ-OPS-TIMEOUT-09)", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getIntegrationPool();
        await resetSchema(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    async function historyRowsFor(appointmentId: string) {
        const { rows } = await pool.query(
            `SELECT from_status, to_status, changed_by, version_at_change
               FROM appointment_status_history
              WHERE appointment_id = $1
              ORDER BY history_id ASC`,
            [appointmentId]
        );
        return rows as Array<{
            from_status: string;
            to_status: string;
            changed_by: string;
            version_at_change: number;
        }>;
    }

    it("safety net: sweep does NOT touch a dispatch that is not yet expired", async () => {
        const { appointmentId } = await seedDispatchedAppointment(pool, 5); // only 5 min old
        const result = await recoverExpiredDispatches(pool, { timeoutMinutes: 15 });
        expect(result.reverted).not.toContain(appointmentId);

        const { rows } = await pool.query(`SELECT status FROM appointments WHERE appointment_id = $1`, [
            appointmentId
        ]);
        expect(rows[0].status).toBe("CONTRACTOR_DISPATCHED");
    });

    it("sweep reverts a genuinely expired dispatch to PENDING_ACCEPTANCE with a clean audit row", async () => {
        const { appointmentId } = await seedDispatchedAppointment(pool, 16); // past 15-min window
        const result = await recoverExpiredDispatches(pool, { timeoutMinutes: 15 });
        expect(result.reverted).toContain(appointmentId);

        const { rows } = await pool.query(
            `SELECT status, contractor_id, dispatched_at, version FROM appointments WHERE appointment_id = $1`,
            [appointmentId]
        );
        expect(rows[0].status).toBe("PENDING_ACCEPTANCE");
        expect(rows[0].contractor_id).toBeNull();
        expect(rows[0].dispatched_at).toBeNull();
        expect(rows[0].version).toBe(2);

        const history = await historyRowsFor(appointmentId);
        expect(history).toHaveLength(1);
        expect(history[0]!.to_status).toBe("PENDING_ACCEPTANCE");
    });

    it("resolveDispatch on a row already reverted by the sweep returns STALE_STATE, never overwrites", async () => {
        const { appointmentId } = await seedDispatchedAppointment(pool, 16);
        const sweepResult = await recoverExpiredDispatches(pool, { timeoutMinutes: 15 });
        expect(sweepResult.reverted).toContain(appointmentId);

        const webhookResult = await resolveDispatch(
            pool,
            appointmentId,
            CONTRACTOR_LATE_ARRIVAL,
            "ACCEPT",
            `WEBHOOK:${CONTRACTOR_LATE_ARRIVAL}`
        );
        expect(webhookResult.success).toBe(false);
        if (!webhookResult.success && webhookResult.reasonCode === "STALE_STATE") {
            expect(webhookResult.currentStatus).toBe("PENDING_ACCEPTANCE");
        }

        const history = await historyRowsFor(appointmentId);
        // Still exactly one transition — the webhook must not have written
        // a second history row.
        expect(history).toHaveLength(1);
    });

    it(
        "CRITICAL STRESS CHECK: sweep and a valid acceptance webhook fired concurrently on the same row " +
            "never both succeed, and the row ends in a single, consistent, audited state",
        async () => {
            // Run the race many times: a race condition proof is only
            // convincing if it survives repeated adversarial scheduling,
            // not just one lucky interleaving.
            const ITERATIONS = 25;

            for (let i = 0; i < ITERATIONS; i++) {
                const { appointmentId } = await seedDispatchedAppointment(pool, 16); // already expired

                // Fire both paths in the same tick with Promise.all — both
                // requests reach Postgres and attempt SELECT ... FOR UPDATE
                // on the identical row at effectively the same instant.
                const [sweepResult, webhookResult] = await Promise.all([
                    recoverExpiredDispatches(pool, { timeoutMinutes: 15 }),
                    resolveDispatch(
                        pool,
                        appointmentId,
                        CONTRACTOR_RACE,
                        "ACCEPT",
                        `WEBHOOK:${CONTRACTOR_RACE}`
                    )
                ]);

                const sweepWon = sweepResult.reverted.includes(appointmentId);
                const webhookWon = webhookResult.success === true;

                // INVARIANT 1: exactly one side wins. Never both (dual
                // history / duplicate dispatch), never neither (a
                // legitimately expired, legitimately-responded-to row must
                // resolve one way or the other, not get stuck).
                expect(sweepWon !== webhookWon).toBe(true);

                // INVARIANT 2: exactly one audit-history row exists for
                // this appointment — no dual-history commitment.
                const history = await historyRowsFor(appointmentId);
                expect(history).toHaveLength(1);

                // INVARIANT 3: the row's final persisted status agrees
                // with whichever side the functions themselves reported as
                // the winner — no split-brain between what the service
                // returned and what's actually committed.
                const { rows } = await pool.query(
                    `SELECT status, version FROM appointments WHERE appointment_id = $1`,
                    [appointmentId]
                );
                const finalStatus = rows[0].status as string;

                if (sweepWon) {
                    expect(finalStatus).toBe("PENDING_ACCEPTANCE");
                    expect(webhookResult.success).toBe(false);
                    if (!webhookResult.success && webhookResult.reasonCode === "STALE_STATE") {
                        expect(webhookResult.currentStatus).toBe("PENDING_ACCEPTANCE");
                    }
                } else {
                    expect(finalStatus).toBe("CONTRACTOR_ACCEPTED");
                    expect(sweepResult.reverted).not.toContain(appointmentId);
                }

                // INVARIANT 4: version incremented exactly once (1 -> 2),
                // never twice — proves the loser's UPDATE never partially
                // applied.
                expect(rows[0].version).toBe(2);
            }
        }
    );
});
