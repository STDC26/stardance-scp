// SCP Core Foundation — Fulfillment / Result.
//
// FULFILLMENT: the canonical active state is FULFILLMENT_ACTIVE (legacy alias
// STAGE_5_SERVICE_FULFILLMENT). Results are persisted governed state plus audit
// evidence — a WhatsApp message saying "all done" is not closure.
//
// FOUNDATIONAL_INVARIANT: service completion is not payment or settlement.
// Nothing here touches money; SERVICE_COMPLETED is an operational fact only.

import type { PoolClient } from "pg";
import {
    fail,
    succeed,
    type Actor,
    type FulfillmentResultValue,
    type GovernedOutcome,
    type ServiceRequestState
} from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { authorizeOwnerAssignment } from "../identity/authority";
import { transitionRequest, loadRequest } from "../request/serviceRequest";
import { activeHoldsForRequest, releaseCapacity } from "../capacity/capacity";

/** Migration-era alias retained for traceability; not a canonical state. */
export const LEGACY_FULFILLMENT_ALIAS = "STAGE_5_SERVICE_FULFILLMENT" as const;
export const CANONICAL_ACTIVE_STATE: ServiceRequestState = "FULFILLMENT_ACTIVE";

/** Begins service delivery on a confirmed booking. */
export async function beginFulfillment(
    client: PoolClient,
    requestId: string,
    identityId: string,
    idempotencyKey: string
): Promise<GovernedOutcome<{ state: ServiceRequestState }>> {
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
        expectedFrom: "CUSTOMER_CONFIRMED",
        to: "FULFILLMENT_ACTIVE",
        actor: authorized.value,
        idempotencyKey,
        governingRef: `version:${request.currentVersion}`,
        payload: { legacyAlias: LEGACY_FULFILLMENT_ALIAS }
    });
    if (!moved.ok) {
        return moved;
    }
    return succeed({ state: "FULFILLMENT_ACTIVE" });
}

export interface FulfillmentRecord {
    fulfillmentId: string;
    result: FulfillmentResultValue;
    requestState: ServiceRequestState;
}

/**
 * Records the terminal operational result and releases the capacity the booking
 * was holding. The request state and the fulfillment record are written in the
 * same transaction so a result can never exist without its state, or vice versa.
 */
export async function recordFulfillmentResult(
    client: PoolClient,
    requestId: string,
    identityId: string,
    result: FulfillmentResultValue,
    idempotencyKey: string,
    notes?: string
): Promise<GovernedOutcome<FulfillmentRecord>> {
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
    const actor: Actor = authorized.value;

    const moved = await transitionRequest(client, {
        requestId,
        expectedFrom: "FULFILLMENT_ACTIVE",
        to: result,
        actor,
        idempotencyKey: `${idempotencyKey}:request`,
        governingRef: `version:${request.currentVersion}`
    });
    if (!moved.ok) {
        return moved;
    }

    const inserted = await client.query<{ fulfillment_id: string }>(
        `INSERT INTO core_fulfillment (request_id, result, recorded_by_identity_id, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING fulfillment_id`,
        [requestId, result, identityId, notes ?? null]
    );
    const fulfillmentId = inserted.rows[0]!.fulfillment_id;

    for (const hold of await activeHoldsForRequest(client, requestId)) {
        await releaseCapacity(
            client,
            hold.holdId,
            request.marketId,
            actor,
            `${idempotencyKey}:release:${hold.holdId}`
        );
    }

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "FULFILLMENT",
        objectId: fulfillmentId,
        fromState: "FULFILLMENT_ACTIVE",
        toState: result,
        actor,
        governingRef: `request:${requestId}`,
        idempotencyKey: `${idempotencyKey}:fulfillment`
    });

    return succeed({ fulfillmentId, result, requestState: result });
}
