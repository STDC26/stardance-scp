// SCP Service-Commerce Kernel — governed decision reason taxonomy.
//
// Every kernel refusal is one of these codes. They are machine-readable by
// construction: an adapter, an operator console or a test asserts on the code,
// never on prose. A refusal without a code is a defect, not a "generic no".

export const KERNEL_DECISION_REASONS = [
    // Scope / addressing
    "TENANT_MISMATCH",
    "MARKET_MISMATCH",
    "INVALID_IDENTIFIER",
    "AUTHORITY_REFUSED",
    "IDEMPOTENCY_CONFLICT",

    // Service and topology eligibility
    "SERVICE_NOT_ACTIVE",
    "SERVICE_NOT_AVAILABLE_IN_MARKET",
    "TOPOLOGY_NOT_SUPPORTED",
    "LOCATION_NOT_SERVICEABLE",
    "CUSTOMER_NOT_ELIGIBLE",

    // Operating policy
    "BUSINESS_CLOSED",
    "LOCATION_CLOSED",
    "OUTSIDE_BOOKABLE_WINDOW",

    // Supply
    "NO_ELIGIBLE_PROVIDER",
    "PROVIDER_UNAVAILABLE",
    "REQUIRED_RESOURCE_UNAVAILABLE",

    // Capacity
    "CAPACITY_UNAVAILABLE",
    "CAPACITY_CONFLICT",
    "CAPACITY_HOLD_EXPIRED",

    // Commercial
    "COMMERCIAL_RULE_NOT_SATISFIED",
    "PRICE_UNAVAILABLE",

    // Offer lifecycle
    "OFFER_EXPIRED",
    "OFFER_SUPERSEDED",
    "OFFER_REVALIDATION_REQUIRED",
    "OFFER_NO_LONGER_VALID"
] as const;

export type KernelDecisionReason = (typeof KERNEL_DECISION_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(KERNEL_DECISION_REASONS);

export function isKernelDecisionReason(value: unknown): value is KernelDecisionReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/**
 * Reasons for which a bounded deterministic alternative search is worthwhile.
 * A service that is simply not sold here will not become sellable at 3pm, so
 * offering alternatives for it would be noise rather than help.
 */
export const ALTERNATIVE_WORTHY_REASONS: ReadonlySet<KernelDecisionReason> = new Set([
    "PROVIDER_UNAVAILABLE",
    "NO_ELIGIBLE_PROVIDER",
    "REQUIRED_RESOURCE_UNAVAILABLE",
    "CAPACITY_UNAVAILABLE",
    "CAPACITY_CONFLICT",
    "LOCATION_CLOSED",
    "BUSINESS_CLOSED"
]);
