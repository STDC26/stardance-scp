// SCP Core Foundation — canonical shared types.
//
// PLATFORM RULE: one domain concept, one authoritative owner. These types are
// the vocabulary; the owning module for each concept is named in the comment.

/** Owner: db/migrations/002 `service_request_state`. */
export type ServiceRequestState =
    | "PENDING_ACCEPTANCE"
    | "PROVIDER_DISPATCHED"
    | "PROVIDER_ACCEPTED"
    | "OWNER_ASSIGNED"
    | "AWAITING_CUSTOMER_CONFIRMATION"
    | "CUSTOMER_CONFIRMED"
    | "FULFILLMENT_ACTIVE"
    | "SERVICE_COMPLETED"
    | "CANCELLED"
    | "NO_SHOW"
    | "UNABLE_TO_FULFILL";

export type AmendmentState =
    | "PROPOSED"
    | "VALIDATING"
    | "REQUIRES_RECONFIRMATION"
    | "APPLIED"
    | "REJECTED"
    | "WITHDRAWN";

export type DispatchOfferState = "OFFERED" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN";

export type CapacityHoldState = "HELD" | "COMMITTED" | "RELEASED";

export type FulfillmentResultValue = "SERVICE_COMPLETED" | "NO_SHOW" | "UNABLE_TO_FULFILL";

export type ScpRole = "OWNER" | "PROVIDER" | "CUSTOMER" | "SYSTEM";

export type ProviderSupplyStatus = "SUBMITTED" | "APPROVED" | "SUSPENDED" | "WITHDRAWN";

/**
 * Migration alias map. LEGACY_STATE_MAPPING from the G2 authorization, made
 * executable so the mapping is one lookup rather than scattered assumptions.
 * The G1 `appointments` surface is NOT canonical — this exists to translate
 * migration-era vocabulary, not to grant it authority.
 */
export const LEGACY_STATE_ALIAS: Readonly<Record<string, ServiceRequestState>> = Object.freeze({
    CONTRACTOR_DISPATCHED: "PROVIDER_DISPATCHED",
    CONTRACTOR_ACCEPTED: "PROVIDER_ACCEPTED",
    PENDING_ACCEPTANCE: "PENDING_ACCEPTANCE",
    CANCELLED: "CANCELLED"
});

/**
 * Legacy values that must NOT be mapped onto a canonical state, with the reason.
 * Consulted by tests so the prohibition is executable, not just documented.
 */
export const LEGACY_STATE_PROHIBITED: Readonly<Record<string, string>> = Object.freeze({
    CONTRACTOR_DECLINED:
        "Provider decline is a Dispatch Offer outcome that releases the request to PENDING_ACCEPTANCE; it is never a top-level Service Request state.",
    CONFIRMED:
        "Ambiguous. Decomposes into OWNER_ASSIGNED / AWAITING_CUSTOMER_CONFIRMATION / CUSTOMER_CONFIRMED.",
    EXPIRED_REVERTED:
        "Recovery history semantics only; recorded in core_event, never an enduring Service Request state."
});

export type GovernedFailureCode =
    | "INVALID_IDENTIFIER"
    | "NOT_FOUND"
    | "STALE_STATE"
    | "UNAUTHORIZED"
    | "OFFER_EXPIRED"
    | "OFFER_NOT_CURRENT"
    | "OFFER_ALREADY_DECIDED"
    | "CAPACITY_CONFLICT"
    | "PROVIDER_NOT_APPROVED"
    | "INVALID_TRANSITION"
    | "AMENDMENT_IN_FLIGHT"
    | "RECONFIRMATION_REQUIRED"
    | "MARKET_UNKNOWN"
    | "COGNITION_NOT_BINDING";

/**
 * Every governed command returns this. Domain refusals are values, never
 * exceptions — a raw database error escaping a command is the defect class
 * G1R-R01 was raised for.
 */
export type GovernedOutcome<T> =
    | { ok: true; value: T }
    | { ok: false; code: GovernedFailureCode; message: string };

export function fail<T>(code: GovernedFailureCode, message: string): GovernedOutcome<T> {
    return { ok: false, code, message };
}

export function succeed<T>(value: T): GovernedOutcome<T> {
    return { ok: true, value };
}

/**
 * Who is acting and how their authority was established. `authority` is written
 * verbatim into the audit trail so a reviewer can see *why* the actor was
 * permitted, not merely that they acted.
 */
export interface Actor {
    identityId: string | null;
    role: ScpRole;
    authority: string;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({
    identityId: null,
    role: "SYSTEM" as const,
    authority: "SYSTEM_SWEEP"
});
