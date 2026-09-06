// G4-E02 Transition Legality · G4-E09 Idempotency (pure parts).
// No database.

import { describe, expect, it } from "vitest";
import { LIFECYCLE_REASONS, isLifecycleReason } from "../../src/lifecycle/reasons";
import {
    OPERATIONAL_ACTION_TYPES,
    actionFingerprint,
    isOperationalActionType
} from "../../src/lifecycle/actions";
import { isLegalTransition, isTerminal } from "../../src/core/request/serviceRequest";
import { readOperationalIntent } from "../../src/adapters/channel/operationalChannel";
import type { ServiceRequestState } from "../../src/core/types";

const FROZEN_STATES: ServiceRequestState[] = [
    "PENDING_ACCEPTANCE",
    "PROVIDER_DISPATCHED",
    "PROVIDER_ACCEPTED",
    "OWNER_ASSIGNED",
    "AWAITING_CUSTOMER_CONFIRMATION",
    "CUSTOMER_CONFIRMED",
    "FULFILLMENT_ACTIVE",
    "SERVICE_COMPLETED",
    "CANCELLED",
    "NO_SHOW",
    "UNABLE_TO_FULFILL"
];

const SUCCESSFUL_PATH: ServiceRequestState[] = [
    "PENDING_ACCEPTANCE",
    "PROVIDER_DISPATCHED",
    "PROVIDER_ACCEPTED",
    "OWNER_ASSIGNED",
    "AWAITING_CUSTOMER_CONFIRMATION",
    "CUSTOMER_CONFIRMED",
    "FULFILLMENT_ACTIVE",
    "SERVICE_COMPLETED"
];

describe("G4-E02 — the frozen lifecycle is executable", () => {
    it("every step of the successful path is a legal transition", () => {
        for (let i = 0; i < SUCCESSFUL_PATH.length - 1; i++) {
            expect(isLegalTransition(SUCCESSFUL_PATH[i]!, SUCCESSFUL_PATH[i + 1]!)).toBe(true);
        }
    });

    it("the four terminal states are terminal", () => {
        for (const terminal of [
            "SERVICE_COMPLETED",
            "CANCELLED",
            "NO_SHOW",
            "UNABLE_TO_FULFILL"
        ] as const) {
            expect(isTerminal(terminal)).toBe(true);
            for (const target of FROZEN_STATES) {
                expect(isLegalTransition(terminal, target)).toBe(false);
            }
        }
    });

    it("the authority gates cannot be skipped", () => {
        // Acceptance is not assignment.
        expect(isLegalTransition("PROVIDER_ACCEPTED", "AWAITING_CUSTOMER_CONFIRMATION")).toBe(false);
        expect(isLegalTransition("PROVIDER_ACCEPTED", "CUSTOMER_CONFIRMED")).toBe(false);
        // Assignment is not confirmation.
        expect(isLegalTransition("OWNER_ASSIGNED", "CUSTOMER_CONFIRMED")).toBe(false);
        // Confirmation is not fulfillment start... it is the only door to it,
        // but dispatch cannot jump straight there.
        expect(isLegalTransition("PROVIDER_DISPATCHED", "FULFILLMENT_ACTIVE")).toBe(false);
        // Fulfillment start is not completion.
        expect(isLegalTransition("CUSTOMER_CONFIRMED", "SERVICE_COMPLETED")).toBe(false);
    });

    it("a no-show is reachable from a confirmed booking that never started", () => {
        expect(isLegalTransition("CUSTOMER_CONFIRMED", "NO_SHOW")).toBe(true);
        expect(isLegalTransition("FULFILLMENT_ACTIVE", "NO_SHOW")).toBe(true);
        // But not from an unconfirmed one.
        expect(isLegalTransition("OWNER_ASSIGNED", "NO_SHOW")).toBe(false);
        expect(isLegalTransition("PENDING_ACCEPTANCE", "NO_SHOW")).toBe(false);
    });

    it("dispatch rejection and expiry both return to the pool", () => {
        expect(isLegalTransition("PROVIDER_DISPATCHED", "PENDING_ACCEPTANCE")).toBe(true);
    });
});

