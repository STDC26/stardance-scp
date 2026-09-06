// SCP Service-Commerce Kernel — CommercialCommit.
//
// A transaction orchestration contract, NOT a business aggregate. It creates no
// system of record of its own: the commitment lands in the existing canonical
// core_service_request, and the capacity it consumes belongs to the existing
// capacity owner.
//
// Landing state is deliberately PENDING_ACCEPTANCE. A commercial commitment is
// the customer's side of the transaction; provider acceptance, owner assignment
// and customer confirmation remain the three separate downstream gates G2
// established. Collapsing them here would be the exact invariant violation the
// programme has refused since G1.
//
// FORBIDDEN OUTCOMES this module is built to make impossible:
//   * a Service Request commitment without the capacity it needs
//   * consumed capacity with no canonical commitment
//   * two commitments against one exclusive capacity
//   * a duplicate Service Request on retry
//   * a commit against an expired / released / invalidated hold
//   * silent repricing at commit time

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type GovernedOutcome } from "../core/types";
import { requireUuids } from "../core/identifiers";
import { recordEvent } from "../core/events/eventLog";
import { consumeHold, holdsForOffer } from "../core/capacity/capacity";
import { createServiceRequestFromSnapshot } from "../core/request/serviceRequest";
import { loadIdentity } from "../core/identity/authority";
import { loadMarketConfig, type MarketId } from "../config/marketConfig";
import { loadOffer, revalidateOffer, type SellableOffer } from "./offer";
import type { KernelDecisionReason } from "./reasons";

export interface CommitInput {
    offerId: string;
    /** The customer committing. Authority is re-derived, never trusted. */
    actorIdentityId: string;
    idempotencyKey: string;
    effectiveAt?: Date;
}

export interface CommitResult {
    offerId: string;
    requestId: string;
    requestVersion: number;
    consumedHoldIds: string[];
    /** True when this call found the offer already committed and returned it. */
    replayed: boolean;
}

export type CommitOutcome =
    | { ok: true; value: CommitResult }
    | { ok: false; reasonCode: KernelDecisionReason; message: string };

function refuse(reasonCode: KernelDecisionReason, message: string): CommitOutcome {
    return { ok: false, reasonCode, message };
}

/**
 * Commits a sellable offer. Must be called inside a transaction; every step
 * below either all lands or none of it does.
 */
