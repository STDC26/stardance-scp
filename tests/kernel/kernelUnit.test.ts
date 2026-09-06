// G3 unit proofs — invariants that hold without a database.

import { describe, expect, it } from "vitest";
import {
    KERNEL_DECISION_REASONS,
    ALTERNATIVE_WORTHY_REASONS,
    isKernelDecisionReason
} from "../../src/kernel/reasons";
import { offerRequestFingerprint } from "../../src/kernel/offer";
import {
    loadMarketConfig,
    marketSupportsTopology,
    assertValidMarketConfig,
    getActiveMarketConfig,
    type MarketId
} from "../../src/config/marketConfig";
import {
    CAPACITY_HOLD_STATE_ALIAS,
    BLOCKING_HOLD_STATES
} from "../../src/core/capacity/capacity";

const ALL_MARKETS: MarketId[] = ["bali", "bangkok", "saigon", "penang"];

describe("G3 — governed reason taxonomy", () => {
    it("covers every code the authorization requires as a minimum", () => {
        const required = [
            "SERVICE_NOT_ACTIVE",
            "SERVICE_NOT_AVAILABLE_IN_MARKET",
            "TOPOLOGY_NOT_SUPPORTED",
            "LOCATION_NOT_SERVICEABLE",
            "CUSTOMER_NOT_ELIGIBLE",
            "BUSINESS_CLOSED",
            "LOCATION_CLOSED",
            "OUTSIDE_BOOKABLE_WINDOW",
            "NO_ELIGIBLE_PROVIDER",
            "PROVIDER_UNAVAILABLE",
            "REQUIRED_RESOURCE_UNAVAILABLE",
            "CAPACITY_UNAVAILABLE",
            "CAPACITY_CONFLICT",
            "CAPACITY_HOLD_EXPIRED",
            "COMMERCIAL_RULE_NOT_SATISFIED",
            "PRICE_UNAVAILABLE",
            "OFFER_EXPIRED",
            "OFFER_SUPERSEDED",
            "OFFER_REVALIDATION_REQUIRED",
            "OFFER_NO_LONGER_VALID",
            "AUTHORITY_REFUSED",
            "MARKET_MISMATCH",
            "TENANT_MISMATCH",
            "INVALID_IDENTIFIER",
            "IDEMPOTENCY_CONFLICT"
        ];
        for (const code of required) {
            expect(KERNEL_DECISION_REASONS).toContain(code);
            expect(isKernelDecisionReason(code)).toBe(true);
        }
        expect(KERNEL_DECISION_REASONS).toHaveLength(25);
    });

    it("rejects anything outside the taxonomy", () => {
        for (const notACode of ["nope", "", "capacity_unavailable", null, 7]) {
            expect(isKernelDecisionReason(notACode)).toBe(false);
        }
    });

    it("only searches for alternatives where an alternative could exist", () => {
        // A capacity clash may clear at another time; "not sold here" will not.
        expect(ALTERNATIVE_WORTHY_REASONS.has("CAPACITY_UNAVAILABLE")).toBe(true);
        expect(ALTERNATIVE_WORTHY_REASONS.has("PROVIDER_UNAVAILABLE")).toBe(true);
        expect(ALTERNATIVE_WORTHY_REASONS.has("SERVICE_NOT_AVAILABLE_IN_MARKET")).toBe(false);
        expect(ALTERNATIVE_WORTHY_REASONS.has("TOPOLOGY_NOT_SUPPORTED")).toBe(false);
        expect(ALTERNATIVE_WORTHY_REASONS.has("AUTHORITY_REFUSED")).toBe(false);
    });
});

describe("G3 — capacity hold vocabulary", () => {
    it("maps the G2 names onto their canonical G3 equivalents", () => {
        expect(CAPACITY_HOLD_STATE_ALIAS["HELD"]).toBe("ACTIVE");
        expect(CAPACITY_HOLD_STATE_ALIAS["COMMITTED"]).toBe("CONSUMED");
    });

    it("treats every non-terminal state as occupying capacity", () => {
        expect([...BLOCKING_HOLD_STATES].sort()).toEqual(
            ["ACTIVE", "COMMITTED", "CONSUMED", "HELD"].sort()
        );
        for (const terminal of ["RELEASED", "EXPIRED", "INVALIDATED"]) {
            expect(BLOCKING_HOLD_STATES).not.toContain(terminal);
        }
    });
});

