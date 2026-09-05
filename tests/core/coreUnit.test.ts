// G2 unit proof — invariants that hold without a database.

import { describe, expect, it } from "vitest";
import { isUuid, requireUuid, requireUuids } from "../../src/core/identifiers";
import { isLegalTransition, isTerminal } from "../../src/core/request/serviceRequest";
import { composeDuration } from "../../src/core/catalogue/catalogue";
import { LEGACY_STATE_ALIAS, LEGACY_STATE_PROHIBITED } from "../../src/core/types";
import { explicitDecisionToken } from "../../src/core/dispatch/inboundDecision";

describe("G2-E09 — governed identifier validation (closes G1R-R01)", () => {
    it("accepts a well-formed UUID", () => {
        expect(isUuid("8c41d0e7-52b9-4a63-b17f-9e6a3c208d54")).toBe(true);
    });

    it("rejects the malformed identities that previously reached Postgres", () => {
        for (const bad of ["contractor-race", "appointment-1", "", "not-a-uuid", "12345"]) {
            expect(isUuid(bad)).toBe(false);
        }
    });

    it("rejects non-string identifiers without throwing", () => {
        for (const bad of [null, undefined, 42, {}, []]) {
            expect(isUuid(bad)).toBe(false);
        }
    });

    it("returns a governed refusal naming the field, never an exception", () => {
        const outcome = requireUuid("appointmentId", "appointment-1");
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.code).toBe("INVALID_IDENTIFIER");
            expect(outcome.message).toContain("appointmentId");
        }
    });

    it("reports the first bad field when several are validated together", () => {
        const outcome = requireUuids({
            requestId: "8c41d0e7-52b9-4a63-b17f-9e6a3c208d54",
            providerId: "nope"
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.message).toContain("providerId");
        }
    });
});

describe("G2-E08 — canonical Service Request state machine", () => {
    it("keeps provider acceptance, owner assignment and customer confirmation distinct", () => {
        // Acceptance cannot jump the assignment gate.
        expect(isLegalTransition("PROVIDER_ACCEPTED", "AWAITING_CUSTOMER_CONFIRMATION")).toBe(false);
        expect(isLegalTransition("PROVIDER_ACCEPTED", "CUSTOMER_CONFIRMED")).toBe(false);
        // Assignment cannot confirm on the customer's behalf.
        expect(isLegalTransition("OWNER_ASSIGNED", "CUSTOMER_CONFIRMED")).toBe(false);
        // The sanctioned ladder.
        expect(isLegalTransition("PROVIDER_DISPATCHED", "PROVIDER_ACCEPTED")).toBe(true);
        expect(isLegalTransition("PROVIDER_ACCEPTED", "OWNER_ASSIGNED")).toBe(true);
        expect(isLegalTransition("OWNER_ASSIGNED", "AWAITING_CUSTOMER_CONFIRMATION")).toBe(true);
        expect(isLegalTransition("AWAITING_CUSTOMER_CONFIRMATION", "CUSTOMER_CONFIRMED")).toBe(true);
    });

    it("routes a decline back to the dispatch pool", () => {
        expect(isLegalTransition("PROVIDER_DISPATCHED", "PENDING_ACCEPTANCE")).toBe(true);
    });

    it("treats fulfilment outcomes as terminal", () => {
        for (const terminal of ["SERVICE_COMPLETED", "NO_SHOW", "UNABLE_TO_FULFILL", "CANCELLED"] as const) {
            expect(isTerminal(terminal)).toBe(true);
        }
        expect(isTerminal("FULFILLMENT_ACTIVE")).toBe(false);
    });

    it("allows an adopted amendment to reopen customer confirmation", () => {
        expect(isLegalTransition("CUSTOMER_CONFIRMED", "AWAITING_CUSTOMER_CONFIRMATION")).toBe(true);
    });
});

describe("G2-E08 — legacy state mapping", () => {
    it("maps migration-era dispatch/acceptance vocabulary onto canonical states", () => {
        expect(LEGACY_STATE_ALIAS["CONTRACTOR_DISPATCHED"]).toBe("PROVIDER_DISPATCHED");
        expect(LEGACY_STATE_ALIAS["CONTRACTOR_ACCEPTED"]).toBe("PROVIDER_ACCEPTED");
    });

    it("refuses to map the prohibited legacy values onto any canonical state", () => {
        for (const prohibited of ["CONTRACTOR_DECLINED", "CONFIRMED", "EXPIRED_REVERTED"]) {
            expect(LEGACY_STATE_ALIAS[prohibited]).toBeUndefined();
            expect(LEGACY_STATE_PROHIBITED[prohibited]).toBeTruthy();
        }
    });

    it("never exposes a declined value as a canonical Service Request state", () => {
        const canonical = Object.values(LEGACY_STATE_ALIAS);
        expect(canonical.some((s) => /DECLINED/.test(s))).toBe(false);
    });
});

describe("G2-E06 — duration composition", () => {
    it("is base + add-ons + buffer", () => {
        expect(composeDuration(60, 15, 10)).toBe(85);
    });

    it("includes the buffer because the buffer consumes exclusive capacity", () => {
        expect(composeDuration(60, 0, 10)).toBe(70);
        expect(composeDuration(60, 0, 0)).toBe(60);
    });
});

describe("G2-E12 — explicit decision token extraction", () => {
    it("reads an unambiguous accept or decline", () => {
        expect(explicitDecisionToken("I accept")).toBe("ACCEPT");
        expect(explicitDecisionToken("sorry, decline")).toBe("DECLINE");
    });

    it("returns null for both-tokens and no-token text rather than guessing", () => {
        expect(explicitDecisionToken("I accept — no wait, I decline")).toBeNull();
        expect(explicitDecisionToken("ok sure sounds good")).toBeNull();
        expect(explicitDecisionToken("accpet")).toBeNull();
    });
});
