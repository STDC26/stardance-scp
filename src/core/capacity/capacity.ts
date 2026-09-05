// SCP Core Foundation — Capacity.
//
// KERNEL QUESTION: "Can this service be sold, here, for this customer, at this
// time, under these operating rules?"
//
// Non-overlap is enforced by the `excl_capacity_no_overlap` GiST exclusion
// constraint in migration 002, NOT by a read-then-write check in application
// code. A SELECT-then-INSERT check loses the race that matters: two concurrent
// transactions both read "free" before either writes. The constraint makes the
// second INSERT fail deterministically with SQLSTATE 23P01, which this module
// translates into a governed CAPACITY_CONFLICT refusal.
//
// Provider availability (core_capacity_window) and business operating policy
// (the market configuration plane) are distinct concepts and are checked
// separately.

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type CapacityHoldState, type GovernedOutcome } from "../types";
import { recordEvent } from "../events/eventLog";

/** SQLSTATE 23P01 — exclusion_violation. */
const EXCLUSION_VIOLATION = "23P01";

export interface CapacityRequest {
    marketId: string;
    providerId: string;
    locationId: string;
    /** Exclusive resource discriminator; defaults to the provider themselves. */
    resourceKey?: string;
    requestId?: string | null;
    startTime: Date;
    endTime: Date;
}

export interface CapacityHold {
    holdId: string;
    providerId: string;
    resourceKey: string;
    state: CapacityHoldState;
}

function resourceKeyFor(input: CapacityRequest): string {
    return input.resourceKey ?? `PROVIDER:${input.providerId}`;
}

function isExclusionViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === EXCLUSION_VIOLATION
    );
}

/**
 * Confirms the provider has declared availability covering the window. This is
 * the "provider availability" half of the model; it deliberately does not check
 * business operating hours, which belong to market configuration.
 */
