// SCP Operational Lifecycle — OperationalAction.
//
// A governed transaction command envelope with a durable audit identity. It is
// explicitly NOT a lifecycle aggregate: it owns no state of its own and never
// answers "what is the state of this request". core_service_request answers
// that. An action is the record of one attempt to move it, accepted or refused.
//
// Every binding action carries an idempotency key and a request fingerprint, so
// three cases are distinguishable rather than conflated:
//   * same key, same fingerprint   -> replay of a decision already made
//   * same key, different payload  -> IDEMPOTENCY_CONFLICT
//   * different key                -> a new attempt, judged on current state

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ScpRole } from "../core/types";
import type { LifecycleReason } from "./reasons";

export const OPERATIONAL_ACTION_TYPES = [
    "DISPATCH_PROVIDER",
    "EXPIRE_DISPATCH",
    "RECORD_PROVIDER_ACCEPTANCE",
    "RECORD_PROVIDER_REJECTION",
    "ASSIGN_PROVIDER",
    "REASSIGN_PROVIDER",
    "REQUEST_CUSTOMER_CONFIRMATION",
    "RECORD_CUSTOMER_CONFIRMATION",
    "START_FULFILLMENT",
    "COMPLETE_SERVICE",
    "CANCEL_SERVICE",
    "MARK_NO_SHOW",
    "MARK_UNABLE_TO_FULFILL",
    "RECORD_CAPACITY_LOSS",
    "INITIATE_OPERATIONAL_RECOVERY"
] as const;

export type OperationalActionType = (typeof OPERATIONAL_ACTION_TYPES)[number];

const ACTION_SET: ReadonlySet<string> = new Set(OPERATIONAL_ACTION_TYPES);

export function isOperationalActionType(value: unknown): value is OperationalActionType {
    return typeof value === "string" && ACTION_SET.has(value);
}

export type ActionPayload = Record<string, unknown>;

/**
 * Deterministic fingerprint of the materially-identifying parts of an action.
 * Object keys are sorted so that two structurally identical payloads written in
 * different orders are the same request, and arrays are sorted only where the
 * caller has already declared order irrelevant (add-on style id lists).
 */
export function actionFingerprint(input: {
    tenantId: string;
    marketId: string;
    requestId: string;
    actionType: OperationalActionType;
    actorIdentityId: string | null;
    payload: ActionPayload;
}): string {
    return createHash("sha256")
        .update(
            canonicalize({
                tenantId: input.tenantId,
                marketId: input.marketId,
                requestId: input.requestId,
                actionType: input.actionType,
                actorIdentityId: input.actorIdentityId,
                payload: input.payload
            }),
            "utf8"
        )
        .digest("hex");
}

function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export interface RecordedAction {
    actionId: string;
    actionType: OperationalActionType;
    outcome: "ACCEPTED" | "REFUSED";
    reasonCode: LifecycleReason | null;
    fromState: string | null;
    toState: string | null;
    requestFingerprint: string;
    payload: ActionPayload;
}

/** Looks up a prior action by idempotency key within a tenant. */
export async function findActionByKey(
    client: PoolClient,
    tenantId: string,
    idempotencyKey: string
): Promise<RecordedAction | null> {
    const { rows } = await client.query<{
        action_id: string;
        action_type: string;
        outcome: "ACCEPTED" | "REFUSED";
        reason_code: string | null;
        from_state: string | null;
        to_state: string | null;
        request_fingerprint: string;
        payload: ActionPayload;
    }>(
        `SELECT action_id, action_type, outcome, reason_code, from_state, to_state,
                request_fingerprint, payload
           FROM core_operational_action
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        actionId: row.action_id,
        actionType: row.action_type as OperationalActionType,
        outcome: row.outcome,
        reasonCode: row.reason_code as LifecycleReason | null,
        fromState: row.from_state,
        toState: row.to_state,
        requestFingerprint: row.request_fingerprint,
        payload: row.payload
    };
}

export interface PersistActionInput {
    tenantId: string;
    marketId: string;
    requestId: string;
    actionType: OperationalActionType;
    outcome: "ACCEPTED" | "REFUSED";
    reasonCode: LifecycleReason | null;
    fromState: string | null;
    toState: string | null;
    actorIdentityId: string | null;
    actorRole: ScpRole;
    actorAuthority: string;
    idempotencyKey: string;
    requestFingerprint: string;
    payload: ActionPayload;
}

/**
 * Persists the action envelope. Refused attempts are recorded too — a governed
 * system must be able to answer "who tried to bind this, and why were they
 * turned away", not only "what succeeded".
 */
export async function persistAction(
    client: PoolClient,
    input: PersistActionInput
): Promise<string> {
    const { rows } = await client.query<{ action_id: string }>(
        `INSERT INTO core_operational_action
            (tenant_id, market_id, request_id, action_type, outcome, reason_code,
             from_state, to_state, actor_identity_id, actor_role, actor_authority,
             idempotency_key, request_fingerprint, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         RETURNING action_id`,
        [
            input.tenantId,
            input.marketId,
            input.requestId,
            input.actionType,
            input.outcome,
            input.reasonCode,
            input.fromState,
            input.toState,
            input.actorIdentityId,
            input.actorRole,
            input.actorAuthority,
            input.idempotencyKey,
            input.requestFingerprint,
            JSON.stringify(input.payload)
        ]
    );
    return rows[0]!.action_id;
}

/** Full action history for one request, oldest first — the replay surface. */
export async function actionsForRequest(
    client: PoolClient,
    requestId: string
): Promise<RecordedAction[]> {
    const { rows } = await client.query<{
        action_id: string;
        action_type: string;
        outcome: "ACCEPTED" | "REFUSED";
        reason_code: string | null;
        from_state: string | null;
        to_state: string | null;
        request_fingerprint: string;
        payload: ActionPayload;
    }>(
        `SELECT action_id, action_type, outcome, reason_code, from_state, to_state,
                request_fingerprint, payload
           FROM core_operational_action
          WHERE request_id = $1
          ORDER BY created_at ASC, action_id ASC`,
        [requestId]
    );
    return rows.map((row) => ({
        actionId: row.action_id,
        actionType: row.action_type as OperationalActionType,
        outcome: row.outcome,
        reasonCode: row.reason_code as LifecycleReason | null,
        fromState: row.from_state,
        toState: row.to_state,
        requestFingerprint: row.request_fingerprint,
        payload: row.payload
    }));
}
