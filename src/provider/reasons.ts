// SCP-G5-E — provider supply-ingress refusal vocabulary.
//
// One closed set. Every refusal the provider boundary can produce is named here,
// so the Partner surface can be exhaustive about what it explains and a reviewer
// can see the whole refusal surface at once.
//
// Deliberately separate from Core's GovernedFailureCode: a boundary refusing a
// malformed provider submission is a different act from Core refusing an illegal
// canonical transition, and collapsing the two would let a presentation concern
// reach into Core's vocabulary.

export const PROVIDER_REASONS = [
    // --- contract shape -------------------------------------------------
    /** A field the contract does not declare was present. */
    "UNDECLARED_FIELD",
    /** A declared field is absent, empty or the wrong primitive type. */
    "FIELD_INVALID",

    // --- authority ------------------------------------------------------
    /** No session, an unknown token, or an expired/revoked one. */
    "SESSION_INVALID",
    /** The session is real but belongs to another tenant/market/environment. */
    "SESSION_SCOPE_MISMATCH",
    /** The caller asserted a context that is not this runtime's. */
    "IDENTITY_MISMATCH",
    /** A PROVIDER session attempted an Owner-only command. */
    "OWNER_AUTHORITY_REQUIRED",
    /** The session holder is not the provider the command names. */
    "NOT_PROVIDER_OWNER_OF_RECORD",
    /** The named provider belongs to a different tenant/market/environment. */
    "CROSS_TENANT_REFUSED",

    // --- governed configuration ----------------------------------------
    /** Effective configuration could not be resolved. Ingress fails closed. */
    "CONFIGURATION_UNRESOLVED",
    /** The role code is not in the tenant's governed prefix map. */
    "ROLE_CODE_UNSUPPORTED",
    /** A declared service code is unknown to the governing configuration. */
    "SERVICE_CODE_UNKNOWN",
    /** A declared service code is known but not active. */
    "SERVICE_CODE_INACTIVE",
    /** A declared region is not in the governed coverage. */
    "REGION_UNSUPPORTED",
    /** The governed catalogue has not been projected into Core. */
    "CATALOGUE_NOT_PROJECTED",
    /** Governed service areas have not been projected into Core. */
    "SERVICE_AREAS_NOT_PROJECTED",
    /** The locale is not in the governed supported set. */
    "LOCALE_UNSUPPORTED",

    // --- provider state -------------------------------------------------
    /** No profile has been submitted for this provider yet. */
    "PROFILE_NOT_SUBMITTED",
    /** A card is already awaiting Owner review. */
    "CARD_ALREADY_OPEN",
    /** The named card is not awaiting a decision. */
    "CARD_NOT_OPEN",
    /** The provider has no approved card, so it holds no supply authority. */
    "CARD_NOT_APPROVED",
    /** The named availability version does not exist in this scope. */
    "AVAILABILITY_VERSION_UNKNOWN",
    /** The named availability version is not awaiting confirmation. */
    "AVAILABILITY_NOT_SUBMITTED",
    /** A confirmation was attempted against a superseded version. */
    "AVAILABILITY_SUPERSEDED",

    // --- schedule shape -------------------------------------------------
    /** The week does not start on a Monday, or is not a real date. */
    "WEEK_START_INVALID",
    /** The seven-day schedule is not exactly seven distinct ISO days. */
    "SCHEDULE_SHAPE_INVALID",
    /** A day states an end at or before its start. */
    "DAY_TIME_ORDER_INVALID",
    /** A day falls outside the governed operating hours. */
    "DAY_OUTSIDE_OPERATING_HOURS",

    // --- media ----------------------------------------------------------
    /** The portrait is not one of the accepted image types. */
    "MEDIA_TYPE_UNSUPPORTED",
    /** The portrait exceeds the accepted size. */
    "MEDIA_TOO_LARGE",
    /** The named media object does not belong to this provider. */
    "MEDIA_NOT_FOUND",

    // --- idempotency ----------------------------------------------------
    /** The key was used before for materially different intent. */
    "IDEMPOTENCY_KEY_CONFLICT",

    // --- canonical refusal ----------------------------------------------
    /** Core refused the command. Its code is carried through. */
    "CANONICAL_REFUSAL"
] as const;

export type ProviderReason = (typeof PROVIDER_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(PROVIDER_REASONS);

export function isProviderReason(value: unknown): value is ProviderReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/**
 * HTTP status for a refusal. Kept beside the reason so the host has no
 * independent opinion about what a refusal means.
 */
export function providerHttpStatus(reason: ProviderReason): number {
    switch (reason) {
        case "SESSION_INVALID":
            return 401;
        case "SESSION_SCOPE_MISMATCH":
        case "IDENTITY_MISMATCH":
        case "OWNER_AUTHORITY_REQUIRED":
        case "NOT_PROVIDER_OWNER_OF_RECORD":
        case "CROSS_TENANT_REFUSED":
            return 403;
        case "IDEMPOTENCY_KEY_CONFLICT":
        case "CARD_ALREADY_OPEN":
        case "AVAILABILITY_SUPERSEDED":
            return 409;
        case "MEDIA_TOO_LARGE":
            return 413;
        case "CONFIGURATION_UNRESOLVED":
        case "CATALOGUE_NOT_PROJECTED":
        case "SERVICE_AREAS_NOT_PROJECTED":
            return 503;
        default:
            return 422;
    }
}
