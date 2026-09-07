// SCP Operational Lifecycle — Owner qualification of a customer request.
//
// The Owner's judgement that a request is serviceable, needs clarification, or
// is not serviceable. Every other step of the operational journey already had a
// canonical home; this one did not, so this module is that home — not a second
// copy of an authority living elsewhere.
//
// Two things it deliberately is NOT:
//
//   * a lifecycle state. Qualification never touches
//     core_service_request.state, and nothing reads this table to answer "what
//     state is this request in". A SERVICEABLE request stays exactly where it
//     was and becomes eligible for the Owner to dispatch it; an UNSERVICEABLE
//     one is moved by the existing governed cancellation action. Concluding
//     something and moving something are two different acts.
//
//   * a second write path. The only caller is the orchestrator's
//     QUALIFY_REQUEST handler, so a qualification inherits predecessor
//     validation, Owner authority, idempotency and audit from the one envelope
//     that provides them.

import type { PoolClient } from "pg";
import type { ServiceRequestState } from "../core/types";

export const QUALIFICATION_OUTCOMES = [
    "SERVICEABLE",
    "CLARIFICATION_REQUIRED",
    "UNSERVICEABLE"
] as const;

export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(QUALIFICATION_OUTCOMES);

export function isQualificationOutcome(value: unknown): value is QualificationOutcome {
    return typeof value === "string" && OUTCOME_SET.has(value);
}

export interface RequestQualification {
    qualificationId: string;
    requestId: string;
    tenantId: string;
    marketId: string;
    sequence: number;
    outcome: QualificationOutcome;
    reasonCode: string | null;
    note: string | null;
    observedState: ServiceRequestState;
    decidedByIdentityId: string;
    actionIdempotencyKey: string;
    decidedAt: Date;
}

interface Row {
    qualification_id: string;
    request_id: string;
    tenant_id: string;
    market_id: string;
    sequence: number;
    outcome: QualificationOutcome;
    reason_code: string | null;
    note: string | null;
    observed_state: ServiceRequestState;
    decided_by_identity_id: string;
    action_idempotency_key: string;
    decided_at: Date;
}

function toQualification(row: Row): RequestQualification {
    return {
        qualificationId: row.qualification_id,
        requestId: row.request_id,
        tenantId: row.tenant_id,
        marketId: row.market_id,
        sequence: row.sequence,
        outcome: row.outcome,
        reasonCode: row.reason_code,
        note: row.note,
        observedState: row.observed_state,
        decidedByIdentityId: row.decided_by_identity_id,
        actionIdempotencyKey: row.action_idempotency_key,
        decidedAt: row.decided_at
    };
}

const COLUMNS = `qualification_id, request_id, tenant_id, market_id, sequence, outcome,
                 reason_code, note, observed_state, decided_by_identity_id,
                 action_idempotency_key, decided_at`;

/** The Owner's most recent judgement, or null if they have not made one. */
export async function currentQualification(
    client: PoolClient,
    requestId: string
): Promise<RequestQualification | null> {
    const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM core_request_qualification
          WHERE request_id = $1 ORDER BY sequence DESC LIMIT 1`,
        [requestId]
    );
    return rows[0] ? toQualification(rows[0]) : null;
}

/** Every judgement made about a request, oldest first. */
export async function qualificationsForRequest(
    client: PoolClient,
    requestId: string
): Promise<RequestQualification[]> {
    const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM core_request_qualification
          WHERE request_id = $1 ORDER BY sequence ASC`,
        [requestId]
    );
    return rows.map(toQualification);
}

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
 * Appends a judgement. The sequence is assigned server-side under a row lock so
 * two Owners deciding at once produce two ordered judgements rather than a
 * unique-constraint abort.
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
    const { rows } = await client.query<Row>(
        `INSERT INTO core_request_qualification
            (request_id, tenant_id, market_id, sequence, outcome, reason_code, note,
             observed_state, decided_by_identity_id, action_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${COLUMNS}`,
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
    return toQualification(rows[0]!);
}

/**
 * Whether a request has been judged serviceable and may therefore proceed to
 * matching.
 *
 * CLARIFICATION_REQUIRED deliberately answers false: clarification must not
 * look like progress. A later SERVICEABLE judgement supersedes it, because only
 * the most recent judgement is consulted.
 */
export async function isQualifiedForMatching(
    client: PoolClient,
    requestId: string
): Promise<boolean> {
    const current = await currentQualification(client, requestId);
    return current?.outcome === "SERVICEABLE";
}