export async function commitOffer(
    client: PoolClient,
    input: CommitInput
): Promise<CommitOutcome> {
    const ids = requireUuids({
        offerId: input.offerId,
        actorIdentityId: input.actorIdentityId
    });
    if (!ids.ok) {
        return refuse("INVALID_IDENTIFIER", ids.message);
    }
    const effectiveAt = input.effectiveAt ?? new Date();

    // 1 — lock and read the authoritative offer.
    const offer = await loadOffer(client, input.offerId, true);
    if (!offer) {
        return refuse("OFFER_NO_LONGER_VALID", `offer ${input.offerId} not found`);
    }

    // 2 — idempotent retry: an already-committed offer returns its one result.
    if (offer.state === "COMMITTED") {
        if (!offer.committedRequestId) {
            return refuse(
                "OFFER_NO_LONGER_VALID",
                `offer ${offer.offerId} is COMMITTED but carries no request`
            );
        }
        return {
            ok: true,
            value: {
                offerId: offer.offerId,
                requestId: offer.committedRequestId,
                requestVersion: 1,
                consumedHoldIds: [],
                replayed: true
            }
        };
    }

    // 3 — tenant / market scope.
    let config;
    try {
        config = loadMarketConfig(offer.marketId as MarketId);
    } catch (err) {
        return refuse("MARKET_MISMATCH", err instanceof Error ? err.message : String(err));
    }
    if (config.tenantId !== offer.tenantId) {
        return refuse(
            "TENANT_MISMATCH",
            `offer tenant ${offer.tenantId} does not match market tenant ${config.tenantId}`
        );
    }

    // 4 — authority. Only the customer on the offer may commit it.
    const identity = await loadIdentity(client, input.actorIdentityId);
    if (!identity) {
        return refuse("AUTHORITY_REFUSED", `identity ${input.actorIdentityId} not found`);
    }
    if (identity.marketId !== offer.marketId) {
        return refuse(
            "MARKET_MISMATCH",
            `actor belongs to market ${identity.marketId}, offer to ${offer.marketId}`
        );
    }
    if (!identity.roles.includes("CUSTOMER")) {
        return refuse("AUTHORITY_REFUSED", "actor does not hold the CUSTOMER role");
    }
    if (input.actorIdentityId !== offer.customerIdentityId) {
        return refuse("AUTHORITY_REFUSED", "actor is not the customer this offer was made to");
    }

    // 5 — lock the required holds, then revalidate against current truth.
    const holds = await holdsForOffer(client, offer.offerId, true);
    for (const hold of holds) {
        if (hold.offerId !== offer.offerId) {
            return refuse("OFFER_NO_LONGER_VALID", `hold ${hold.holdId} is not owned by this offer`);
        }
        if (hold.tenantId && hold.tenantId !== offer.tenantId) {
            return refuse("TENANT_MISMATCH", `hold ${hold.holdId} belongs to another tenant`);
        }
    }

    const revalidation = await revalidateOffer(client, offer, effectiveAt);
    if (!revalidation.valid) {
        return refuse(
            revalidation.reasonCode ?? "OFFER_NO_LONGER_VALID",
            revalidation.detail
        );
    }

    const actor: Actor = {
        identityId: input.actorIdentityId,
        role: "CUSTOMER",
        authority: `CUSTOMER_COMMERCIAL_COMMIT:${offer.offerId}`
    };

    // 6 — consume capacity exactly once.
    const consumedHoldIds: string[] = [];
    for (const hold of holds) {
        const consumed = await consumeHold(
            client,
            hold.holdId,
            offer.marketId,
            actor,
            `${input.idempotencyKey}:consume:${hold.holdId}`
        );
        if (!consumed.ok) {
            // Returning here aborts the whole commit; the caller's transaction
            // rolls back, so no hold stays consumed without a commitment.
            return refuse("CAPACITY_HOLD_EXPIRED", consumed.message);
        }
        consumedHoldIds.push(hold.holdId);
    }

    // 7 — canonical commitment, priced from the offer's frozen snapshot.
    const created = await createServiceRequestFromSnapshot(
        client,
        {
            marketId: offer.marketId,
            customerIdentityId: offer.customerIdentityId,
            serviceId: offer.serviceId,
            startTime: offer.startTime,
            endTime: offer.endTime,
            snapshot: {
                priceVersionId: offer.priceVersionId,
                priceMinorUnits: offer.priceMinorUnits,
                currencyCode: offer.currencyCode,
                durationMinutes: offer.durationMinutes,
                addons: []
            }
        },
        actor,
        `${input.idempotencyKey}:request`,
        `offer:${offer.offerId}`
    );
    if (!created.ok) {
        return refuse("OFFER_NO_LONGER_VALID", created.message);
    }

    // 8 — close the offer against the commitment.
    const updated = await client.query(
        `UPDATE core_sellable_offer
            SET state = 'COMMITTED', committed_request_id = $2
          WHERE offer_id = $1 AND state = 'ACTIVE'`,
        [offer.offerId, created.value.requestId]
    );
    if (updated.rowCount === 0) {
        return refuse("OFFER_NO_LONGER_VALID", "offer stopped being ACTIVE during commit");
    }

    // 9 — correlation evidence across the whole chain.
    await recordEvent(client, {
        marketId: offer.marketId,
        objectType: "SERVICE_REQUEST",
        objectId: created.value.requestId,
        fromState: null,
        toState: "COMMERCIALLY_COMMITTED",
        actor,
        governingRef: `offer:${offer.offerId}#evaluation:${offer.evaluationId}`,
        idempotencyKey: `${input.idempotencyKey}:commit`,
        payload: {
            offerId: offer.offerId,
            offerKey: offer.offerKey,
            offerVersion: offer.version,
            evaluationId: offer.evaluationId,
            consumedHoldIds,
            priceMinorUnits: offer.priceMinorUnits,
            currencyCode: offer.currencyCode,
            durationMinutes: offer.durationMinutes,
            tenantId: offer.tenantId
        }
    });

    return {
        ok: true,
        value: {
            offerId: offer.offerId,
            requestId: created.value.requestId,
            requestVersion: created.value.version,
            consumedHoldIds,
            replayed: false
        }
    };
}

/** Full correlation chain for one committed offer, for audit replay. */
export async function commitCorrelation(
    client: PoolClient,
    offerId: string
): Promise<GovernedOutcome<{
    offer: SellableOffer;
    evaluationId: string;
    requestId: string | null;
    holdIds: string[];
}>> {
    const offer = await loadOffer(client, offerId);
    if (!offer) {
        return fail("NOT_FOUND", `offer ${offerId} not found`);
    }
    const holds = await holdsForOffer(client, offerId);
    return succeed({
        offer,
        evaluationId: offer.evaluationId,
        requestId: offer.committedRequestId,
        holdIds: holds.map((h) => h.holdId)
    });
}
