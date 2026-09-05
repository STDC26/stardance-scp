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
// G2R-01 — DURABLE PROPOSAL BINDING. The proposed change-set is normalized and
// persisted on core_amendment at proposal time, together with its SHA-256, and
// the database makes both immutable. Validation derives its inputs from that
// stored proposal. A caller may still pass a change-set, but it is checked for
// exact canonical equality first and refused on mismatch before any
// authoritative mutation — closing the substitution DTS demonstrated by
// proposing Oct 5 and validating Oct 20.
//
// No silent repricing: the candidate version carries its own price snapshot,
// and the delta is reported to the caller rather than applied invisibly.

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type AmendmentState, type GovernedOutcome } from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { loadIdentity } from "../identity/authority";
import { buildCommercialSnapshot } from "../catalogue/catalogue";
import {
    loadRequest,
    loadVersion,
    loadVersionById,
    insertVersion,
    transitionRequest
} from "./serviceRequest";
import {
    canonicalProposalJson,
    normalizeProposal,
    parseStoredProposal,
    proposalHash,
    proposalsEqual,
    proposedStartDate,
    type AmendmentProposalInput,
    type CanonicalAmendmentProposal
} from "./amendmentProposal";
import { activeAssignment } from "../dispatch/assignment";
import {
    activeHoldsForRequest,
    holdCapacity,
    releaseCapacity,
    commitCapacity
} from "../capacity/capacity";
import { activeConfirmation, supersedeConfirmation } from "../confirmation/customerConfirmation";

export interface ProposeInput extends AmendmentProposalInput {
    requestId: string;
    proposedByIdentityId: string;
    reason?: string;
}

export interface ProposedAmendment {
    amendmentId: string;
    state: AmendmentState;
    fromVersion: number;
    /** The version that stays authoritative while this amendment is open. */
    authoritativeVersion: number;
    /** The durable, immutable change-set this amendment is bound to. */
    proposal: CanonicalAmendmentProposal;
    proposalHash: string;
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

    // Normalize before touching anything: an unrepresentable proposal is
    // refused rather than half-recorded.
    const normalized = normalizeProposal(input);
    if (!normalized.ok) {
        return normalized;
    }
    const proposal = normalized.value;
    const hash = proposalHash(proposal);

    const request = await loadRequest(client, input.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${input.requestId} not found`);
    }
    const identity = await loadIdentity(client, input.proposedByIdentityId);
    if (!identity || identity.marketId !== request.marketId) {
        return fail(
            "UNAUTHORIZED",
            `identity ${input.proposedByIdentityId} cannot amend this request`
        );
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
            (request_id, from_version, state, proposed_by_identity_id, reason,
             proposal, proposal_hash)
         VALUES ($1, $2, 'PROPOSED', $3, $4, $5::jsonb, $6)
         RETURNING amendment_id`,
        [
            input.requestId,
            request.currentVersion,
            input.proposedByIdentityId,
            input.reason ?? null,
            canonicalProposalJson(proposal),
            hash
        ]
    );
    const amendmentId = inserted.rows[0]!.amendment_id;

    await recordEvent(client, {
        marketId: request.marketId,
        objectType: "AMENDMENT",
        objectId: amendmentId,
        fromState: null,
        toState: "PROPOSED",
        actor: {
            identityId: input.proposedByIdentityId,
            role: identity.roles[0] ?? "CUSTOMER",
            authority: `IDENTITY:${input.proposedByIdentityId}`
        },
        governingRef: `request:${input.requestId}#v${request.currentVersion}`,
        idempotencyKey,
        // The event payload mirrors the durable proposal exactly, so audit
        // reconstruction never depends on caller memory.
        payload: { proposal, proposalHash: hash }
    });

    return succeed({
        amendmentId,
        state: "PROPOSED",
        fromVersion: request.currentVersion,
        authoritativeVersion: request.currentVersion,
        proposal,
        proposalHash: hash
    });
}

export interface DurableProposalRecord {
    amendmentId: string;
    requestId: string;
    state: AmendmentState;
    fromVersion: number;
    proposal: CanonicalAmendmentProposal;
    proposalHash: string;
    proposedByIdentityId: string;
    proposedVersionId: string | null;
    requiresReconfirmation: boolean;
}

/**
 * Reads the amendment together with its durable proposal. This is the only
 * source validation is permitted to build from.
 */