describe("G4 — taxonomies are complete", () => {
    it("carries every reason the authorization requires as a minimum", () => {
        const required = [
            "DISPATCH_REJECTED",
            "DISPATCH_EXPIRED",
            "DISPATCH_SUPERSEDED",
            "STALE_DISPATCH_RESPONSE",
            "AMBIGUOUS_DISPATCH_RESPONSE",
            "ASSIGNMENT_CONFLICT",
            "ASSIGNMENT_SUPERSEDED",
            "PROVIDER_NO_LONGER_ELIGIBLE",
            "CONFIRMATION_EXPIRED",
            "CONFIRMATION_SUPERSEDED",
            "STALE_CONFIRMATION",
            "CUSTOMER_DECLINED",
            "PROVIDER_CAPACITY_LOST",
            "RESOURCE_CAPACITY_LOST",
            "LOCATION_UNAVAILABLE",
            "EXECUTION_CONSTRAINT_FAILED",
            "CUSTOMER_CANCELLED",
            "OWNER_CANCELLED",
            "POLICY_CANCELLED",
            "CUSTOMER_NO_SHOW",
            "PROVIDER_NO_SHOW",
            "UNABLE_TO_RECOVER",
            "SERVICE_COMPLETED_NORMALLY",
            "IDEMPOTENCY_CONFLICT",
            "AUTHORITY_REFUSED",
            "INVALID_PREDECESSOR_STATE",
            "STALE_OPERATIONAL_CONTEXT",
            "CORRELATION_REQUIRED",
            "AMBIGUOUS_ACTION"
        ];
        for (const code of required) {
            expect(LIFECYCLE_REASONS).toContain(code);
            expect(isLifecycleReason(code)).toBe(true);
        }
        expect(LIFECYCLE_REASONS).toHaveLength(29);
    });

    it("carries the full canonical action taxonomy", () => {
        const required = [
            "DISPATCH_PROVIDER",
            "EXPIRE_DISPATCH",
            "RECORD_PROVIDER_ACCEPTANCE",
            "RECORD_PROVIDER_REJECTION",
            "ASSIGN_PROVIDER",
            "REASSIGN_PROVIDER",
            "REQUEST_CUSTOMER_CONFIRMATION",
            "RECORD_CUSTOMER_CONFIRMATION",
            "START_FULFILLMENT",
            "COMPLETE_SERVICE",
            "CANCEL_SERVICE",
            "MARK_NO_SHOW",
            "MARK_UNABLE_TO_FULFILL",
            "RECORD_CAPACITY_LOSS",
            "INITIATE_OPERATIONAL_RECOVERY"
        ];
        for (const action of required) {
            expect(OPERATIONAL_ACTION_TYPES).toContain(action);
            expect(isOperationalActionType(action)).toBe(true);
        }
        expect(OPERATIONAL_ACTION_TYPES).toHaveLength(15);
    });

    it("rejects anything outside the taxonomies", () => {
        expect(isLifecycleReason("NOPE")).toBe(false);
        expect(isOperationalActionType("DELETE_EVERYTHING")).toBe(false);
        expect(isOperationalActionType(null)).toBe(false);
    });
});

describe("G4-E09 — action fingerprint", () => {
    const base = {
        tenantId: "freshline",
        marketId: "bali",
        requestId: "3f2a9c14-6b7d-4e58-9a01-2d5c8e7b4f31",
        actionType: "DISPATCH_PROVIDER" as const,
        actorIdentityId: "8c41d0e7-52b9-4a63-b17f-9e6a3c208d54",
        payload: { providerId: "11111111-2222-3333-4444-555555555555" }
    };

    it("is stable for the same logical request", () => {
        expect(actionFingerprint(base)).toBe(actionFingerprint({ ...base }));
    });

    it("ignores payload key ordering, which is not semantically meaningful", () => {
        const a = actionFingerprint({ ...base, payload: { x: 1, y: 2 } });
        const b = actionFingerprint({ ...base, payload: { y: 2, x: 1 } });
        expect(a).toBe(b);
    });

    it("changes when anything material changes", () => {
        const original = actionFingerprint(base);
        expect(actionFingerprint({ ...base, tenantId: "northbeam" })).not.toBe(original);
        expect(actionFingerprint({ ...base, actionType: "CANCEL_SERVICE" })).not.toBe(original);
        expect(actionFingerprint({ ...base, actorIdentityId: null })).not.toBe(original);
        expect(
            actionFingerprint({ ...base, payload: { providerId: "99999999-2222-3333-4444-555555555555" } })
        ).not.toBe(original);
        expect(
            actionFingerprint({ ...base, requestId: "11111111-1111-1111-1111-111111111111" })
        ).not.toBe(original);
    });
});

describe("G4-E10 — channel intent is never a canonical state", () => {
    it("reads exactly one unambiguous intent, or none", () => {
        expect(readOperationalIntent("accept")).toBe("RECORD_PROVIDER_ACCEPTANCE");
        expect(readOperationalIntent("I decline")).toBe("RECORD_PROVIDER_REJECTION");
        expect(readOperationalIntent("confirmed")).toBe("RECORD_CUSTOMER_CONFIRMATION");
        expect(readOperationalIntent("please cancel")).toBe("CANCEL_SERVICE");
    });

    it("returns nothing for competing or absent tokens", () => {
        expect(readOperationalIntent("accept then cancel")).toBeNull();
        expect(readOperationalIntent("accept or decline?")).toBeNull();
        expect(readOperationalIntent("ok sure sounds good")).toBeNull();
        expect(readOperationalIntent("")).toBeNull();
        expect(readOperationalIntent("acccept")).toBeNull();
    });
});
