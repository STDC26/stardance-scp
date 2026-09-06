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

// =============================================================================
// G3 — first-class durable capacity holds.
//
// Still this module's concern: CapacityHold has one owner and G3 widens it
// rather than standing up parallel capacity truth. G2's HELD/COMMITTED and G3's
// ACTIVE/CONSUMED are the same two ideas under migration-era and canonical
// names; both block exclusive capacity, which is what the exclusion constraint
// in migration 005 encodes.
// =============================================================================

/** Migration-era alias map. G2 wrote the left, G3 writes the right. */
export const CAPACITY_HOLD_STATE_ALIAS: Readonly<Record<string, CapacityHoldState>> = Object.freeze({
    HELD: "ACTIVE",
    COMMITTED: "CONSUMED"
});

/** States that occupy exclusive capacity. Mirrors excl_capacity_no_overlap. */
export const BLOCKING_HOLD_STATES: readonly CapacityHoldState[] = Object.freeze([
    "HELD",
    "COMMITTED",
    "ACTIVE",
    "CONSUMED"
]);

export interface KernelHoldInput {
    tenantId: string;
    marketId: string;
    providerId: string;
    locationId: string;
    resourceKey: string;
    offerId: string;
    startTime: Date;
    endTime: Date;
    expiresAt: Date;
}

/**
 * Materializes elapsed expiry. The exclusion constraint keys on state, not on
 * time, so an ACTIVE hold whose TTL has passed would keep blocking capacity
 * until something moved it. Every path that is about to test or take capacity
 * calls this first, inside the same transaction, so the constraint is always
 * evaluated against current truth.
 */
export async function expireStaleHolds(
    client: PoolClient,
    marketId: string,
    now: Date
): Promise<string[]> {
    const { rows } = await client.query<{ hold_id: string }>(
        `UPDATE core_capacity_hold
            SET state = 'EXPIRED', released_at = $2
          WHERE market_id = $1
            AND state = 'ACTIVE'
            AND expires_at IS NOT NULL
            AND expires_at <= $2
      RETURNING hold_id`,
        [marketId, now]
    );
    return rows.map((r) => r.hold_id);
}

/**
 * Is this exclusive resource free for the whole window?
 *
 * An ACTIVE hold whose TTL has already elapsed does not count as busy even if
 * nothing has swept it yet, so a read never reports a slot as taken when it is
 * logically free. The row is materialized to EXPIRED at the moment somebody
 * actually tries to take the slot (see placeKernelHold).
 */
export async function isResourceFree(
    client: PoolClient,
    marketId: string,
    resourceKey: string,
    startTime: Date,
    endTime: Date,
    asOf: Date = new Date()
): Promise<boolean> {
    const { rows } = await client.query<{ conflicting: string }>(
        `SELECT count(*)::text AS conflicting
           FROM core_capacity_hold
          WHERE market_id = $1
            AND resource_key = $2
            AND state = ANY($5::capacity_hold_state[])
            AND (state <> 'ACTIVE' OR expires_at IS NULL OR expires_at > $6)
            AND during && tstzrange($3, $4, '[)')`,
        [marketId, resourceKey, startTime, endTime, BLOCKING_HOLD_STATES, asOf]
    );
    return Number(rows[0]!.conflicting) === 0;
}

/**
 * Places one first-class ACTIVE hold. The exclusion constraint remains the
 * final guardrail — the free/busy read above is an optimisation for producing
 * a good reason code, never the safety mechanism.
 */