export async function loadAmendment(
    client: PoolClient,
    amendmentId: string,
    forUpdate = false
): Promise<GovernedOutcome<DurableProposalRecord>> {
    const { rows } = await client.query<{
        amendment_id: string;
        request_id: string;
        state: AmendmentState;
        from_version: number;
        proposal: unknown;
        proposal_hash: string;
        proposed_by_identity_id: string;
        proposed_version_id: string | null;
        requires_reconfirmation: boolean;
    }>(
        `SELECT amendment_id, request_id, state, from_version, proposal, proposal_hash,
                proposed_by_identity_id, proposed_version_id, requires_reconfirmation
           FROM core_amendment WHERE amendment_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [amendmentId]
    );
    const row = rows[0];
    if (!row) {
        return fail("NOT_FOUND", `amendment ${amendmentId} not found`);
    }
    const parsed = parseStoredProposal(row.proposal);
    if (!parsed.ok) {
        return parsed;
    }
    return succeed({
        amendmentId: row.amendment_id,
        requestId: row.request_id,
        state: row.state,
        fromVersion: row.from_version,
        proposal: parsed.value,
        proposalHash: row.proposal_hash,
        proposedByIdentityId: row.proposed_by_identity_id,
        proposedVersionId: row.proposed_version_id,
        requiresReconfirmation: row.requires_reconfirmation
    });
}

export interface ValidationResult {
    amendmentId: string;
    state: AmendmentState;
    candidateVersion: number;
    candidateVersionId: string;
    priceDeltaMinorUnits: number;
    requiresReconfirmation: boolean;
    /** Unchanged while the amendment is open. */
    authoritativeVersion: number;
    proposalHash: string;
}

/**
 * Builds and prices the candidate version from the amendment's durable
 * proposal. Writes a new version ROW but leaves `current_version` alone — this
 * is where "existing commitment remains authoritative" is enforced.
 *
 * `suppliedChange` is optional and exists only for callers that still pass the
 * change-set. When present it must match the durable proposal exactly; a
 * mismatch is refused before any candidate version, capacity, or request row is
 * touched.
 */
export async function validateAmendment(
    client: PoolClient,
    amendmentId: string,
    idempotencyKey: string,
    suppliedChange?: AmendmentProposalInput
): Promise<GovernedOutcome<ValidationResult>> {
    const ids = requireUuids({ amendmentId });
    if (!ids.ok) {
        return ids;
    }

    const loaded = await loadAmendment(client, amendmentId, true);
    if (!loaded.ok) {
        return loaded;
    }
    const amendment = loaded.value;
    if (amendment.state !== "PROPOSED") {
        return fail("STALE_STATE", `amendment ${amendmentId} is ${amendment.state}, not PROPOSED`);
    }

    const request = await loadRequest(client, amendment.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${amendment.requestId} not found`);
    }

    // --- Proposal binding check, before any authoritative work ---------------
    if (suppliedChange !== undefined) {
        const normalizedSupplied = normalizeProposal(suppliedChange);
        if (!normalizedSupplied.ok) {
            return normalizedSupplied;
        }
        if (!proposalsEqual(normalizedSupplied.value, amendment.proposal)) {
            // Auditable refusal. This writes an event and nothing else: no
            // candidate version, no capacity, no request or amendment mutation.
            await recordEvent(client, {
                marketId: request.marketId,
                objectType: "AMENDMENT",
                objectId: amendmentId,
                fromState: amendment.state,
                toState: "VALIDATION_REFUSED_PROPOSAL_MISMATCH",
                actor: {
                    identityId: amendment.proposedByIdentityId,
                    role: "SYSTEM",
                    authority: `PROPOSAL_BINDING_CHECK:${amendmentId}`
                },
                governingRef: `amendment:${amendmentId}#${amendment.proposalHash}`,
                idempotencyKey: `${idempotencyKey}:mismatch`,
                payload: {
                    durableProposal: amendment.proposal,
                    durableProposalHash: amendment.proposalHash,
                    suppliedProposal: normalizedSupplied.value,
                    suppliedProposalHash: proposalHash(normalizedSupplied.value)
                }
            });
            return fail(
                "PROPOSAL_MISMATCH",
                `supplied change-set does not match the durable proposal for amendment ${amendmentId}; durable hash ${amendment.proposalHash}`
            );
        }
    }
    // ------------------------------------------------------------------------

    const committed = await loadVersion(client, request.requestId, request.currentVersion);
    if (!committed) {
        return fail("NOT_FOUND", `authoritative version ${request.currentVersion} missing`);
    }

    // Absent fields keep the committed value. Nothing price-impacting is
    // introduced that the durable proposal did not ask for.
    const addonIds = amendment.proposal.newAddonIds ?? committed.addonIds;
    const snapshot = await buildCommercialSnapshot(client, request.serviceId, addonIds);
    if (!snapshot.ok) {
        return snapshot;
    }

    const startTime = proposedStartDate(amendment.proposal) ?? committed.startTime;
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
    const requiresReconfirmation = confirmation !== null && (windowChanged || priceDelta !== 0);

    const nextState: AmendmentState = requiresReconfirmation
        ? "REQUIRES_RECONFIRMATION"
        : "VALIDATING";

    // proposal / proposal_hash are intentionally absent from this UPDATE; the
    // database trigger would reject any attempt to include them.
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
            identityId: amendment.proposedByIdentityId,
            role: "OWNER",
            authority: `AMENDMENT_VALIDATION:${amendmentId}`
        },
        // The validation event carries the same proposal identity as the
        // proposal event, so the pair is linkable without external context.
        governingRef: `amendment:${amendmentId}#${amendment.proposalHash}`,
        idempotencyKey,
        payload: {
            proposalHash: amendment.proposalHash,
            candidateVersionId,
            priceDeltaMinorUnits: priceDelta,
            windowChanged,
            requiresReconfirmation
        }
    });

    return succeed({
        amendmentId,
        state: nextState,
        candidateVersion,
        candidateVersionId,
        priceDeltaMinorUnits: priceDelta,
        requiresReconfirmation,
        authoritativeVersion: request.currentVersion,
        proposalHash: amendment.proposalHash
    });
}

