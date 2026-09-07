// SCP-G5-D — customer demand-ingress refusal vocabulary.
//
// One closed set of reasons. Every refusal the ingress boundary can produce is
// named here, so a customer-facing surface can be exhaustive about what it
// explains and a reviewer can see the whole refusal surface in one place.
//
// These are INGRESS reasons. They are deliberately separate from Core's
// GovernedFailureCode: a boundary refusing malformed customer intent is a
// different act from Core refusing an illegal canonical transition, and
// collapsing the two would let a presentation concern reach into Core's
// vocabulary.

export const INGRESS_REASONS = [
    // --- contract shape -------------------------------------------------
    /** A field the intake contract does not declare was present. */
    "UNDECLARED_FIELD",
    /** A declared field is absent, empty or the wrong primitive type. */
    "FIELD_INVALID",

    // --- identity -------------------------------------------------------
    /** The caller asserted a tenant/market/environment that is not this runtime's. */
    "IDENTITY_MISMATCH",
    /** The caller asserted an environment that is not this runtime's. */
    "ENVIRONMENT_MISMATCH",

    // --- governed configuration ----------------------------------------
    /** Effective configuration could not be resolved. Ingress fails closed. */
    "CONFIGURATION_UNRESOLVED",
    /** The service code is unknown to the governing configuration. */
    "SERVICE_UNKNOWN",
    /** The service code is known but not active. */
    "SERVICE_INACTIVE",
    /** An extra code is unknown to the governing configuration. */
    "EXTRA_UNKNOWN",
    /** An extra code is known but not active. */
    "EXTRA_INACTIVE",
    /** The same extra was submitted more than once. */
    "EXTRA_DUPLICATED",
    /** The region is not in the governed coverage. */
    "REGION_UNSUPPORTED",
    /** The accommodation type is not in the governed customer context. */
    "ACCOMMODATION_UNSUPPORTED",
    /** The locale is not in the governed supported set. */
    "LOCALE_UNSUPPORTED",
    /** The configuration catalogue has not been projected into Core. */
    "CATALOGUE_NOT_PROJECTED",

    // --- governed operating policy --------------------------------------
    /** The requested date is not a real calendar date in the market timezone. */
    "REQUESTED_DATE_INVALID",
    /** The requested time is not HH:MM. */
    "REQUESTED_TIME_INVALID",
    /** The request starts before the governed opening time. */
    "OUTSIDE_OPERATING_HOURS",
    /** The service would still be running after the governed closing time. */
    "CLOSING_CEILING_EXCEEDED",
    /** The request is sooner than the governed minimum lead time. */
    "BOOKING_WINDOW_TOO_SOON",
    /** The request is further out than the governed maximum advance. */
    "BOOKING_WINDOW_TOO_FAR",

    // --- idempotency ----------------------------------------------------
    /** The key was used before for materially different intent. */
    "IDEMPOTENCY_KEY_CONFLICT",

    // --- canonical refusal ----------------------------------------------
    /** Core refused to create the canonical request. Its code is carried through. */
    "CANONICAL_REFUSAL"
] as const;

export type IngressReason = (typeof INGRESS_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(INGRESS_REASONS);

export function isIngressReason(value: unknown): value is IngressReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/**
 * HTTP status for a refusal. Kept beside the reason so the host has no
 * independent opinion about what a refusal means.
 */
export function ingressHttpStatus(reason: IngressReason): number {
    switch (reason) {
        case "IDENTITY_MISMATCH":
        case "ENVIRONMENT_MISMATCH":
            return 403;
        case "IDEMPOTENCY_KEY_CONFLICT":
            return 409;
        case "CONFIGURATION_UNRESOLVED":
        case "CATALOGUE_NOT_PROJECTED":
            return 503;
        default:
            return 422;
    }
}
