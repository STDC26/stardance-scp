// SCP Core Foundation — Customer Confirmation.
//
// DISPATCH_ASSIGNMENT_CONFIRMATION: "Owner assignment does not confirm the
// customer booking. Customer confirmation is a separate governed
// authorization." The confirmation binds to an exact request *version*, so an
// amendment that changes the customer-facing commitment can be detected as
// invalidating it rather than silently inheriting consent.

import type { PoolClient } from "pg";
import { fail, succeed, type GovernedOutcome } from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { authorizeCustomerConfirmation } from "../identity/authority";
import { transitionRequest, loadRequest } from "../request/serviceRequest";

export interface ConfirmInput {
    requestId: string;
    /** The customer confirming. Must be the customer on this request. */
    identityId: string;
    /**
     * The version the customer is agreeing to. Supplying a stale version is
     * refused rather than upgraded — consent is version-specific.
     */
    confirmedVersion: number;
}

export interface ConfirmResult {
    confirmationId: string;
    confirmedVersion: number;
}

export async function confirmBooking(
    client: PoolClient,
    input: ConfirmInput,
    idempotencyKey: string
): Promise<GovernedOutcome<ConfirmResult>> {
    const ids = requireUuids({ requestId: input.requestId, identityId: input.identityId });
    if (!ids.ok) {
        return ids;
    }

    const request = await loadRequest(client, input.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${input.requestId} not found`);
    }

    const authorized = await authorizeCustomerConfirmation(
        client,
        input.identityId,
        request.marketId,
        input.requestId
    );
    if (!authorized.ok) {
        return authorized;
    }
    const actor = authorized.value;

    if (input.confirmedVersion !== request.currentVersion) {
        return fail(
            "STALE_STATE",
            `customer confirmed version ${input.confirmedVersion} but the authoritative version is ${request.currentVersion}`
        );
    }

    const moved = await transitionRequest(client, {
        requestId: input.requestId,
        expectedFrom: "AWAITING_CUSTOMER_CONFIRMATION",
        to: "CUSTOMER_CONFIRMED",
        actor,
        idempotencyKey: `${idempotencyKey}:request`,
        governingRef: `version:${input.confirmedVersion}`
    });
    if (!moved.ok) {
        return moved;
    }

    const inserted = await client.query<{ confirmation_id: string }>(
        `INSERT INTO core_customer_confirmation
            (request_id, confirmed_version, confirmed_by_identity_id)
         VALUES ($1, $2, $3)
         RETURNING confirmation_id`,
        [input.requestId, input.confirmedVersion, input.identityId]
    );
    const confirmationId = inserted.rows[0]!.confirmation_id;

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "CUSTOMER_CONFIRMATION",
        objectId: confirmationId,
        fromState: null,
        toState: "CONFIRMED",
        actor,
        governingRef: `request:${input.requestId}#v${input.confirmedVersion}`,
        idempotencyKey: `${idempotencyKey}:confirmation`
    });

    return succeed({ confirmationId, confirmedVersion: input.confirmedVersion });
}

/**
 * Marks the active confirmation superseded. Called when an adopted amendment
 * changed the customer-facing commitment; the customer must reconfirm.
 */
export async function supersedeConfirmation(
    client: PoolClient,
    requestId: string
): Promise<string | null> {
    const { rows } = await client.query<{ confirmation_id: string }>(
        `UPDATE core_customer_confirmation SET superseded_at = now()
          WHERE request_id = $1 AND superseded_at IS NULL
      RETURNING confirmation_id`,
        [requestId]
    );
    return rows[0]?.confirmation_id ?? null;
}

export async function activeConfirmation(
    client: PoolClient,
    requestId: string
): Promise<{ confirmationId: string; confirmedVersion: number } | null> {
    const { rows } = await client.query<{ confirmation_id: string; confirmed_version: number }>(
        `SELECT confirmation_id, confirmed_version FROM core_customer_confirmation
          WHERE request_id = $1 AND superseded_at IS NULL`,
        [requestId]
    );
    const row = rows[0];
    return row
        ? { confirmationId: row.confirmation_id, confirmedVersion: row.confirmed_version }
        : null;
}
