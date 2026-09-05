// SCP Core Foundation — Amendment.
//
// AMENDMENT_MODEL: a versioned Service Request sub-record. Deliberately NOT a
// top-level Service Request state — there is no AMENDMENT_PENDING_REVALIDATION.
//
// The load-bearing rule: "Existing commitment remains authoritative until a
// replacement is validly adopted." A proposed amendment writes a candidate
// version row but does not move `current_version`; every reader continues to
// see the committed commercial terms until applyAmendment succeeds.
//
// No silent repricing: the candidate version carries its own price snapshot,
// and the delta is reported to the caller rather than applied invisibly.

import type { PoolClient } from "pg";
import {
    fail,
    succeed,
    type AmendmentState,
    type GovernedOutcome
} from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { loadIdentity } from "../identity/authority";
import { buildCommercialSnapshot } from "../catalogue/catalogue";
import {
    loadRequest,
    loadVersion,
    insertVersion,
    transitionRequest
} from "./serviceRequest";
import { activeAssignment } from "../dispatch/assignment";
import {
    activeHoldsForRequest,
    holdCapacity,
    releaseCapacity,
    commitCapacity
} from "../capacity/capacity";
import { activeConfirmation, supersedeConfirmation } from "../confirmation/customerConfirmation";

export interface ProposeInput {
    requestId: string;
    proposedByIdentityId: string;
    /** New start time, or omit to keep the committed one. */
    newStartTime?: Date;
    /** Replacement add-on set, or omit to keep the committed one. */
    newAddonIds?: readonly string[];
    reason?: string;
}

export interface ProposedAmendment {
    amendmentId: string;
    state: AmendmentState;
    fromVersion: number;
    /** The version that stays authoritative while this amendment is open. */
    authoritativeVersion: number;
}

export async function proposeAmendment(
    client: PoolClient,
    input: ProposeInput,
    idempotencyKey: string
): Promise<GovernedOutcome<ProposedAmendment>> {
    const ids = requireUuids({
        requestId: input.requestId,
        proposedByIdentityId: input.proposedByIdentityId
    });
    if (!ids.ok) {
        return ids;
    }

    const request = await loadRequest(client, input.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${input.requestId} not found`);
    }
    const identity = await loadIdentity(client, input.proposedByIdentityId);
    if (!identity || identity.marketId !== request.marketId) {
        return fail("UNAUTHORIZED", `identity ${input.proposedByIdentityId} cannot amend this request`);
    }

    const open = await client.query<{ amendment_id: string }>(
        `SELECT amendment_id FROM core_amendment
          WHERE request_id = $1
            AND state IN ('PROPOSED', 'VALIDATING', 'REQUIRES_RECONFIRMATION')`,
        [input.requestId]
    );
    if (open.rows.length > 0) {
        return fail(
            "AMENDMENT_IN_FLIGHT",
            `request ${input.requestId} already has an open amendment`
        );
    }

    const inserted = await client.query<{ amendment_id: string }>(
        `INSERT INTO core_amendment
            (request_id, from_version, state, proposed_by_identity_id, reason)
         VALUES ($1, $2, 'PROPOSED', $3, $4)
         RETURNING amendment_id`,
        [input.requestId, request.currentVersion, input.proposedByIdentityId, input.reason ?? null]
    );
    const amendmentId = inserted.rows[0]!.amendment_id;

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "AMENDMENT",
        objectId: amendmentId,
        fromState: null,
        toState: "PROPOSED",
        actor: { identityId: input.proposedByIdentityId, role: identity.roles[0] ?? "CUSTOMER", authority: `IDENTITY:${input.proposedByIdentityId}` },
        governingRef: `request:${input.requestId}#v${request.currentVersion}`,
        idempotencyKey,
        payload: {
            newStartTime: input.newStartTime?.toISOString() ?? null,
            newAddonIds: input.newAddonIds ?? null
        }
    });

    // Stash the proposal parameters on the amendment for the validate step.
    await client.query(
        `UPDATE core_amendment SET reason = COALESCE(reason, '') WHERE amendment_id = $1`,
        [amendmentId]
    );

    return succeed({
        amendmentId,
        state: "PROPOSED",
        fromVersion: request.currentVersion,
        authoritativeVersion: request.currentVersion
    });
}

export interface ValidationResult {
    amendmentId: string;
    state: AmendmentState;
    candidateVersion: number;
    priceDeltaMinorUnits: number;
    requiresReconfirmation: boolean;
    /** Unchanged while the amendment is open. */
    authoritativeVersion: number;
}

/**
 * Builds and prices the candidate version. Writes a new version ROW but leaves
 * `current_version` alone — this is the step where "existing commitment remains
 * authoritative" is actually enforced.
 */
