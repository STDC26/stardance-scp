// SCP Core Foundation — Owner Assignment.
//
// DISPATCH_ASSIGNMENT_CONFIRMATION: "Provider acceptance does not assign the
// request." Assignment is an explicit owner act on top of a recorded
// acceptance, and it commits the capacity that was held for the work.
//
// This module is deliberately separate from dispatchOffer.ts so the two
// authorities cannot be collapsed by accident.

import type { PoolClient } from "pg";
import { fail, succeed, type GovernedOutcome } from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { authorizeOwnerAssignment } from "../identity/authority";
import { transitionRequest, loadRequest } from "../request/serviceRequest";
import { loadOffer } from "./dispatchOffer";
import { commitCapacity, activeHoldsForRequest } from "../capacity/capacity";

export interface AssignInput {
    requestId: string;
    offerId: string;
    /** The owner performing the assignment. */
    identityId: string;
}

export interface AssignResult {
    assignmentId: string;
    providerId: string;
    committedHoldIds: string[];
}

/**
 * Assigns an accepted request to the provider that accepted it, then commits
 * that provider's outstanding capacity holds. Refuses if the offer was not
 * actually accepted — an owner cannot assign work nobody agreed to.
 */
export async function assignRequest(
    client: PoolClient,
    input: AssignInput,
    idempotencyKey: string
): Promise<GovernedOutcome<AssignResult>> {
    const ids = requireUuids({
        requestId: input.requestId,
        offerId: input.offerId,
        identityId: input.identityId
    });
    if (!ids.ok) {
        return ids;
    }

    const request = await loadRequest(client, input.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${input.requestId} not found`);
    }

    const authorized = await authorizeOwnerAssignment(client, input.identityId, request.marketId);
    if (!authorized.ok) {
        return authorized;
    }
    const actor = authorized.value;

    const offer = await loadOffer(client, input.offerId);
    if (!offer) {
        return fail("NOT_FOUND", `dispatch offer ${input.offerId} not found`);
    }
    if (offer.requestId !== input.requestId) {
        return fail(
            "OFFER_NOT_CURRENT",
            `offer ${input.offerId} does not belong to request ${input.requestId}`
        );
    }
    if (offer.state !== "ACCEPTED") {
        return fail(
            "INVALID_TRANSITION",
            `cannot assign from offer in state ${offer.state}; provider acceptance is required first`
        );
    }

    const moved = await transitionRequest(client, {
        requestId: input.requestId,
        expectedFrom: "PROVIDER_ACCEPTED",
        to: "OWNER_ASSIGNED",
        actor,
        idempotencyKey: `${idempotencyKey}:request`,
        governingRef: `offer:${offer.offerId}`
    });
    if (!moved.ok) {
        return moved;
    }

    const inserted = await client.query<{ assignment_id: string }>(
        `INSERT INTO core_assignment
            (request_id, provider_id, offer_id, assigned_by_identity_id)
         VALUES ($1, $2, $3, $4)
         RETURNING assignment_id`,
        [input.requestId, offer.providerId, offer.offerId, input.identityId]
    );
    const assignmentId = inserted.rows[0]!.assignment_id;

    // The provisional hold becomes a commitment now that an owner has bound the
    // work to this provider.
    const committedHoldIds: string[] = [];
    for (const hold of await activeHoldsForRequest(client, input.requestId)) {
        if (hold.state !== "HELD") {
            continue;
        }
        const committed = await commitCapacity(
            client,
            hold.holdId,
            request.marketId,
            actor,
            `${idempotencyKey}:commit:${hold.holdId}`
        );
        if (committed.ok) {
            committedHoldIds.push(hold.holdId);
        }
    }

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "ASSIGNMENT",
        objectId: assignmentId,
        fromState: null,
        toState: "ASSIGNED",
        actor,
        governingRef: `request:${input.requestId}`,
        idempotencyKey: `${idempotencyKey}:assignment`,
        payload: { providerId: offer.providerId, offerId: offer.offerId }
    });

    return succeed({ assignmentId, providerId: offer.providerId, committedHoldIds });
}

/**
 * Moves an assigned request to AWAITING_CUSTOMER_CONFIRMATION. Kept as its own
 * command so that "assigned" and "presented to the customer" remain
 * distinguishable in the audit trail.
 */
export async function requestCustomerConfirmation(
    client: PoolClient,
    requestId: string,
    identityId: string,
    idempotencyKey: string
): Promise<GovernedOutcome<{ state: string }>> {
    const ids = requireUuids({ requestId, identityId });
    if (!ids.ok) {
        return ids;
    }
    const request = await loadRequest(client, requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${requestId} not found`);
    }
    const authorized = await authorizeOwnerAssignment(client, identityId, request.marketId);
    if (!authorized.ok) {
        return authorized;
    }
    const moved = await transitionRequest(client, {
        requestId,
        expectedFrom: "OWNER_ASSIGNED",
        to: "AWAITING_CUSTOMER_CONFIRMATION",
        actor: authorized.value,
        idempotencyKey,
        governingRef: `version:${request.currentVersion}`
    });
    if (!moved.ok) {
        return moved;
    }
    return succeed({ state: "AWAITING_CUSTOMER_CONFIRMATION" });
}

export async function activeAssignment(
    client: PoolClient,
    requestId: string
): Promise<{ assignmentId: string; providerId: string } | null> {
    const { rows } = await client.query<{ assignment_id: string; provider_id: string }>(
        `SELECT assignment_id, provider_id FROM core_assignment
          WHERE request_id = $1 AND revoked_at IS NULL`,
        [requestId]
    );
    const row = rows[0];
    return row ? { assignmentId: row.assignment_id, providerId: row.provider_id } : null;
}
