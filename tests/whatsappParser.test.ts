// Part C — REQ-WHATSAPP-PARSER-02 stress check: dirty text (emojis, leading
// spaces, lowercase), and the critical trap — a typo must NEVER be
// auto-corrected into an executed state mutation.

import { describe, expect, it } from "vitest";
import { parseWhatsAppMessage } from "../src/services/whatsappParser";

describe("parseWhatsAppMessage — happy path", () => {
    it("parses a clean ACCEPT message", () => {
        const result = parseWhatsAppMessage("Accept FL-482913-Q7X2");
        expect(result.billingCode).toBe("FL-482913-Q7X2");
        expect(result.intent).toBe("ACCEPT");
        expect(result.routing).toBe("MATCHED");
    });

    it("parses a clean DECLINE message", () => {
        const result = parseWhatsAppMessage("Decline FL-118820-AB3Z");
        expect(result.billingCode).toBe("FL-118820-AB3Z");
        expect(result.intent).toBe("DECLINE");
        expect(result.routing).toBe("MATCHED");
    });
});

describe("parseWhatsAppMessage — dirty text tolerance", () => {
    it("handles leading/trailing whitespace", () => {
        const result = parseWhatsAppMessage("   accept FL-482913-Q7X2   ");
        expect(result.billingCode).toBe("FL-482913-Q7X2");
        expect(result.intent).toBe("ACCEPT");
        expect(result.routing).toBe("MATCHED");
    });

    it("handles fully lowercase input, including a lowercase billing code", () => {
        const result = parseWhatsAppMessage("accept fl-482913-q7x2");
        expect(result.billingCode).toBe("FL-482913-Q7X2");
        expect(result.intent).toBe("ACCEPT");
        expect(result.routing).toBe("MATCHED");
    });

    it("handles emoji noise surrounding the message", () => {
        const result = parseWhatsAppMessage("👍 ok I accept 🙏 FL-482913-Q7X2 😄✅");
        expect(result.billingCode).toBe("FL-482913-Q7X2");
        expect(result.intent).toBe("ACCEPT");
        expect(result.routing).toBe("MATCHED");
    });

    it("handles emojis directly adjacent to the keyword with no space", () => {
        const result = parseWhatsAppMessage("accept👍FL-482913-Q7X2");
        expect(result.billingCode).toBe("FL-482913-Q7X2");
        expect(result.intent).toBe("ACCEPT");
        expect(result.routing).toBe("MATCHED");
    });

    it("handles conversational filler around a decline", () => {
        const result = parseWhatsAppMessage(
            "hi sorry, i need to decline this one today. code is FL-991200-Z4K9, thanks"
        );
        expect(result.billingCode).toBe("FL-991200-Z4K9");
        expect(result.intent).toBe("DECLINE");
        expect(result.routing).toBe("MATCHED");
    });
});

describe("parseWhatsAppMessage — CRITICAL STRESS CHECK: typo must never auto-execute", () => {
    it('routes "accpet" (typo) to NEEDS_CLARIFICATION, never ACCEPT', () => {
        const result = parseWhatsAppMessage("accpet FL-482913-Q7X2");
        expect(result.intent).toBe("NEEDS_CLARIFICATION");
        expect(result.routing).toBe("NEEDS_CLARIFICATION");
        expect(result.clarificationReason).toBe("NO_INTENT_FOUND");
        // Explicitly assert it did NOT get classified as the thing it looks
        // like it was trying to say.
        expect(result.intent).not.toBe("ACCEPT");
    });

    it('routes "decline" misspelled as "declien" to NEEDS_CLARIFICATION', () => {
        const result = parseWhatsAppMessage("declien FL-482913-Q7X2");
        expect(result.intent).toBe("NEEDS_CLARIFICATION");
        expect(result.intent).not.toBe("DECLINE");
    });

    it("routes a message with no recognizable intent word to NEEDS_CLARIFICATION", () => {
        const result = parseWhatsAppMessage("got it, will check my schedule FL-482913-Q7X2");
        expect(result.intent).toBe("NEEDS_CLARIFICATION");
        expect(result.clarificationReason).toBe("NO_INTENT_FOUND");
    });

    it("routes a message with no billing code to NEEDS_CLARIFICATION regardless of clear intent", () => {
        const result = parseWhatsAppMessage("yes I accept the job");
        expect(result.billingCode).toBeNull();
        expect(result.routing).toBe("NEEDS_CLARIFICATION");
        expect(result.clarificationReason).toBe("NO_BILLING_CODE");
    });

    it("routes conflicting accept+decline signals in one message to NEEDS_CLARIFICATION", () => {
        const result = parseWhatsAppMessage(
            "I accept — wait no, I need to decline actually. FL-482913-Q7X2"
        );
        expect(result.routing).toBe("NEEDS_CLARIFICATION");
        expect(result.clarificationReason).toBe("AMBIGUOUS_INTENT");
    });

    it("does not treat loosely related words (yes/ok/sure) as an implicit ACCEPT", () => {
        const result = parseWhatsAppMessage("yes ok sure sounds good FL-482913-Q7X2");
        expect(result.intent).toBe("NEEDS_CLARIFICATION");
        expect(result.intent).not.toBe("ACCEPT");
    });
});

describe("parseWhatsAppMessage — resilience", () => {
    it("never throws on empty string input", () => {
        expect(() => parseWhatsAppMessage("")).not.toThrow();
        const result = parseWhatsAppMessage("");
        expect(result.routing).toBe("NEEDS_CLARIFICATION");
    });

    it("never throws on pure emoji input", () => {
        expect(() => parseWhatsAppMessage("👍🙏😄✅🔥")).not.toThrow();
        const result = parseWhatsAppMessage("👍🙏😄✅🔥");
        expect(result.routing).toBe("NEEDS_CLARIFICATION");
        expect(result.billingCode).toBeNull();
    });
});
