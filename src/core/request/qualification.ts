// SCP Core — the qualification READ and the dispatch precondition it implies.
//
// SCP-G5-F-CORR-01 (R39). The Owner's serviceability judgement was being
// enforced at the Owner command boundary, so any other authoritative caller
// could create canonical dispatch truth without it. An invariant that depends
// on every caller remembering to check it is not an invariant.
//
// This module exists at CORE level so that every authoritative path capable of
// creating dispatch truth can share ONE determination:
//
//   src/lifecycle/orchestrator.ts   DISPATCH_PROVIDER
//   src/core/dispatch/dispatchOffer.ts   offerDispatch
//
// There is still exactly one qualification truth — the append-only
// core_request_qualification rows written by the G4 orchestrator's
// QUALIFY_REQUEST handler. This file only READS it. The write stays in
// src/lifecycle/qualification.ts, above Core, where the governed action
// envelope lives; splitting the read down rather than pulling the write up is
// what keeps the layering honest and avoids a circular dependency.

import type { PoolClient } from "pg";
import type { ServiceRequestState } from "../types";

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

export const QUALIFICATION_COLUMNS = `qualification_id, request_id, tenant_id, market_id, sequence,
                                      outcome, reason_code, note, observed_state,
                                      decided_by_identity_id, action_idempotency_key, decided_at`;

export function toQualification(row: Row): RequestQualification {
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

/**
 * The Owner's most recent judgement, or null if they have not made one.
 *
 * "Most recent" is the whole staleness model: a superseded judgement is simply
 * one with a lower sequence, so it can never be the answer.
 */
export async function currentQualification(
    client: PoolClient,
    requestId: string
): Promise<RequestQualification | null> {
    const { rows } = await client.query<Row>(
        `SELECT ${QUALIFICATION_COLUMNS} FROM core_request_qualification
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
        `SELECT ${QUALIFICATION_COLUMNS} FROM core_request_qualification
          WHERE request_id = $1 ORDER BY sequence ASC`,
        [requestId]
    );
    return rows.map(toQualification);
}

/**
 * Whether a request has been judged serviceable and may therefore enter
 * matching and dispatch.
 *
 * CLARIFICATION_REQUIRED deliberately answers false: clarification must not
 * look like progress. UNSERVICEABLE answers false for the obvious reason.
 */
export async function isQualifiedForMatching(
    client: PoolClient,
    requestId: string
): Promise<boolean> {
    const current = await currentQualification(client, requestId);
    return current?.outcome === "SERVICEABLE";
}

export interface QualificationBlock {
    /** The judgement that blocks, or null when none was ever made. */
    outcome: QualificationOutcome | null;
    message: string;
}

/**
 * THE dispatch precondition. Returns null when dispatch may proceed, or the
 * reason it may not.
 *
 * Every authoritative path that can create canonical dispatch truth calls this
 * one function. `SERVICEABLE` does not promise dispatch will succeed — it means
 * the request may be evaluated, and every existing predecessor, provider
 * eligibility, capacity, service-area, scope, authority and idempotency rule
 * still applies afterwards.
 */
export async function dispatchQualificationBlock(
    client: PoolClient,
    requestId: string
): Promise<QualificationBlock | null> {
    const current = await currentQualification(client, requestId);
    if (!current) {
        return {
            outcome: null,
            message:
                "this request has not been qualified; an owner must judge it serviceable before it can be dispatched"
        };
    }
    if (current.outcome === "SERVICEABLE") {
        return null;
    }
    return {
        outcome: current.outcome,
        message:
            current.outcome === "CLARIFICATION_REQUIRED"
                ? "this request is awaiting clarification and cannot be dispatched"
                : "this request was judged unserviceable and cannot be dispatched"
    };
}