export interface ApplyResult {
    amendmentId: string;
    adoptedVersion: number;
    reconfirmationRequired: boolean;
    requestState: string;
    proposalHash: string;
}

/**
 * Adopts the candidate version. This is the only moment the authoritative
 * version moves, and the version adopted is the one the bound proposal
 * produced — identified by `proposed_version_id`, not recomputed. Capacity is
 * swapped under a savepoint so a conflicting new window leaves the committed
 * capacity exactly as it was.
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

    const loaded = await loadAmendment(client, amendmentId, true);
    if (!loaded.ok) {
        return loaded;
    }
    const amendment = loaded.value;
    if (amendment.state !== "VALIDATING" && amendment.state !== "REQUIRES_RECONFIRMATION") {
        return fail(
            "STALE_STATE",
            `amendment ${amendmentId} is ${amendment.state}; validate it before applying`
        );
    }
    if (!amendment.proposedVersionId) {
        return fail("INVALID_TRANSITION", `amendment ${amendmentId} has no candidate version`);
    }

    const request = await loadRequest(client, amendment.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${amendment.requestId} not found`);
    }

    // Bound adoption: load the exact version validation produced.
    const candidate = await loadVersionById(client, amendment.proposedVersionId);
    if (!candidate) {
        return fail("NOT_FOUND", `candidate version for amendment ${amendmentId} missing`);
    }
    if (candidate.requestId !== request.requestId) {
        return fail(
            "INVALID_TRANSITION",
            `candidate version ${amendment.proposedVersionId} does not belong to request ${request.requestId}`
        );
    }

    const actor: Actor = {
        identityId: ownerIdentityId,
        role: "OWNER",
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
    if (amendment.requiresReconfirmation) {
        await supersedeConfirmation(client, request.requestId);
        if (request.state === "CUSTOMER_CONFIRMED") {
            const moved = await transitionRequest(client, {
                requestId: request.requestId,
                expectedFrom: "CUSTOMER_CONFIRMED",
                to: "AWAITING_CUSTOMER_CONFIRMATION",
                actor,
                idempotencyKey: `${idempotencyKey}:reconfirm`,
                governingRef: `amendment:${amendmentId}#${amendment.proposalHash}`
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
        governingRef: `amendment:${amendmentId}#${amendment.proposalHash}`,
        idempotencyKey: `${idempotencyKey}:applied`,
        payload: {
            adoptedVersion: candidate.version,
            adoptedVersionId: candidate.requestVersionId,
            proposalHash: amendment.proposalHash
        }
    });

    return succeed({
        amendmentId,
        adoptedVersion: candidate.version,
        reconfirmationRequired: amendment.requiresReconfirmation,
        requestState,
        proposalHash: amendment.proposalHash
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
