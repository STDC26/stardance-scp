// Freshline Studio Bali — MSOS Phase 0/1
// Provider-facing counterpart to timeoutRecovery.ts. Handles an inbound
// "contractor responded to a dispatch" event (ACCEPT or DECLINE), whether it
// arrives via webhook or via the WhatsApp parser (see whatsappParser.ts).
//
// Uses the identical lock discipline as timeoutRecovery.ts: SELECT ... FOR
// UPDATE on the target row, re-check status after acquiring the lock, then
// mutate. This is what makes the two services race-safe against each other
// — whichever transaction acquires the row lock first commits its
// transition; the other blocks, wakes up to a re-read row that is no longer
// CONTRACTOR_DISPATCHED, and returns STALE_STATE instead of mutating.

import type { Pool } from "pg";
import { withTransaction } from "../db/pool";
import type { AppointmentStatus, DispatchResolutionOutcome } from "../types";

export type DispatchDecision = "ACCEPT" | "DECLINE";

// G1R-03: contractor_id is a UUID column. A malformed identity used to reach
// Postgres and abort the transaction with SQLSTATE 22P02 ("invalid input
// syntax for type uuid"), which surfaced to callers as an uncontrolled throw
// rather than a decision outcome. Shape is validated here, before any SQL is
// issued, so identity rejection is a first-class DispatchResolutionOutcome.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// G1R-01: how each decision resolves the *Service Request* row. ACCEPT binds
// the provider to the request. DECLINE resolves the Dispatch Offer only — the
// request itself is released back to PENDING_ACCEPTANCE for re-dispatch,
// exactly as the timeout sweep releases it. There is no top-level "declined"
// Service Request state to move into.
const DECISION_TO_REQUEST_STATUS: Record<DispatchDecision, AppointmentStatus> = {
    ACCEPT: "CONTRACTOR_ACCEPTED",
    DECLINE: "PENDING_ACCEPTANCE"
};

/**
 * Resolves a contractor's response to a dispatched appointment. `actor`
 * should identify the source, e.g. `WEBHOOK:<contractor_id>` or
 * `WHATSAPP:<event_id>`, and is written verbatim into the audit trail.
 */
export async function resolveDispatch(
    pool: Pool,
    appointmentId: string,
    contractorId: string,
    decision: DispatchDecision,
    actor: string
): Promise<DispatchResolutionOutcome> {
    if (!UUID_RE.test(contractorId)) {
        return {
            success: false,
            appointmentId,
            reasonCode: "INVALID_PROVIDER_IDENTITY",
            message: `contractorId ${JSON.stringify(contractorId)} is not a valid UUID`
        };
    }

    const targetStatus = DECISION_TO_REQUEST_STATUS[decision];

    return withTransaction(
        pool,
        async (client) => {
            const { rows } = await client.query<{
                status: AppointmentStatus;
                contractor_id: string | null;
                version: number;
            }>(
                `SELECT status, contractor_id, version
                   FROM appointments
                  WHERE appointment_id = $1
                  FOR UPDATE`,
                [appointmentId]
            );

            const row = rows[0];
            if (!row) {
                return { success: false, appointmentId, reasonCode: "NOT_FOUND" };
            }

            if (row.status !== "CONTRACTOR_DISPATCHED") {
                // Either the timeout sweep already reverted this row, or a
                // prior response was already recorded. Either way, this
                // call must not mutate state a second time.
                return {
                    success: false,
                    appointmentId,
                    reasonCode: "STALE_STATE",
                    currentStatus: row.status
                };
            }

            // G1R-01: an acceptance binds the provider to the request; a
            // decline releases the offer, clearing both the provider binding
            // and the dispatch clock so the sweep and re-dispatch see a clean
            // PENDING_ACCEPTANCE row. Both paths take the identical version
            // guard and write exactly one history row.
            const updateResult =
                decision === "ACCEPT"
                    ? await client.query(
                          `UPDATE appointments
                              SET status = $2,
                                  contractor_id = $3,
                                  version = version + 1
                            WHERE appointment_id = $1
                              AND version = $4`,
                          [appointmentId, targetStatus, contractorId, row.version]
                      )
                    : await client.query(
                          `UPDATE appointments
                              SET status = $2,
                                  contractor_id = NULL,
                                  dispatched_at = NULL,
                                  version = version + 1
                            WHERE appointment_id = $1
                              AND version = $3`,
                          [appointmentId, targetStatus, row.version]
                      );

            if (updateResult.rowCount === 0) {
                return {
                    success: false,
                    appointmentId,
                    reasonCode: "STALE_STATE",
                    currentStatus: row.status
                };
            }

            await client.query(
                `INSERT INTO appointment_status_history
                    (appointment_id, from_status, to_status, version_at_change, changed_by, reason)
                 VALUES ($1, 'CONTRACTOR_DISPATCHED', $2, $3, $4, $5)`,
                [
                    appointmentId,
                    targetStatus,
                    row.version + 1,
                    actor,
                    `Contractor ${contractorId} responded ${decision}`
                ]
            );

            return {
                success: true,
                appointmentId,
                newStatus: targetStatus,
                version: row.version + 1
            };
        },
        { isolation: "READ COMMITTED" }
    );
}
