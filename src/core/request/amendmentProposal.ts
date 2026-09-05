// SCP-G2R-01 — canonical Amendment proposal representation.
//
// One deterministic form for "what this amendment is asking for", so the
// change-set validated is provably the change-set proposed.
//
// EXPLICIT ABSENT / NULL / EMPTY SEMANTICS
//   newStartTime: null  -> keep the committed start time
//                 string -> move to exactly this instant
//   newAddonIds:  null  -> keep the committed add-on set
//                 []    -> explicitly remove every add-on
//                 [...] -> replace the set with exactly these
//
// `undefined` on input means "not specified" and normalizes to null. An empty
// array is therefore never confused with an absent field, which matters because
// the two have opposite commercial effects.

import { createHash } from "node:crypto";
import { fail, succeed, type GovernedOutcome } from "../types";
import { isUuid } from "../identifiers";

export const AMENDMENT_PROPOSAL_SCHEMA = "scp.amendment.proposal.v1" as const;

export interface AmendmentProposalInput {
    newStartTime?: Date | null;
    newAddonIds?: readonly string[] | null;
}

export interface CanonicalAmendmentProposal {
    schema: typeof AMENDMENT_PROPOSAL_SCHEMA;
    /** ISO 8601, UTC, millisecond precision. Null means "keep committed". */
    newStartTime: string | null;
    /** Lowercased and sorted. Null means "keep committed"; [] means "remove all". */
    newAddonIds: string[] | null;
}

/**
 * Produces the canonical form, rejecting anything that cannot be represented
 * deterministically. Sorting the add-on ids means two callers who list the same
 * add-ons in different orders produce the same proposal — order is not
 * semantically meaningful here, so it must not cause hash divergence.
 */
export function normalizeProposal(
    input: AmendmentProposalInput
): GovernedOutcome<CanonicalAmendmentProposal> {
    let newStartTime: string | null = null;
    if (input.newStartTime !== undefined && input.newStartTime !== null) {
        const time = input.newStartTime;
        if (!(time instanceof Date) || Number.isNaN(time.getTime())) {
            return fail("INVALID_IDENTIFIER", "newStartTime is not a valid Date");
        }
        newStartTime = time.toISOString();
    }

    let newAddonIds: string[] | null = null;
    if (input.newAddonIds !== undefined && input.newAddonIds !== null) {
        const seen = new Set<string>();
        for (const addonId of input.newAddonIds) {
            if (!isUuid(addonId)) {
                return fail(
                    "INVALID_IDENTIFIER",
                    `newAddonIds entry ${JSON.stringify(addonId)} is not a valid UUID`
                );
            }
            seen.add(addonId.toLowerCase());
        }
        newAddonIds = [...seen].sort();
    }

    return succeed({ schema: AMENDMENT_PROPOSAL_SCHEMA, newStartTime, newAddonIds });
}

/**
 * Byte-stable serialization. Keys are emitted in a fixed order rather than
 * relying on object insertion order, so the hash cannot drift with refactoring.
 */
export function canonicalProposalJson(proposal: CanonicalAmendmentProposal): string {
    return JSON.stringify({
        schema: proposal.schema,
        newAddonIds: proposal.newAddonIds,
        newStartTime: proposal.newStartTime
    });
}

export function proposalHash(proposal: CanonicalAmendmentProposal): string {
    return createHash("sha256").update(canonicalProposalJson(proposal), "utf8").digest("hex");
}

export function proposalsEqual(
    a: CanonicalAmendmentProposal,
    b: CanonicalAmendmentProposal
): boolean {
    return canonicalProposalJson(a) === canonicalProposalJson(b);
}

/**
 * Reads a stored proposal back into its typed form. Returns a refusal rather
 * than a partially-trusted object if the persisted document is not the shape
 * this version knows how to interpret.
 */
export function parseStoredProposal(raw: unknown): GovernedOutcome<CanonicalAmendmentProposal> {
    if (typeof raw !== "object" || raw === null) {
        return fail("NOT_FOUND", "stored amendment proposal is not an object");
    }
    const candidate = raw as Record<string, unknown>;
    if (candidate["schema"] !== AMENDMENT_PROPOSAL_SCHEMA) {
        return fail(
            "NOT_FOUND",
            `stored amendment proposal has unsupported schema ${String(candidate["schema"])}`
        );
    }
    const startTime = candidate["newStartTime"];
    if (startTime !== null && typeof startTime !== "string") {
        return fail("NOT_FOUND", "stored amendment proposal has a malformed newStartTime");
    }
    const addonIds = candidate["newAddonIds"];
    if (addonIds !== null && !Array.isArray(addonIds)) {
        return fail("NOT_FOUND", "stored amendment proposal has a malformed newAddonIds");
    }
    return succeed({
        schema: AMENDMENT_PROPOSAL_SCHEMA,
        newStartTime: startTime,
        newAddonIds: addonIds === null ? null : (addonIds as string[])
    });
}

/** The proposal's start time as a Date, or null when it keeps the committed one. */
export function proposedStartDate(proposal: CanonicalAmendmentProposal): Date | null {
    return proposal.newStartTime === null ? null : new Date(proposal.newStartTime);
}