export async function validateAmendment(
    client: PoolClient,
    amendmentId: string,
    change: { newStartTime?: Date; newAddonIds?: readonly string[] },
    idempotencyKey: string
): Promise<GovernedOutcome<ValidationResult>> {
    const ids = requireUuids({ amendmentId });
    if (!ids.ok) {
        return ids;
    }

    const amendmentRows = await client.query<{
        request_id: string;
        from_version: number;
        state: AmendmentState;
        proposed_by_identity_id: string;
    }>(
        `SELECT request_id, from_version, state, proposed_by_identity_id
           FROM core_amendment WHERE amendment_id = $1 FOR UPDATE`,
        [amendmentId]
    );
    const amendment = amendmentRows.rows[0];
    if (!amendment) {
        return fail("NOT_FOUND", `amendment ${amendmentId} not found`);
    }
    if (amendment.state !== "PROPOSED") {
        return fail("STALE_STATE", `amendment ${amendmentId} is ${amendment.state}, not PROPOSED`);
    }

    const request = await loadRequest(client, amendment.request_id);
    if (!request) {
        return fail("NOT_FOUND", `service request ${amendment.request_id} not found`);
    }
    const committed = await loadVersion(client, request.requestId, request.currentVersion);
    if (!committed) {
        return fail("NOT_FOUND", `authoritative version ${request.currentVersion} missing`);
    }

    const snapshot = await buildCommercialSnapshot(
        client,
        request.serviceId,
        change.newAddonIds ?? []
    );
    if (!snapshot.ok) {
        return snapshot;
    }

    const startTime = change.newStartTime ?? committed.startTime;
    const endTime = new Date(startTime.getTime() + snapshot.value.durationMinutes * 60_000);
    const candidateVersion = request.currentVersion + 1;

    const candidateVersionId = await insertVersion(
        client,
        request.requestId,
        candidateVersion,
        snapshot.value,
        startTime,
        endTime
    );

    // A customer-facing change is one that moves the window or the price. Only
    // those require the customer to agree again.
    const windowChanged =
        startTime.getTime() !== committed.startTime.getTime() ||
        endTime.getTime() !== committed.endTime.getTime();
    const priceDelta = snapshot.value.priceMinorUnits - committed.priceMinorUnits;
    const confirmation = await activeConfirmation(client, request.requestId);
    const requiresReconfirmation =
        confirmation !== null && (windowChanged || priceDelta !== 0);

    const nextState: AmendmentState = requiresReconfirmation
        ? "REQUIRES_RECONFIRMATION"
        : "VALIDATING";

    await client.query(
        `UPDATE core_amendment
            SET state = $2, proposed_version_id = $3, requires_reconfirmation = $4
          WHERE amendment_id = $1`,
        [amendmentId, nextState, candidateVersionId, requiresReconfirmation]
    );

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "AMENDMENT",
        objectId: amendmentId,
        fromState: "PROPOSED",
        toState: nextState,
        actor: {
            identityId: amendment.proposed_by_identity_id,
            role: "OWNER",
            authority: `AMENDMENT_VALIDATION:${amendmentId}`
        },
        governingRef: `request:${request.requestId}#candidate_v${candidateVersion}`,
        idempotencyKey,
        payload: { priceDeltaMinorUnits: priceDelta, windowChanged, requiresReconfirmation }
    });

    return succeed({
        amendmentId,
        state: nextState,
        candidateVersion,
        priceDeltaMinorUnits: priceDelta,
        requiresReconfirmation,
        authoritativeVersion: request.currentVersion
    });
}

export interface ApplyResult {
    amendmentId: string;
    adoptedVersion: number;
    reconfirmationRequired: boolean;
    requestState: string;
}

/**
 * Adopts the candidate version. This is the only moment the authoritative
 * version moves. Capacity is swapped under a savepoint so a conflicting new
 * window leaves the committed capacity exactly as it was.
 */
