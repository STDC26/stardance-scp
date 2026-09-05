// SCP Core Foundation — Dispatch Offer.
//
// The offer is a first-class governed object, not an attribute of the request.
// That is what makes "provider decline" expressible as an offer outcome without
// inventing a PROVIDER_DECLINED request state, and what gives inbound channel
// traffic something authoritative to correlate against (NF-09).
//
// Lock ordering is always OFFER then REQUEST. Both the response path and the
// expiry sweep obey it, so the two can race without deadlocking, and the
// re-check after acquiring the offer lock is what makes exactly one of them win.
//
// The acceptance timeout comes from the market configuration plane, never from
// a Core constant.

import type { PoolClient } from "pg";
import {
    fail,
    succeed,
    SYSTEM_ACTOR,
    type Actor,
    type DispatchOfferState,
    type GovernedOutcome
} from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { loadProvider, isDispatchable } from "../provider/provider";
import { authorizeProviderResponse } from "../identity/authority";
import { transitionRequest, loadRequest } from "../request/serviceRequest";
import { loadMarketConfig, type MarketId } from "../../config/marketConfig";

export type OfferDecision = "ACCEPT" | "DECLINE";

export interface DispatchOffer {
    offerId: string;
    marketId: string;
    requestId: string;
    providerId: string;
    state: DispatchOfferState;
    expiresAt: Date;
}

export async function loadOffer(
    client: PoolClient,
    offerId: string
): Promise<DispatchOffer | null> {
    const { rows } = await client.query<{
        offer_id: string;
        market_id: string;
        request_id: string;
        provider_id: string;
        state: DispatchOfferState;
        expires_at: Date;
    }>(
        `SELECT offer_id, market_id, request_id, provider_id, state, expires_at
           FROM core_dispatch_offer WHERE offer_id = $1`,
        [offerId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        offerId: row.offer_id,
        marketId: row.market_id,
        requestId: row.request_id,
        providerId: row.provider_id,
        state: row.state,
        expiresAt: row.expires_at
    };
}

export interface OfferInput {
    requestId: string;
    providerId: string;
    marketId: MarketId;
    /** Injectable for tests; defaults to `new Date()`. */
    now?: () => Date;
}

/**
 * Offers a request to an approved provider. Refuses unapproved supply outright:
 * submitted profile is not approved supply, so it is not dispatchable.
 */
export async function offerDispatch(
    client: PoolClient,
    input: OfferInput,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<DispatchOffer>> {
    const ids = requireUuids({ requestId: input.requestId, providerId: input.providerId });
    if (!ids.ok) {
        return ids;
    }

    let config;
    try {
        config = loadMarketConfig(input.marketId);
    } catch (err) {
        return fail("MARKET_UNKNOWN", err instanceof Error ? err.message : String(err));
    }

    const provider = await loadProvider(client, input.providerId);
    if (!provider) {
        return fail("NOT_FOUND", `provider ${input.providerId} not found`);
    }
    if (provider.marketId !== input.marketId) {
        return fail(
            "UNAUTHORIZED",
            `provider ${input.providerId} belongs to market ${provider.marketId}`
        );
    }
    if (!isDispatchable(provider)) {
        return fail(
            "PROVIDER_NOT_APPROVED",
            `provider ${input.providerId} supply status is ${provider.supplyStatus}, not APPROVED`
        );
    }

    const now = (input.now ?? (() => new Date()))();
    const expiresAt = new Date(
        now.getTime() + config.dispatch.acceptanceTimeoutMinutes * 60_000
    );

    const inserted = await client.query<{ offer_id: string }>(
        `INSERT INTO core_dispatch_offer
            (market_id, request_id, provider_id, state, offered_at, expires_at)
         VALUES ($1, $2, $3, 'OFFERED', $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING offer_id`,
        [input.marketId, input.requestId, input.providerId, now, expiresAt]
    );
    const offerRow = inserted.rows[0];
    if (!offerRow) {
        return fail("STALE_STATE", `request ${input.requestId} already has a live dispatch offer`);
    }

    const moved = await transitionRequest(client, {
        requestId: input.requestId,
        expectedFrom: "PENDING_ACCEPTANCE",
        to: "PROVIDER_DISPATCHED",
        actor,
        idempotencyKey: `${idempotencyKey}:request`,
        governingRef: `offer:${offerRow.offer_id}`
    });
    if (!moved.ok) {
        return moved;
    }

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "DISPATCH_OFFER",
        objectId: offerRow.offer_id,
        fromState: null,
        toState: "OFFERED",
        actor,
        governingRef: `request:${input.requestId}`,
        idempotencyKey: `${idempotencyKey}:offer`,
        payload: { expiresAt: expiresAt.toISOString(), providerId: input.providerId }
    });

    return succeed({
        offerId: offerRow.offer_id,
        marketId: input.marketId,
        requestId: input.requestId,
        providerId: input.providerId,
        state: "OFFERED",
        expiresAt
    });
}

