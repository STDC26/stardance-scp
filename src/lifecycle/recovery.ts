// SCP Operational Lifecycle — OperationalRecovery.
//
// Durable evidence about how an operational disruption was handled. It is NOT
// the lifecycle owner: recovery never moves the Service Request by itself, and
// it never rewrites commercial truth.
//
// THE LOAD-BEARING RULE: recording a capacity loss must not silently erase a
// commitment. Two paths follow from a loss:
//
//   * the customer-facing commitment is UNCHANGED  -> recover within it
//     (reassign, re-hold), no Amendment, consent stands.
//   * the customer-facing commitment MATERIALLY CHANGES -> a canonical
//     ServiceRequestAmendment is required, and the existing commitment stays
//     authoritative until that Amendment is validly adopted.
//
// Recovery decides which case applies and records it. It does not adopt the
// Amendment on the customer's behalf.

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type GovernedOutcome, type OperationalRecoveryStatus } from "../core/types";
import { recordEvent } from "../core/events/eventLog";

export interface OperationalRecovery {
    recoveryId: string;
    requestId: string;
    tenantId: string;
    marketId: string;
    status: OperationalRecoveryStatus;
    triggerReason: string;
    amendmentId: string | null;
    resolution: string | null;
}

const RECOVERY_COLUMNS = `recovery_id, request_id, tenant_id, market_id, status,
                          trigger_reason, amendment_id, resolution`;

function toRecovery(row: Record<string, unknown>): OperationalRecovery {
    return {
        recoveryId: row["recovery_id"] as string,
        requestId: row["request_id"] as string,
        tenantId: row["tenant_id"] as string,
        marketId: row["market_id"] as string,
        status: row["status"] as OperationalRecoveryStatus,
        triggerReason: row["trigger_reason"] as string,
        amendmentId: (row["amendment_id"] as string | null) ?? null,
        resolution: (row["resolution"] as string | null) ?? null
    };
}

export async function openRecovery(
    client: PoolClient,
    input: {
        tenantId: string;
        marketId: string;
        requestId: string;
        triggerReason: string;
        payload?: Record<string, unknown>;
    },
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<OperationalRecovery>> {
    const existing = await openRecoveryFor(client, input.requestId);
    if (existing) {
        // One open recovery at a time: what is being recovered must never be
        // ambiguous. The caller gets the existing one rather than a duplicate.
        return succeed(existing);
    }

    const inserted = await client.query(
        `INSERT INTO core_operational_recovery
            (tenant_id, market_id, request_id, status, trigger_reason, payload)
         VALUES ($1, $2, $3, 'OPEN', $4, $5::jsonb)
         RETURNING ${RECOVERY_COLUMNS}`,
        [
            input.tenantId,
            input.marketId,
            input.requestId,
            input.triggerReason,
            JSON.stringify(input.payload ?? {})
        ]
    );
    const recovery = toRecovery(inserted.rows[0]!);

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "SERVICE_REQUEST",
        objectId: input.requestId,
        fromState: null,
        toState: "RECOVERY_OPENED",
        actor,
        governingRef: `recovery:${recovery.recoveryId}`,
        idempotencyKey,
        payload: { triggerReason: input.triggerReason }
    });

    return succeed(recovery);
}

export async function openRecoveryFor(
    client: PoolClient,
    requestId: string
): Promise<OperationalRecovery | null> {
    const { rows } = await client.query(
        `SELECT ${RECOVERY_COLUMNS} FROM core_operational_recovery
          WHERE request_id = $1 AND status = 'OPEN'`,
        [requestId]
    );
    return rows[0] ? toRecovery(rows[0]) : null;
}

export async function recoveriesForRequest(
    client: PoolClient,
    requestId: string
): Promise<OperationalRecovery[]> {
    const { rows } = await client.query(
        `SELECT ${RECOVERY_COLUMNS} FROM core_operational_recovery
          WHERE request_id = $1 ORDER BY opened_at ASC`,
        [requestId]
    );
    return rows.map(toRecovery);
}

export type RecoveryResolution = Exclude<OperationalRecoveryStatus, "OPEN">;

export async function resolveRecovery(
    client: PoolClient,
    recoveryId: string,
    resolution: RecoveryResolution,
    detail: string,
    actor: Actor,
    idempotencyKey: string,
    amendmentId?: string | null
): Promise<GovernedOutcome<OperationalRecovery>> {
    const { rows } = await client.query(
        `UPDATE core_operational_recovery
            SET status = $2, resolved_at = now(), resolution = $3, amendment_id = $4
          WHERE recovery_id = $1 AND status = 'OPEN'
      RETURNING ${RECOVERY_COLUMNS}`,
        [recoveryId, resolution, detail, amendmentId ?? null]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", `operational recovery ${recoveryId} is not open`);
    }
    const recovery = toRecovery(row);

    await recordEvent(client, {
        marketId: recovery.marketId,
        objectType: "SERVICE_REQUEST",
        objectId: recovery.requestId,
        fromState: "RECOVERY_OPEN",
        toState: `RECOVERY_${resolution}`,
        actor,
        governingRef: `recovery:${recoveryId}${amendmentId ? `#amendment:${amendmentId}` : ""}`,
        idempotencyKey,
        payload: { resolution, detail }
    });

    return succeed(recovery);
}

/**
 * Classifies whether a proposed operational recovery changes the
 * customer-facing commitment. Pure and explicit: the caller supplies what the
 * recovery would change, and this decides which governed path applies.
 *
 * A provider swap that keeps the same window and price is invisible to the
 * customer's commitment. A time or price move is not.
 */
export function recoveryChangesCommitment(change: {
    newStartTime?: Date | null;
    committedStartTime: Date;
    newPriceMinorUnits?: number | null;
    committedPriceMinorUnits: number;
}): boolean {
    if (
        change.newStartTime != null &&
        change.newStartTime.getTime() !== change.committedStartTime.getTime()
    ) {
        return true;
    }
    if (
        change.newPriceMinorUnits != null &&
        change.newPriceMinorUnits !== change.committedPriceMinorUnits
    ) {
        return true;
    }
    return false;
}
