// G2-E02 / G2-E03 — Tenant/Market configuration ownership and consumption.
//
// The point of this suite is the distinction the G8 smoke proof demands:
// loading JSON is not consumption. Each assertion below shows a *behavioral*
// difference between Bali and the synthetic Bangkok market produced by
// configuration alone, with no source fork and no per-market code path.

import { describe, expect, it } from "vitest";
import { getActiveMarketConfig, loadMarketConfig } from "../../src/config/marketConfig";
import {
    billingCodeMatcher,
    extractBillingCode,
    normalizeWhatsAppMessage
} from "../../src/adapters/channel/whatsappChannelAdapter";

describe("G2-E02 — configuration is the single ownership point", () => {
    it("resolves each market's own parameters", () => {
        const bali = loadMarketConfig("bali");
        const bangkok = loadMarketConfig("bangkok");
        expect(bali.timezone).toBe("Asia/Makassar");
        expect(bangkok.timezone).toBe("Asia/Bangkok");
        expect(bali.currency.code).toBe("IDR");
        expect(bangkok.currency.code).toBe("THB");
    });

    it("fails closed on an unknown market instead of falling back", () => {
        expect(() => getActiveMarketConfig({ ACTIVE_MARKET: "singapore" })).toThrow();
        expect(() => getActiveMarketConfig({ ACTIVE_MARKET: "" })).toThrow();
    });

    it("never lets one market read another's values", () => {
        const bali = loadMarketConfig("bali");
        const bangkok = loadMarketConfig("bangkok");
        expect(bali.billing.codePrefix).not.toBe(bangkok.billing.codePrefix);
        expect(bali.dispatch.acceptanceTimeoutMinutes).not.toBe(
            bangkok.dispatch.acceptanceTimeoutMinutes
        );
    });
});

describe("G2-E03 — synthetic second market changes behavior with no source fork", () => {
    it("compiles a different billing matcher per market from configuration", () => {
        expect(billingCodeMatcher("bali").source).toContain("FL-");
        expect(billingCodeMatcher("bangkok").source).toContain("BKK-");
    });

    it("extracts each market's own billing series", () => {
        expect(extractBillingCode("bali", "please accept FL-482913-Q7X2")).toBe("FL-482913-Q7X2");
        expect(extractBillingCode("bangkok", "please accept BKK-482913-Q7X2")).toBe(
            "BKK-482913-Q7X2"
        );
    });

    it("does not recognise the other market's series — the Freshline shape is not universal", () => {
        // This is the assertion that proves FL- is no longer Core truth: the
        // exact same code path rejects it when the active market says otherwise.
        expect(extractBillingCode("bangkok", "accept FL-482913-Q7X2")).toBeNull();
        expect(extractBillingCode("bali", "accept BKK-482913-Q7X2")).toBeNull();
    });

    it("normalizes an inbound message per market through one shared code path", () => {
        const baliMsg = normalizeWhatsAppMessage("bali", "+6281000", "accept FL-482913-Q7X2");
        const bkkMsg = normalizeWhatsAppMessage("bangkok", "+6681000", "accept BKK-482913-Q7X2");
        expect(baliMsg.claimedBillingCode).toBe("FL-482913-Q7X2");
        expect(bkkMsg.claimedBillingCode).toBe("BKK-482913-Q7X2");
        expect(baliMsg.claimedIntent).toBe("PROVIDER_ACCEPTANCE_INTENT");
        expect(bkkMsg.claimedIntent).toBe("PROVIDER_ACCEPTANCE_INTENT");
    });

    it("strips emoji and whitespace noise before extraction, in either market", () => {
        const msg = normalizeWhatsAppMessage("bali", "+6281000", "👍 ok I accept 🙏 FL-482913-Q7X2 ✅");
        expect(msg.claimedBillingCode).toBe("FL-482913-Q7X2");
    });
});

describe("G2-E12 — adapter produces claims, never authority", () => {
    it("marks ambiguous text for review rather than resolving it", () => {
        const msg = normalizeWhatsAppMessage(
            "bali",
            "+6281000",
            "I accept — wait no, I need to decline. FL-482913-Q7X2"
        );
        expect(msg.claimedIntent).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    });

    it("carries no offer correlation unless the channel supplied one", () => {
        const msg = normalizeWhatsAppMessage("bali", "+6281000", "accept FL-482913-Q7X2");
        expect(msg.correlatedOfferId).toBeNull();
    });

    it("classifies capacity exceptions and change requests distinctly", () => {
        expect(
            normalizeWhatsAppMessage("bali", "+62", "I am sick today").claimedIntent
        ).toBe("PROVIDER_CAPACITY_EXCEPTION");
        expect(
            normalizeWhatsAppMessage("bali", "+62", "can we reschedule this").claimedIntent
        ).toBe("CUSTOMER_CHANGE_REQUEST");
    });
});