export interface RespondInput {
    offerId: string;
    /** The identity claiming to respond. Authority is re-derived, never trusted. */
    identityId: string;
    decision: OfferDecision;
    now?: () => Date;
}

export interface RespondResult {
    offerId: string;
    offerState: DispatchOfferState;
    requestState: string;
}

/**
 * Records a provider's response to an offer. Every one of the NF-09 authority
 * conditions is checked here, in order, inside the caller's transaction:
 * offer correlation, verified sender authority, offer still current, not
 * expired, not already decided, then the transactional state validation.
 *
 * ACCEPT records acceptance only. It does NOT assign the request — assignment
 * is a separate owner act.
 */
export async function respondToOffer(
    client: PoolClient,
    input: RespondInput,
    idempotencyKey: string
): Promise<GovernedOutcome<RespondResult>> {
    const ids = requireUuids({ offerId: input.offerId, identityId: input.identityId });
    if (!ids.ok) {
        return ids;
    }

    // Lock the offer first — this is the ordering the expiry sweep also uses.
    const locked = await client.query<{ state: DispatchOfferState }>(
        `SELECT state FROM core_dispatch_offer WHERE offer_id = $1 FOR UPDATE`,
        [input.offerId]
    );
    if (locked.rows.length === 0) {
        return fail("NOT_FOUND", `dispatch offer ${input.offerId} not found`);
    }

    const offer = await loadOffer(client, input.offerId);
    if (!offer) {
        return fail("NOT_FOUND", `dispatch offer ${input.offerId} not found`);
    }

    if (offer.state === "ACCEPTED" || offer.state === "DECLINED") {
        return fail("OFFER_ALREADY_DECIDED", `offer ${offer.offerId} is already ${offer.state}`);
    }
    if (offer.state !== "OFFERED") {
        return fail("OFFER_NOT_CURRENT", `offer ${offer.offerId} is ${offer.state}, not OFFERED`);
    }

    const now = (input.now ?? (() => new Date()))();
    if (now >= offer.expiresAt) {
        return fail(
            "OFFER_EXPIRED",
            `offer ${offer.offerId} expired at ${offer.expiresAt.toISOString()}`
        );
    }

    const authorized = await authorizeProviderResponse(
        client,
        input.identityId,
        offer.marketId,
        offer.providerId
    );
    if (!authorized.ok) {
        return authorized;
    }
    const actor = authorized.value;

    const targetOfferState: DispatchOfferState =
        input.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED";

    const updated = await client.query(
        `UPDATE core_dispatch_offer
            SET state = $2, decided_at = $3, decided_by_identity_id = $4
          WHERE offer_id = $1 AND state = 'OFFERED'`,
        [offer.offerId, targetOfferState, now, input.identityId]
    );
    if (updated.rowCount === 0) {
        return fail("OFFER_NOT_CURRENT", `offer ${offer.offerId} was decided concurrently`);
    }

    // ACCEPT -> PROVIDER_ACCEPTED. DECLINE -> back to the dispatch pool. The
    // decline never becomes a request state of its own.
    const requestTarget = input.decision === "ACCEPT" ? "PROVIDER_ACCEPTED" : "PENDING_ACCEPTANCE";
    const moved = await transitionRequest(client, {
        requestId: offer.requestId,
        expectedFrom: "PROVIDER_DISPATCHED",
        to: requestTarget,
        actor,
        idempotencyKey: `${idempotencyKey}:request`,
        governingRef: `offer:${offer.offerId}`,
        payload: { decision: input.decision }
    });
    if (!moved.ok) {
        return moved;
    }

    await recordEvent(client, {
        marketId: offer.marketId,
        objectType: "DISPATCH_OFFER",
        objectId: offer.offerId,
        fromState: "OFFERED",
        toState: targetOfferState,
        actor,
        governingRef: `request:${offer.requestId}`,
        idempotencyKey: `${idempotencyKey}:offer`,
        payload: { decision: input.decision }
    });

    return succeed({
        offerId: offer.offerId,
        offerState: targetOfferState,
        requestState: requestTarget
    });
}