describe("G3 — configuration is the only source of market difference", () => {
    it("every registered market validates", () => {
        for (const marketId of ALL_MARKETS) {
            expect(() => assertValidMarketConfig(loadMarketConfig(marketId))).not.toThrow();
        }
    });

    it("declares tenant, topology, booking window and offer policy per market", () => {
        const bali = loadMarketConfig("bali");
        const saigon = loadMarketConfig("saigon");
        const penang = loadMarketConfig("penang");

        expect(bali.tenantId).toBe("freshline");
        expect(saigon.tenantId).toBe("northbeam");
        // Same tenant, different topology — the hybrid fixture isolates
        // topology neutrality from tenant separation.
        expect(penang.tenantId).toBe("freshline");

        expect(bali.topology.supported).toEqual(["MOBILE"]);
        expect(saigon.topology.supported).toEqual(["INSTORE"]);
        expect(penang.topology.supported).toContain("HYBRID");

        // No two markets share an offer or booking policy, so a Core constant
        // could not satisfy them all.
        const validity = ALL_MARKETS.map((m) => loadMarketConfig(m).offer.validityMinutes);
        expect(new Set(validity).size).toBeGreaterThan(1);
        const leads = ALL_MARKETS.map((m) => loadMarketConfig(m).bookingWindow.minLeadMinutes);
        expect(new Set(leads).size).toBeGreaterThan(1);
    });

    it("topology support fails closed", () => {
        const bali = loadMarketConfig("bali");
        expect(marketSupportsTopology(bali, "MOBILE")).toBe(true);
        expect(marketSupportsTopology(bali, "INSTORE")).toBe(false);

        const saigon = loadMarketConfig("saigon");
        expect(marketSupportsTopology(saigon, "INSTORE")).toBe(true);
        expect(marketSupportsTopology(saigon, "MOBILE")).toBe(false);

        // HYBRID permits both concrete topologies.
        const penang = loadMarketConfig("penang");
        expect(marketSupportsTopology(penang, "MOBILE")).toBe(true);
        expect(marketSupportsTopology(penang, "INSTORE")).toBe(true);
    });

    it("an unknown market is refused, never defaulted", () => {
        expect(() => getActiveMarketConfig({ ACTIVE_MARKET: "atlantis" })).toThrow();
    });

    it("no market carries another market's billing series", () => {
        const prefixes = ALL_MARKETS.map((m) => loadMarketConfig(m).billing.codePrefix);
        expect(new Set(prefixes).size).toBe(prefixes.length);
    });
});

describe("G3 — offer idempotency fingerprint", () => {
    const base = {
        marketId: "bali" as const,
        topology: "MOBILE" as const,
        serviceId: "8c41d0e7-52b9-4a63-b17f-9e6a3c208d54",
        customerIdentityId: "3f2a9c14-6b7d-4e58-9a01-2d5c8e7b4f31",
        requestedStart: new Date("2027-05-01T06:00:00.000Z"),
        serviceAreaKey: "SEMINYAK"
    };

    it("is stable for the same material request", () => {
        expect(offerRequestFingerprint(base, "freshline")).toBe(
            offerRequestFingerprint({ ...base }, "freshline")
        );
    });

    it("ignores add-on ordering and case, which are not semantically meaningful", () => {
        const a = offerRequestFingerprint(
            { ...base, addonIds: ["AAAAAAAA-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"] },
            "freshline"
        );
        const b = offerRequestFingerprint(
            { ...base, addonIds: ["bbbbbbbb-2222-2222-2222-222222222222", "aaaaaaaa-1111-1111-1111-111111111111"] },
            "freshline"
        );
        expect(a).toBe(b);
    });

    it("changes when anything material changes", () => {
        const original = offerRequestFingerprint(base, "freshline");
        expect(
            offerRequestFingerprint(
                { ...base, requestedStart: new Date("2027-05-01T07:00:00.000Z") },
                "freshline"
            )
        ).not.toBe(original);
        expect(offerRequestFingerprint(base, "northbeam")).not.toBe(original);
        expect(
            offerRequestFingerprint({ ...base, serviceAreaKey: "UBUD" }, "freshline")
        ).not.toBe(original);
        expect(
            offerRequestFingerprint({ ...base, addonIds: ["aaaaaaaa-1111-1111-1111-111111111111"] }, "freshline")
        ).not.toBe(original);
    });

    it("is not affected by client-asserted price or duration", () => {
        // Those values are recorded as provenance and never bind, so they must
        // not participate in offer identity either.
        const withClaims = offerRequestFingerprint(
            { ...base, clientAsserted: { priceMinorUnits: 1, durationMinutes: 5 } },
            "freshline"
        );
        expect(withClaims).toBe(offerRequestFingerprint(base, "freshline"));
    });
});
