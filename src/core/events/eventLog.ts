// SCP Core Foundation — Event / Audit.
//
// EVENT_AUDIT: every canonical transition is persisted, actor-attributed,
// timestamped, predecessor-validated, idempotent, and traceable to a governing
// object. This module owns the audit record; no other module writes core_event
// directly.

import type { PoolClient } from "pg";
import type { Actor } from "../types";

export type AuditedObjectType =
    | "SERVICE_REQUEST"
    | "DISPATCH_OFFER"
    | "ASSIGNMENT"
    | "CUSTOMER_CONFIRMATION"
    | "AMENDMENT"
    | "CAPACITY_HOLD"
    | "PROVIDER"
    | "FULFILLMENT";

export interface EventInput {
    marketId: string;
    objectType: AuditedObjectType;
    objectId: string;
    fromState: string | null;
    toState: string;
    actor: Actor;
    /** Offer / assignment / request-version this transition traces back to. */
    governingRef?: string | null;
    /**
     * Stable key derived from the governed command. Replaying the same command
     * must not produce a second transition.
     */
    idempotencyKey: string;
    payload?: Record<string, unknown>;
}

export type EventWriteResult = "RECORDED" | "REPLAY";

/**
 * Appends one transition. Returns REPLAY (without writing) when the same
 * idempotency key was already recorded, so callers can distinguish "did the
 * work" from "already done" without a second query.
 */
export async function recordEvent(
    client: PoolClient,
    input: EventInput
): Promise<EventWriteResult> {
    const result = await client.query(
        `INSERT INTO core_event
            (market_id, object_type, object_id, from_state, to_state,
             actor_identity_id, actor_role, actor_authority, governing_ref,
             idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
            input.marketId,
            input.objectType,
            input.objectId,
            input.fromState,
            input.toState,
            input.actor.identityId,
            input.actor.role,
            input.actor.authority,
            input.governingRef ?? null,
            input.idempotencyKey,
            JSON.stringify(input.payload ?? {})
        ]
    );
    return result.rowCount === 1 ? "RECORDED" : "REPLAY";
}

/** Full audit trail for one object, oldest first. */
export async function eventsFor(
    client: PoolClient,
    objectType: AuditedObjectType,
    objectId: string
): Promise<
    Array<{
        from_state: string | null;
        to_state: string;
        actor_role: string;
        actor_authority: string;
        governing_ref: string | null;
        idempotency_key: string;
    }>
> {
    const { rows } = await client.query(
        `SELECT from_state, to_state, actor_role, actor_authority, governing_ref, idempotency_key
           FROM core_event
          WHERE object_type = $1 AND object_id = $2
          ORDER BY event_id ASC`,
        [objectType, objectId]
    );
    return rows;
}