export async function placeKernelHold(
    client: PoolClient,
    input: KernelHoldInput,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CapacityHold>> {
    if (input.endTime <= input.startTime) {
        return fail("INVALID_TRANSITION", "capacity window end must be after start");
    }

    // Serialize contenders for THIS exclusive resource.
    //
    // Without this, N simultaneous contenders pile onto the exclusion
    // constraint's speculative-insert waits and PostgreSQL resolves the tangle
    // by aborting transactions with SQLSTATE 40P01. The safety outcome is still
    // correct — one winner, no overlap — but a deadlock abort is NOT a governed
    // refusal, and losing contenders are entitled to a reason code they can act
    // on. The advisory lock turns the pile-up into an orderly queue: each
    // contender waits its turn, then sees the committed hold and receives
    // CAPACITY_CONFLICT.
    //
    // The lock is transaction-scoped, so it is released on commit or rollback
    // with no cleanup path to get wrong. Callers taking several holds must
    // acquire them in a stable order (resource keys are sorted upstream) so two
    // multi-resource bookings cannot deadlock against each other.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${input.marketId}:${input.resourceKey}`
    ]);

    // Materialize elapsed expiry for exactly this resource, in a deterministic
    // order, so the exclusion constraint is evaluated against current truth
    // without a market-wide UPDATE stampede.
    await client.query(
        `UPDATE core_capacity_hold
            SET state = 'EXPIRED', released_at = now()
          WHERE hold_id IN (
              SELECT hold_id FROM core_capacity_hold
               WHERE market_id = $1 AND resource_key = $2 AND state = 'ACTIVE'
                 AND expires_at IS NOT NULL AND expires_at <= now()
               ORDER BY hold_id
          )`,
        [input.marketId, input.resourceKey]
    );

    await client.query("SAVEPOINT kernel_hold");
    try {
        const { rows } = await client.query<{ hold_id: string }>(
            `INSERT INTO core_capacity_hold
                (tenant_id, market_id, provider_id, location_id, resource_key, offer_id,
                 during, state, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7, $8, '[)'), 'ACTIVE', $9)
             RETURNING hold_id`,
            [
                input.tenantId,
                input.marketId,
                input.providerId,
                input.locationId,
                input.resourceKey,
                input.offerId,
                input.startTime,
                input.endTime,
                input.expiresAt
            ]
        );
        await client.query("RELEASE SAVEPOINT kernel_hold");
        const holdId = rows[0]!.hold_id;

        await recordEvent(client, {
            marketId: input.marketId,
            objectType: "CAPACITY_HOLD",
            objectId: holdId,
            fromState: null,
            toState: "ACTIVE",
            actor,
            governingRef: `offer:${input.offerId}`,
            idempotencyKey,
            payload: {
                resourceKey: input.resourceKey,
                expiresAt: input.expiresAt.toISOString(),
                tenantId: input.tenantId
            }
        });

        return succeed({
            holdId,
            providerId: input.providerId,
            resourceKey: input.resourceKey,
            state: "ACTIVE"
        });
    } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT kernel_hold");
        if (isExclusionViolation(err)) {
            return fail(
                "CAPACITY_CONFLICT",
                `exclusive capacity for ${input.resourceKey} is already taken over the requested window`
            );
        }
        throw err;
    }
}

export interface KernelHoldRow {
    holdId: string;
    tenantId: string | null;
    marketId: string;
    offerId: string | null;
    resourceKey: string;
    state: CapacityHoldState;
    expiresAt: Date | null;
    startTime: Date;
    endTime: Date;
}