export interface ExpirySweepResult {
    scanned: number;
    expired: string[];
    skippedAlreadyResolved: string[];
}

/**
 * Expires offers past their window and atomically returns each request to
 * PENDING_ACCEPTANCE. Safe to run concurrently with respondToOffer: candidate
 * discovery is lock-free, but every mutation re-checks state after taking the
 * offer's row lock, so exactly one side wins per offer.
 */
export async function expireDispatchOffers(
    client: PoolClient,
    marketId: string,
    options: { now?: () => Date; batchSize?: number } = {}
): Promise<ExpirySweepResult> {
    const now = (options.now ?? (() => new Date()))();
    const batchSize = options.batchSize ?? 200;

    const candidates = await client.query<{ offer_id: string }>(
        `SELECT offer_id FROM core_dispatch_offer
          WHERE market_id = $1 AND state = 'OFFERED' AND expires_at <= $2
          ORDER BY expires_at ASC LIMIT $3`,
        [marketId, now, batchSize]
    );

    const result: ExpirySweepResult = {
        scanned: candidates.rows.length,
        expired: [],
        skippedAlreadyResolved: []
    };

    for (const candidate of candidates.rows) {
        const locked = await client.query<{ state: DispatchOfferState; request_id: string }>(
            `SELECT state, request_id FROM core_dispatch_offer WHERE offer_id = $1 FOR UPDATE`,
            [candidate.offer_id]
        );
        const row = locked.rows[0];
        if (!row || row.state !== "OFFERED") {
            result.skippedAlreadyResolved.push(candidate.offer_id);
            continue;
        }

        const updated = await client.query(
            `UPDATE core_dispatch_offer SET state = 'EXPIRED'
              WHERE offer_id = $1 AND state = 'OFFERED'`,
            [candidate.offer_id]
        );
        if (updated.rowCount === 0) {
            result.skippedAlreadyResolved.push(candidate.offer_id);
            continue;
        }

        const moved = await transitionRequest(client, {
            requestId: row.request_id,
            expectedFrom: "PROVIDER_DISPATCHED",
            to: "PENDING_ACCEPTANCE",
            actor: SYSTEM_ACTOR,
            idempotencyKey: `expiry:${candidate.offer_id}:request`,
            governingRef: `offer:${candidate.offer_id}`,
            payload: { recoveredBy: "DISPATCH_EXPIRY_SWEEP" }
        });
        if (!moved.ok) {
            result.skippedAlreadyResolved.push(candidate.offer_id);
            continue;
        }

        await recordEvent(client, {
            marketId,
            objectType: "DISPATCH_OFFER",
            objectId: candidate.offer_id,
            fromState: "OFFERED",
            toState: "EXPIRED",
            actor: SYSTEM_ACTOR,
            governingRef: `request:${row.request_id}`,
            idempotencyKey: `expiry:${candidate.offer_id}:offer`
        });

        result.expired.push(candidate.offer_id);
    }

    return result;
}

/** Convenience for callers that need the request behind an offer. */
export async function requestForOffer(client: PoolClient, offerId: string) {
    const offer = await loadOffer(client, offerId);
    return offer ? loadRequest(client, offer.requestId) : null;
}
