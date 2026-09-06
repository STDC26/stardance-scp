// SCP Operational Lifecycle — DispatchAttempt.
//
// Versioned durable evidence of one exact provider dispatch attempt. This is
// the existing core_dispatch_offer owner widened with a version, not a second
// dispatch table.
//
// EXACT-CURRENT SEMANTICS: only the highest-version OPEN attempt may bind a
// response. A response naming an older attempt is STALE_DISPATCH_RESPONSE; a
// response to an attempt that a newer dispatch replaced is DISPATCH_SUPERSEDED.
// Neither is allowed to manufacture an acceptance.

import type { PoolClient } from "pg";
import type { Actor, DispatchOfferState } from "../core/types";
import { recordEvent } from "../core/events/eventLog";

export interface DispatchAttempt {
    attemptId: string;
    requestId: string;
    providerId: string;
    marketId: string;
    attemptVersion: number;
    state: DispatchOfferState;
    offeredAt: Date;
    expiresAt: Date;
    supersededBy: string | null;
}

const ATTEMPT_COLUMNS = `offer_id, request_id, provider_id, market_id, attempt_version,
                         state, offered_at, expires_at, superseded_by`;

function toAttempt(row: Record<string, unknown>): DispatchAttempt {
    return {
        attemptId: row["offer_id"] as string,
        requestId: row["request_id"] as string,
        providerId: row["provider_id"] as string,
        marketId: row["market_id"] as string,
        attemptVersion: row["attempt_version"] as number,
        state: row["state"] as DispatchOfferState,
        offeredAt: row["offered_at"] as Date,
        expiresAt: row["expires_at"] as Date,
        supersededBy: (row["superseded_by"] as string | null) ?? null
    };
}

export async function loadAttempt(
    client: PoolClient,
    attemptId: string,
    forUpdate = false
): Promise<DispatchAttempt | null> {
    const { rows } = await client.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM core_dispatch_offer
          WHERE offer_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [attemptId]
    );
    return rows[0] ? toAttempt(rows[0]) : null;
}

/** The one attempt currently entitled to bind a response, if any. */
export async function currentAttempt(
    client: PoolClient,
    requestId: string
): Promise<DispatchAttempt | null> {
    const { rows } = await client.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM core_dispatch_offer
          WHERE request_id = $1 AND state = 'OFFERED'
          ORDER BY attempt_version DESC LIMIT 1`,
        [requestId]
    );
    return rows[0] ? toAttempt(rows[0]) : null;
}

export async function attemptsForRequest(
    client: PoolClient,
    requestId: string
): Promise<DispatchAttempt[]> {
    const { rows } = await client.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM core_dispatch_offer
          WHERE request_id = $1 ORDER BY attempt_version ASC`,
        [requestId]
    );
    return rows.map(toAttempt);
}

/**
 * Opens a new attempt, superseding any non-terminal predecessor. Version is
 * monotonic per request so "which attempt is current" is a fact, not an
 * inference from timestamps.
 */
export async function openAttempt(
    client: PoolClient,
    input: {
        requestId: string;
        providerId: string;
        marketId: string;
        offeredAt: Date;
        expiresAt: Date;
    },
    actor: Actor,
    idempotencyKey: string
): Promise<DispatchAttempt> {
    const prior = await client.query<{ offer_id: string; attempt_version: number }>(
        `SELECT offer_id, attempt_version FROM core_dispatch_offer
          WHERE request_id = $1 ORDER BY attempt_version DESC LIMIT 1 FOR UPDATE`,
        [input.requestId]
    );
    const nextVersion = (prior.rows[0]?.attempt_version ?? 0) + 1;

    const inserted = await client.query(
        `INSERT INTO core_dispatch_offer
            (market_id, request_id, provider_id, state, offered_at, expires_at, attempt_version)
         VALUES ($1, $2, $3, 'OFFERED', $4, $5, $6)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [
            input.marketId,
            input.requestId,
            input.providerId,
            input.offeredAt,
            input.expiresAt,
            nextVersion
        ]
    );
    const attempt = toAttempt(inserted.rows[0]!);

    // Supersede the previous attempt only after the new one exists, so a
    // request is never left with no attempt at all mid-transaction.
    const supersededRows = await client.query<{ offer_id: string }>(
        `UPDATE core_dispatch_offer
            SET state = 'SUPERSEDED', decided_at = $3, superseded_by = $2
          WHERE request_id = $1 AND offer_id <> $2 AND state = 'OFFERED'
      RETURNING offer_id`,
        [input.requestId, attempt.attemptId, input.offeredAt]
    );
    for (const row of supersededRows.rows) {
        await recordEvent(client, {
            marketId: input.marketId,
            objectType: "DISPATCH_OFFER",
            objectId: row.offer_id,
            fromState: "OFFERED",
            toState: "SUPERSEDED",
            actor,
            governingRef: `attempt:${attempt.attemptId}`,
            idempotencyKey: `${idempotencyKey}:supersede:${row.offer_id}`
        });
    }

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "DISPATCH_OFFER",
        objectId: attempt.attemptId,
        fromState: null,
        toState: "OFFERED",
        actor,
        governingRef: `request:${input.requestId}#attempt_v${nextVersion}`,
        idempotencyKey: `${idempotencyKey}:attempt`,
        payload: { attemptVersion: nextVersion, providerId: input.providerId }
    });

    return attempt;
}

/** Records a terminal disposition on an attempt. Returns false if it moved. */
export async function decideAttempt(
    client: PoolClient,
    attempt: DispatchAttempt,
    terminal: "ACCEPTED" | "DECLINED" | "EXPIRED",
    decidedAt: Date,
    decidedByIdentityId: string | null,
    actor: Actor,
    idempotencyKey: string
): Promise<boolean> {
    const decidedAtValue = terminal === "EXPIRED" ? null : decidedAt;
    const { rowCount } = await client.query(
        `UPDATE core_dispatch_offer
            SET state = $2, decided_at = $3, decided_by_identity_id = $4
          WHERE offer_id = $1 AND state = 'OFFERED'`,
        [attempt.attemptId, terminal, decidedAtValue, decidedByIdentityId]
    );
    if (rowCount === 0) {
        return false;
    }
    await recordEvent(client, {
        marketId: attempt.marketId,
        objectType: "DISPATCH_OFFER",
        objectId: attempt.attemptId,
        fromState: "OFFERED",
        toState: terminal,
        actor,
        governingRef: `request:${attempt.requestId}#attempt_v${attempt.attemptVersion}`,
        idempotencyKey
    });
    return true;
}

/** Attempts whose window has elapsed and that are still OPEN. */
export async function expiredAttempts(
    client: PoolClient,
    marketId: string,
    now: Date,
    limit = 200
): Promise<DispatchAttempt[]> {
    const { rows } = await client.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM core_dispatch_offer
          WHERE market_id = $1 AND state = 'OFFERED' AND expires_at <= $2
          ORDER BY expires_at ASC LIMIT $3`,
        [marketId, now, limit]
    );
    return rows.map(toAttempt);
}