export async function loadHold(
    client: PoolClient,
    holdId: string,
    forUpdate = false
): Promise<KernelHoldRow | null> {
    const { rows } = await client.query<{
        hold_id: string;
        tenant_id: string | null;
        market_id: string;
        offer_id: string | null;
        resource_key: string;
        state: CapacityHoldState;
        expires_at: Date | null;
        start_time: Date;
        end_time: Date;
    }>(
        `SELECT hold_id, tenant_id, market_id, offer_id, resource_key, state, expires_at,
                lower(during) AS start_time, upper(during) AS end_time
           FROM core_capacity_hold WHERE hold_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [holdId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        holdId: row.hold_id,
        tenantId: row.tenant_id,
        marketId: row.market_id,
        offerId: row.offer_id,
        resourceKey: row.resource_key,
        state: row.state,
        expiresAt: row.expires_at,
        startTime: row.start_time,
        endTime: row.end_time
    };
}

export async function holdsForOffer(
    client: PoolClient,
    offerId: string,
    forUpdate = false
): Promise<KernelHoldRow[]> {
    const { rows } = await client.query<{ hold_id: string }>(
        `SELECT hold_id FROM core_capacity_hold
          WHERE offer_id = $1 ORDER BY resource_key ${forUpdate ? "FOR UPDATE" : ""}`,
        [offerId]
    );
    const loaded: KernelHoldRow[] = [];
    for (const row of rows) {
        const hold = await loadHold(client, row.hold_id);
        if (hold) {
            loaded.push(hold);
        }
    }
    return loaded;
}

/**
 * Consumes a hold exactly once. The `state = 'ACTIVE'` predicate is the
 * once-only guarantee: a second attempt matches no row.
 */
export async function consumeHold(
    client: PoolClient,
    holdId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CapacityHold>> {
    const { rows } = await client.query<{ provider_id: string; resource_key: string }>(
        `UPDATE core_capacity_hold
            SET state = 'CONSUMED', consumed_at = now()
          WHERE hold_id = $1 AND state = 'ACTIVE'
      RETURNING provider_id, resource_key`,
        [holdId]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", `capacity hold ${holdId} is not ACTIVE and cannot be consumed`);
    }
    await recordEvent(client, {
        marketId,
        objectType: "CAPACITY_HOLD",
        objectId: holdId,
        fromState: "ACTIVE",
        toState: "CONSUMED",
        actor,
        idempotencyKey
    });
    return succeed({
        holdId,
        providerId: row.provider_id,
        resourceKey: row.resource_key,
        state: "CONSUMED"
    });
}

/** Release is idempotent: releasing an already-terminal hold is a no-op success. */
export async function releaseKernelHold(
    client: PoolClient,
    holdId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<{ holdId: string; state: CapacityHoldState; changed: boolean }>> {
    const { rows } = await client.query<{ state: CapacityHoldState }>(
        `UPDATE core_capacity_hold
            SET state = 'RELEASED', released_at = now()
          WHERE hold_id = $1 AND state = 'ACTIVE'
      RETURNING state`,
        [holdId]
    );
    if (rows.length === 0) {
        const existing = await loadHold(client, holdId);
        if (!existing) {
            return fail("NOT_FOUND", `capacity hold ${holdId} not found`);
        }
        return succeed({ holdId, state: existing.state, changed: false });
    }
    await recordEvent(client, {
        marketId,
        objectType: "CAPACITY_HOLD",
        objectId: holdId,
        fromState: "ACTIVE",
        toState: "RELEASED",
        actor,
        idempotencyKey
    });
    return succeed({ holdId, state: "RELEASED", changed: true });
}

/** A hold may not outlive its governing offer. */
export async function invalidateHoldsForOffer(
    client: PoolClient,
    offerId: string,
    marketId: string,
    actor: Actor,
    idempotencyKeyPrefix: string
): Promise<string[]> {
    const { rows } = await client.query<{ hold_id: string }>(
        `UPDATE core_capacity_hold
            SET state = 'INVALIDATED', released_at = now()
          WHERE offer_id = $1 AND state = 'ACTIVE'
      RETURNING hold_id`,
        [offerId]
    );
    for (const row of rows) {
        await recordEvent(client, {
            marketId,
            objectType: "CAPACITY_HOLD",
            objectId: row.hold_id,
            fromState: "ACTIVE",
            toState: "INVALIDATED",
            actor,
            governingRef: `offer:${offerId}`,
            idempotencyKey: `${idempotencyKeyPrefix}:invalidate:${row.hold_id}`
        });
    }
    return rows.map((r) => r.hold_id);
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
          WHERE request_id = $1 AND status = 'CONFIRMED'`,
        [requestId]
    );

    return succeed({
        releasedHoldIds,
        customerCommitmentAffected: confirmation.rows.length > 0
    });
}
