// SCP Operational Lifecycle — recording the Owner's qualification judgement.
//
// The Owner's judgement that a request is serviceable, needs clarification, or
// is not serviceable. Every other step of the operational journey already had a
// canonical home; this one did not, so `core_request_qualification` is that
// home — not a second copy of an authority living elsewhere.
//
// Two things it deliberately is NOT:
//
//   * a lifecycle state. Qualification never touches
//     core_service_request.state, and nothing reads it to answer "what state is
//     this request in". A SERVICEABLE request stays exactly where it was and
//     becomes eligible to be dispatched; an UNSERVICEABLE one is moved by the
//     existing governed cancellation action. Concluding something and moving
//     something are two different acts.
//
//   * a second write path. The only caller of `recordQualification` is the
//     orchestrator's QUALIFY_REQUEST handler, so a qualification inherits
//     predecessor validation, Owner authority, idempotency and audit from the
//     one envelope that provides them.
//
// SCP-G5-F-CORR-01 (R39) split the READ side down into
// src/core/request/qualification.ts so that every authoritative dispatch path —
// including the G2 dispatch function, which sits below this layer — can share
// one determination. The write stays here, where the governed action envelope
// is. The reads below are re-exported unchanged so existing callers are
// unaffected and there remains exactly one qualification truth.

import type { PoolClient } from "pg";
import type { ServiceRequestState } from "../core/types";
import {
    QUALIFICATION_COLUMNS,
    toQualification,
    type QualificationOutcome,
    type RequestQualification
} from "../core/request/qualification";

export {
    QUALIFICATION_OUTCOMES,
    isQualificationOutcome,
    currentQualification,
    qualificationsForRequest,
    isQualifiedForMatching,
    dispatchQualificationBlock,
    type QualificationOutcome,
    type RequestQualification,
    type QualificationBlock
} from "../core/request/qualification";

export interface RecordQualificationInput {
    requestId: string;
    tenantId: string;
    marketId: string;
    outcome: QualificationOutcome;
    reasonCode: string | null;
    note: string | null;
    observedState: ServiceRequestState;
    decidedByIdentityId: string;
    actionIdempotencyKey: string;
}

/**
 * Appends a judgement. The sequence is assigned server-side under an advisory
 * lock so two Owners deciding at once produce two ordered judgements rather
 * than a unique-constraint abort.
 */
export async function recordQualification(
    client: PoolClient,
    input: RecordQualificationInput
): Promise<RequestQualification> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `request-qualification:${input.requestId}`
    ]);
    const next = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM core_request_qualification
          WHERE request_id = $1`,
        [input.requestId]
    );
    const { rows } = await client.query(
        `INSERT INTO core_request_qualification
            (request_id, tenant_id, market_id, sequence, outcome, reason_code, note,
             observed_state, decided_by_identity_id, action_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${QUALIFICATION_COLUMNS}`,
        [
            input.requestId,
            input.tenantId,
            input.marketId,
            Number(next.rows[0]!.next),
            input.outcome,
            input.reasonCode,
            input.note,
            input.observedState,
            input.decidedByIdentityId,
            input.actionIdempotencyKey
        ]
    );
    return toQualification(rows[0] as never);
}