export async function applyAmendment(
    client: PoolClient,
    amendmentId: string,
    ownerIdentityId: string,
    idempotencyKey: string
): Promise<GovernedOutcome<ApplyResult>> {
    const ids = requireUuids({ amendmentId, ownerIdentityId });
    if (!ids.ok) {
        return ids;
    }

    const amendmentRows = await client.query<{
        request_id: string;
        state: AmendmentState;
        proposed_version_id: string | null;
        requires_reconfirmation: boolean;
    }>(
        `SELECT request_id, state, proposed_version_id, requires_reconfirmation
           FROM core_amendment WHERE amendment_id = $1 FOR UPDATE`,
        [amendmentId]
    );
    const amendment = amendmentRows.rows[0];
    if (!amendment) {
        return fail("NOT_FOUND", `amendment ${amendmentId} not found`);
    }
    if (amendment.state !== "VALIDATING" && amendment.state !== "REQUIRES_RECONFIRMATION") {
        return fail(
            "STALE_STATE",
            `amendment ${amendmentId} is ${amendment.state}; validate it before applying`
        );
    }
    if (!amendment.proposed_version_id) {
        return fail("INVALID_TRANSITION", `amendment ${amendmentId} has no candidate version`);
    }

    const request = await loadRequest(client, amendment.request_id);
    if (!request) {
        return fail("NOT_FOUND", `service request ${amendment.request_id} not found`);
    }

    const candidate = await loadVersion(client, request.requestId, request.currentVersion + 1);
    if (!candidate) {
        return fail("NOT_FOUND", `candidate version for amendment ${amendmentId} missing`);
    }

    const actor = {
        identityId: ownerIdentityId,
        role: "OWNER" as const,
        authority: `OWNER_AMENDMENT_ADOPTION:${amendmentId}`
    };

    // Swap capacity atomically: if the new window collides, nothing moves.
    const assignment = await activeAssignment(client, request.requestId);
    if (assignment) {
        await client.query("SAVEPOINT amendment_capacity");
        const previousHolds = await activeHoldsForRequest(client, request.requestId);
        for (const hold of previousHolds) {
            await releaseCapacity(
                client,
                hold.holdId,
                request.marketId,
                actor,
                `${idempotencyKey}:release:${hold.holdId}`
            );
        }
        const rehold = await holdCapacity(
            client,
            {
                marketId: request.marketId,
                providerId: assignment.providerId,
                locationId: "PRIMARY",
                requestId: request.requestId,
                startTime: candidate.startTime,
                endTime: candidate.endTime
            },
            actor,
            `${idempotencyKey}:rehold`
        );
        if (!rehold.ok) {
            await client.query("ROLLBACK TO SAVEPOINT amendment_capacity");
            return fail(
                "CAPACITY_CONFLICT",
                `amended window collides with existing exclusive capacity; committed version ${request.currentVersion} remains authoritative`
            );
        }
        await commitCapacity(
            client,
            rehold.value.holdId,
            request.marketId,
            actor,
            `${idempotencyKey}:recommit`
        );
        await client.query("RELEASE SAVEPOINT amendment_capacity");
    }

    // Only now does the replacement become authoritative.
    await client.query(
        `UPDATE core_service_request
            SET current_version = $2, lock_version = lock_version + 1, updated_at = now()
          WHERE request_id = $1`,
        [request.requestId, candidate.version]
    );

    await client.query(
        `UPDATE core_amendment SET state = 'APPLIED', resolved_at = now()
          WHERE amendment_id = $1`,
        [amendmentId]
    );

    let requestState: string = request.state;
    if (amendment.requires_reconfirmation) {
        await supersedeConfirmation(client, request.requestId);
        if (request.state === "CUSTOMER_CONFIRMED") {
            const moved = await transitionRequest(client, {
                requestId: request.requestId,
                expectedFrom: "CUSTOMER_CONFIRMED",
                to: "AWAITING_CUSTOMER_CONFIRMATION",
                actor,
                idempotencyKey: `${idempotencyKey}:reconfirm`,
                governingRef: `amendment:${amendmentId}`
            });
            if (!moved.ok) {
                return moved;
            }
            requestState = "AWAITING_CUSTOMER_CONFIRMATION";
        }
    }

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "AMENDMENT",
        objectId: amendmentId,
        fromState: amendment.state,
        toState: "APPLIED",
        actor,
        governingRef: `request:${request.requestId}#v${candidate.version}`,
        idempotencyKey: `${idempotencyKey}:applied`,
        payload: { adoptedVersion: candidate.version }
    });

    return succeed({
        amendmentId,
        adoptedVersion: candidate.version,
        reconfirmationRequired: amendment.requires_reconfirmation,
        requestState
    });
}

export async function rejectAmendment(
    client: PoolClient,
    amendmentId: string,
    ownerIdentityId: string,
    idempotencyKey: string,
    terminal: "REJECTED" | "WITHDRAWN" = "REJECTED"
): Promise<GovernedOutcome<{ amendmentId: string; state: AmendmentState }>> {
    const ids = requireUuids({ amendmentId, ownerIdentityId });
    if (!ids.ok) {
        return ids;
    }
    const { rows } = await client.query<{ request_id: string; state: AmendmentState }>(
        `UPDATE core_amendment SET state = $2, resolved_at = now()
          WHERE amendment_id = $1
            AND state IN ('PROPOSED', 'VALIDATING', 'REQUIRES_RECONFIRMATION')
      RETURNING request_id, state`,
        [amendmentId, terminal]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", `amendment ${amendmentId} is not open`);
    }
    const request = await loadRequest(client, row.request_id);
    await recordEvent(client, {
        marketId: request?.marketId ?? "unknown",
        objectType: "AMENDMENT",
        objectId: amendmentId,
        fromState: "OPEN",
        toState: terminal,
        actor: {
            identityId: ownerIdentityId,
            role: "OWNER",
            authority: `OWNER_AMENDMENT_DECISION:${amendmentId}`
        },
        idempotencyKey
    });
    return succeed({ amendmentId, state: terminal });
}
