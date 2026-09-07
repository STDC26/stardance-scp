// SCP-G5-F — Owner operating-boundary refusal vocabulary.
//
// One closed set for the refusals the OWNER SURFACE itself produces: contract
// shape, session authority, scope, and the Owner-process preconditions that
// have no canonical home elsewhere.
//
// Deliberately separate from LifecycleReason. When Core refuses an action —
// wrong predecessor state, stale context, unauthorized actor — that refusal is
// carried through verbatim as CANONICAL_REFUSAL with the lifecycle code
// attached, because a boundary that paraphrased Core's reasons would eventually
// paraphrase one of them wrongly.

export const OWNER_REASONS = [
    // --- contract shape -------------------------------------------------
    "UNDECLARED_FIELD",
    "FIELD_INVALID",

    // --- authority ------------------------------------------------------
    /** No session, an unknown token, or an expired/revoked one. */
    "SESSION_INVALID",
    /** A real session, but for another tenant/market/environment. */
    "SESSION_SCOPE_MISMATCH",
    /** A non-OWNER session attempted an Owner command. */
    "OWNER_AUTHORITY_REQUIRED",
    /** The named object belongs to a different tenant/market/environment. */
    "CROSS_SCOPE_REFUSED",

    // --- governed configuration ----------------------------------------
    "CONFIGURATION_UNRESOLVED",

    // --- Owner process --------------------------------------------------
    /** No such request in this scope. */
    "REQUEST_UNKNOWN",
    /** The Owner has not judged this request serviceable yet. */
    "NOT_QUALIFIED_FOR_MATCHING",
    /** The request was judged unserviceable or needs clarification. */
    "QUALIFICATION_BLOCKS_MATCHING",
    /** No provider satisfies strict eligibility for this request. */
    "NO_ELIGIBLE_MATCH",
    /** The named provider is not among the strictly eligible matches. */
    "PROVIDER_NOT_ELIGIBLE_MATCH",

    // --- idempotency ----------------------------------------------------
    "IDEMPOTENCY_KEY_CONFLICT",

    // --- canonical refusal ----------------------------------------------
    /** Core refused. Its lifecycle reason code is carried through unchanged. */
    "CANONICAL_REFUSAL"
] as const;

export type OwnerReason = (typeof OWNER_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(OWNER_REASONS);

export function isOwnerReason(value: unknown): value is OwnerReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/** HTTP status for a refusal, so the host holds no opinion of its own. */
export function ownerHttpStatus(reason: OwnerReason): number {
    switch (reason) {
        case "SESSION_INVALID":
            return 401;
        case "SESSION_SCOPE_MISMATCH":
        case "OWNER_AUTHORITY_REQUIRED":
        case "CROSS_SCOPE_REFUSED":
            return 403;
        case "REQUEST_UNKNOWN":
            return 404;
        case "IDEMPOTENCY_KEY_CONFLICT":
            return 409;
        case "CONFIGURATION_UNRESOLVED":
            return 503;
        default:
            return 422;
    }
}
