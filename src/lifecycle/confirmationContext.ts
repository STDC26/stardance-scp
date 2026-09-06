// SCP Operational Lifecycle — CustomerConfirmationContext.
//
// A confirmation is meaningful only against a specific assignment and a
// specific commitment version. Binding the context to both is what makes
// "the customer agreed to THIS" checkable later, and what lets a reassignment
// or an adopted amendment invalidate consent instead of silently inheriting it.
//
// This widens the existing core_customer_confirmation owner. A PENDING context
// is opened when confirmation is requested and CONFIRMED when the customer
// actually acts; the unique index permits only one live context per request.

import type { PoolClient } from "pg";
import type { Actor, ConfirmationContextStatus } from "../core/types";
import { recordEvent } from "../core/events/eventLog";

export interface ConfirmationContext {
    confirmationId: string;
    requestId: string;
    assignmentId: string | null;
    status: ConfirmationContextStatus;
    contextVersion: number;
    commitmentVersion: number;
    confirmedByIdentityId: string | null;
    expiresAt: Date | null;
}

const CONTEXT_COLUMNS = `confirmation_id, request_id, assignment_id, status, context_version,
                         confirmed_version, confirmed_by_identity_id, expires_at`;

function toContext(row: Record<string, unknown>): ConfirmationContext {
    return {
        confirmationId: row["confirmation_id"] as string,
        requestId: row["request_id"] as string,
        assignmentId: (row["assignment_id"] as string | null) ?? null,
        status: row["status"] as ConfirmationContextStatus,
        contextVersion: row["context_version"] as number,
        commitmentVersion: row["confirmed_version"] as number,
        confirmedByIdentityId: (row["confirmed_by_identity_id"] as string | null) ?? null,
        expiresAt: (row["expires_at"] as Date | null) ?? null
    };
}

/** The one live context: PENDING or CONFIRMED. */
export async function liveContext(
    client: PoolClient,
    requestId: string,
    forUpdate = false
): Promise<ConfirmationContext | null> {
    const { rows } = await client.query(
        `SELECT ${CONTEXT_COLUMNS} FROM core_customer_confirmation
          WHERE request_id = $1 AND status IN ('PENDING', 'CONFIRMED')
          ${forUpdate ? "FOR UPDATE" : ""}`,
        [requestId]
    );
    return rows[0] ? toContext(rows[0]) : null;
}

export async function contextsForRequest(
    client: PoolClient,
    requestId: string
): Promise<ConfirmationContext[]> {
    const { rows } = await client.query(
        `SELECT ${CONTEXT_COLUMNS} FROM core_customer_confirmation
          WHERE request_id = $1 ORDER BY context_version ASC`,
        [requestId]
    );
    return rows.map(toContext);
}

/**
 * Supersedes any live context. Called when the assignment changes or an
 * amendment moves the commitment — consent to the old arrangement does not
 * carry forward.
 */
export async function supersedeLiveContext(
    client: PoolClient,
    requestId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<string[]> {
    const { rows } = await client.query<{ confirmation_id: string; status: string }>(
        `UPDATE core_customer_confirmation
            SET status = 'SUPERSEDED', superseded_at = now()
          WHERE request_id = $1 AND status IN ('PENDING', 'CONFIRMED')
      RETURNING confirmation_id, status`,
        [requestId]
    );
    for (const row of rows) {
        await recordEvent(client, {
            marketId,
            objectType: "CUSTOMER_CONFIRMATION",
            objectId: row.confirmation_id,
            fromState: "LIVE",
            toState: "SUPERSEDED",
            actor,
            idempotencyKey: `${idempotencyKey}:supersede:${row.confirmation_id}`
        });
    }
    return rows.map((r) => r.confirmation_id);
}

/** Opens a PENDING context bound to the current assignment and commitment. */
export async function openContext(
    client: PoolClient,
    input: {
        requestId: string;
        marketId: string;
        assignmentId: string;
        commitmentVersion: number;
        expiresAt: Date | null;
    },
    actor: Actor,
    idempotencyKey: string
): Promise<ConfirmationContext> {
    await supersedeLiveContext(client, input.requestId, input.marketId, actor, idempotencyKey);

    const prior = await client.query<{ context_version: number }>(
        `SELECT context_version FROM core_customer_confirmation
          WHERE request_id = $1 ORDER BY context_version DESC LIMIT 1`,
        [input.requestId]
    );
    const nextVersion = (prior.rows[0]?.context_version ?? 0) + 1;

    const inserted = await client.query(
        `INSERT INTO core_customer_confirmation
            (request_id, confirmed_version, confirmed_by_identity_id, confirmed_at,
             status, context_version, assignment_id, expires_at)
         VALUES ($1, $2, NULL, NULL, 'PENDING', $3, $4, $5)
         RETURNING ${CONTEXT_COLUMNS}`,
        [
            input.requestId,
            input.commitmentVersion,
            nextVersion,
            input.assignmentId,
            input.expiresAt
        ]
    );
    const context = toContext(inserted.rows[0]!);

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "CUSTOMER_CONFIRMATION",
        objectId: context.confirmationId,
        fromState: null,
        toState: "PENDING",
        actor,
        governingRef: `assignment:${input.assignmentId}#v${input.commitmentVersion}`,
        idempotencyKey: `${idempotencyKey}:context`,
        payload: { contextVersion: nextVersion, commitmentVersion: input.commitmentVersion }
    });

    return context;
}

/** Marks a PENDING context CONFIRMED. Returns false if it was no longer live. */
export async function confirmContext(
    client: PoolClient,
    context: ConfirmationContext,
    marketId: string,
    confirmedByIdentityId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<boolean> {
    const { rowCount } = await client.query(
        `UPDATE core_customer_confirmation
            SET status = 'CONFIRMED', confirmed_by_identity_id = $2, confirmed_at = now()
          WHERE confirmation_id = $1 AND status = 'PENDING'`,
        [context.confirmationId, confirmedByIdentityId]
    );
    if (rowCount === 0) {
        return false;
    }
    await recordEvent(client, {
        marketId,
        objectType: "CUSTOMER_CONFIRMATION",
        objectId: context.confirmationId,
        fromState: "PENDING",
        toState: "CONFIRMED",
        actor,
        governingRef: `request:${context.requestId}#v${context.commitmentVersion}`,
        idempotencyKey
    });
    return true;
}

/** Terminates a live context without confirming it. */
export async function withdrawLiveContext(
    client: PoolClient,
    requestId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<void> {
    const { rows } = await client.query<{ confirmation_id: string }>(
        `UPDATE core_customer_confirmation
            SET status = 'WITHDRAWN', superseded_at = now()
          WHERE request_id = $1 AND status IN ('PENDING', 'CONFIRMED')
      RETURNING confirmation_id`,
        [requestId]
    );
    for (const row of rows) {
        await recordEvent(client, {
            marketId,
            objectType: "CUSTOMER_CONFIRMATION",
            objectId: row.confirmation_id,
            fromState: "LIVE",
            toState: "WITHDRAWN",
            actor,
            idempotencyKey: `${idempotencyKey}:withdraw:${row.confirmation_id}`
        });
    }
}