export async function hasDeclaredAvailability(
    client: PoolClient,
    input: CapacityRequest
): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM core_capacity_window
             WHERE provider_id = $1
               AND location_id = $2
               AND active = TRUE
               AND during @> tstzrange($3, $4, '[)')
         ) AS ok`,
        [input.providerId, input.locationId, input.startTime, input.endTime]
    );
    return rows[0]?.ok === true;
}

/**
 * Places a provisional exclusive hold. Atomic: either the hold exists and no
 * overlapping non-released hold does, or nothing was written.
 */
export async function holdCapacity(
    client: PoolClient,
    input: CapacityRequest,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CapacityHold>> {
    if (input.endTime <= input.startTime) {
        return fail("INVALID_TRANSITION", "capacity window end must be after start");
    }
    const resourceKey = resourceKeyFor(input);

    // A savepoint keeps an exclusion violation from poisoning the caller's
    // transaction: the conflict is an expected outcome, not a transaction abort.
    await client.query("SAVEPOINT capacity_hold");
    try {
        const { rows } = await client.query<{ hold_id: string }>(
            `INSERT INTO core_capacity_hold
                (market_id, provider_id, location_id, resource_key, request_id, during, state)
             VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), 'HELD')
             RETURNING hold_id`,
            [
                input.marketId,
                input.providerId,
                input.locationId,
                resourceKey,
                input.requestId ?? null,
                input.startTime,
                input.endTime
            ]
        );
        await client.query("RELEASE SAVEPOINT capacity_hold");
        const holdId = rows[0]!.hold_id;

        await recordEvent(client, {
            marketId: input.marketId,
            objectType: "CAPACITY_HOLD",
            objectId: holdId,
            fromState: null,
            toState: "HELD",
            actor,
            governingRef: input.requestId ?? null,
            idempotencyKey,
            payload: { resourceKey, locationId: input.locationId }
        });

        return succeed({ holdId, providerId: input.providerId, resourceKey, state: "HELD" });
    } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT capacity_hold");
        if (isExclusionViolation(err)) {
            return fail(
                "CAPACITY_CONFLICT",
                `exclusive capacity for ${resourceKey} already committed or held over the requested window`
            );
        }
        throw err;
    }
}

/** Promotes a provisional hold into a confirmed commitment. */
export async function commitCapacity(
    client: PoolClient,
    holdId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CapacityHold>> {
    const { rows } = await client.query<{
        provider_id: string;
        resource_key: string;
        state: CapacityHoldState;
    }>(
        `UPDATE core_capacity_hold SET state = 'COMMITTED'
          WHERE hold_id = $1 AND state = 'HELD'
      RETURNING provider_id, resource_key, state`,
        [holdId]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", `capacity hold ${holdId} is not in HELD state`);
    }
    await recordEvent(client, {
        marketId,
        objectType: "CAPACITY_HOLD",
        objectId: holdId,
        fromState: "HELD",
        toState: "COMMITTED",
        actor,
        idempotencyKey
    });
    return succeed({
        holdId,
        providerId: row.provider_id,
        resourceKey: row.resource_key,
        state: "COMMITTED"
    });
}

/**
 * Releases a hold or commitment, freeing the window for reuse. Used by dispatch
 * expiry, provider capacity withdrawal, and cancellation.
 */
export async function releaseCapacity(
    client: PoolClient,
    holdId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CapacityHold>> {
    const { rows } = await client.query<{
        provider_id: string;
        resource_key: string;
        state: CapacityHoldState;
    }>(
        `UPDATE core_capacity_hold SET state = 'RELEASED', released_at = now()
          WHERE hold_id = $1 AND state <> 'RELEASED'
      RETURNING provider_id, resource_key, state`,
        [holdId]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", `capacity hold ${holdId} is already released or absent`);
    }
    await recordEvent(client, {
        marketId,
        objectType: "CAPACITY_HOLD",
        objectId: holdId,
        fromState: "HELD_OR_COMMITTED",
        toState: "RELEASED",
        actor,
        idempotencyKey
    });
    return succeed({
        holdId,
        providerId: row.provider_id,
        resourceKey: row.resource_key,
        state: "RELEASED"
    });
}

/** Active (non-released) holds for a request. */
export async function activeHoldsForRequest(
    client: PoolClient,
    requestId: string
): Promise<Array<{ holdId: string; state: CapacityHoldState }>> {
    const { rows } = await client.query<{ hold_id: string; state: CapacityHoldState }>(
        `SELECT hold_id, state FROM core_capacity_hold
          WHERE request_id = $1 AND state <> 'RELEASED' ORDER BY created_at`,
        [requestId]
    );
    return rows.map((r) => ({ holdId: r.hold_id, state: r.state }));
}

export interface WithdrawalOutcome {
    releasedHoldIds: string[];
    /**
     * True when the withdrawal removed capacity underpinning a commitment the
     * customer has already confirmed. CAPACITY_MODEL: withdrawal is a governed
     * capacity-loss exception and must NOT auto-become an Amendment — but if
     * recovery changes the customer-facing commitment, an Amendment plus
     * reconfirmation is then required. This flag is that signal, not an
     * automatic amendment.
     */
    customerCommitmentAffected: boolean;
}

/**
 * Provider-side capacity withdrawal. Releases the provider's holds for the
 * request and reports whether a customer-facing commitment was disturbed.
 * Deliberately does not create an Amendment: that decision belongs to the
 * amendment module and to an owner, not to a capacity event.
 */
export async function withdrawProviderCapacity(
    client: PoolClient,
    requestId: string,
    providerId: string,
    marketId: string,
    actor: Actor,
    idempotencyKeyPrefix: string
): Promise<GovernedOutcome<WithdrawalOutcome>> {
    const { rows } = await client.query<{ hold_id: string }>(
        `SELECT hold_id FROM core_capacity_hold
          WHERE request_id = $1 AND provider_id = $2 AND state <> 'RELEASED'`,
        [requestId, providerId]
    );

    const releasedHoldIds: string[] = [];
    for (const row of rows) {
        const released = await releaseCapacity(
            client,
            row.hold_id,
            marketId,
            actor,
            `${idempotencyKeyPrefix}:release:${row.hold_id}`
        );
        if (released.ok) {
            releasedHoldIds.push(row.hold_id);
        }
    }

    const confirmation = await client.query<{ confirmation_id: string }>(
        `SELECT confirmation_id FROM core_customer_confirmation
          WHERE request_id = $1 AND superseded_at IS NULL`,
        [requestId]
    );

    return succeed({
        releasedHoldIds,
        customerCommitmentAffected: confirmation.rows.length > 0
    });
}
