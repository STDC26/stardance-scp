// SCP Operational Lifecycle — governed reason taxonomy.
//
// Every refused OperationalAction carries one of these codes, and the refusal
// is persisted alongside accepted actions. A refusal without a code is a
// defect: an operator, an adapter and a test must all be able to act on the
// outcome without parsing prose.

export const LIFECYCLE_REASONS = [
    // Dispatch
    "DISPATCH_REJECTED",
    "DISPATCH_EXPIRED",
    "DISPATCH_SUPERSEDED",
    "STALE_DISPATCH_RESPONSE",
    "AMBIGUOUS_DISPATCH_RESPONSE",

    // Assignment
    "ASSIGNMENT_CONFLICT",
    "ASSIGNMENT_SUPERSEDED",
    "PROVIDER_NO_LONGER_ELIGIBLE",

    // Confirmation
    "CONFIRMATION_EXPIRED",
    "CONFIRMATION_SUPERSEDED",
    "STALE_CONFIRMATION",
    "CUSTOMER_DECLINED",

    // Capacity / execution
    "PROVIDER_CAPACITY_LOST",
    "RESOURCE_CAPACITY_LOST",
    "LOCATION_UNAVAILABLE",
    "EXECUTION_CONSTRAINT_FAILED",

    // Termination
    "CUSTOMER_CANCELLED",
    "OWNER_CANCELLED",
    "POLICY_CANCELLED",
    "CUSTOMER_NO_SHOW",
    "PROVIDER_NO_SHOW",
    "UNABLE_TO_RECOVER",
    "SERVICE_COMPLETED_NORMALLY",

    // Envelope / orchestration
    "IDEMPOTENCY_CONFLICT",
    "AUTHORITY_REFUSED",
    "INVALID_PREDECESSOR_STATE",
    "STALE_OPERATIONAL_CONTEXT",
    "CORRELATION_REQUIRED",
    "AMBIGUOUS_ACTION"
] as const;

export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(LIFECYCLE_REASONS);

export function isLifecycleReason(value: unknown): value is LifecycleReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/** Reasons that describe losing a race rather than being wrong. */
export const CONTENTION_REASONS: ReadonlySet<LifecycleReason> = new Set([
    "ASSIGNMENT_CONFLICT",
    "ASSIGNMENT_SUPERSEDED",
    "INVALID_PREDECESSOR_STATE",
    "STALE_OPERATIONAL_CONTEXT",
    "DISPATCH_SUPERSEDED",
    "STALE_DISPATCH_RESPONSE"
]);
