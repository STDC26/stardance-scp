// Freshline Studio Bali — MSOS Phase 0/1
// REQ-WHATSAPP-PARSER-02: fault-tolerant extraction of billing code + intent
// from loose inbound WhatsApp text.
//
// SAFETY PRINCIPLE (the actual point of this module): intent detection is
// intentionally NOT fuzzy. A deliberately narrow, literal word-boundary
// match against {"accept", "accepted", "decline", "declined"} is the entire
// vocabulary. No Levenshtein/edit-distance correction, no broad synonym set
// ("yes"/"ok"/"sure"/"no"), no partial-prefix matching. Every one of those
// would silently convert a typo, a "yes" about something else in the
// conversation, or an ambiguous reply into an automated acceptance or
// offer-release mutation — which is exactly the failure mode the
// CRITICAL STRESS CHECK in REQ-WHATSAPP-PARSER-02 forbids. Anything that
// doesn't cleanly match routes to NEEDS_CLARIFICATION for a human to
// resolve. Widening this vocabulary is a product decision, not a parsing
// improvement — see Part D.

import type { ParsedWhatsAppMessage, WhatsAppIntentState } from "../types";

const BILLING_CODE_RE = /\bFL-\d{6}-[A-Z0-9]{4}\b/i;
const ACCEPT_RE = /\baccept(ed)?\b/i;
const DECLINE_RE = /\bdecline(d)?\b/i;

// Strips emoji / pictographic / symbol code points and other non-text
// noise so downstream logging is readable. Detection regexes above already
// tolerate these characters via \b word boundaries, so this normalization
// is for audit-log hygiene, not correctness of the match itself.
const EMOJI_AND_SYMBOL_RE =
    /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/gu;

function normalizeText(raw: string): string {
    return raw
        .normalize("NFKC")
        .replace(EMOJI_AND_SYMBOL_RE, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractBillingCode(normalizedText: string): string | null {
    const match = normalizedText.match(BILLING_CODE_RE);
    return match ? match[0].toUpperCase() : null;
}

function detectIntent(normalizedText: string): WhatsAppIntentState {
    const acceptMatch = ACCEPT_RE.test(normalizedText);
    const declineMatch = DECLINE_RE.test(normalizedText);

    if (acceptMatch && declineMatch) {
        // Conflicting signals in one message (e.g. quoted/forwarded text
        // containing both words) — never guess.
        return "NEEDS_CLARIFICATION";
    }
    if (acceptMatch) return "ACCEPT";
    if (declineMatch) return "DECLINE";
    return "NEEDS_CLARIFICATION";
}

/**
 * Parses a single inbound WhatsApp message body. Never throws on malformed
 * input — worst case is an all-null/NEEDS_CLARIFICATION result, which is by
 * design the safe default that routes to manual review instead of an
 * automated state mutation.
 */
export function parseWhatsAppMessage(rawText: string): ParsedWhatsAppMessage {
    const normalizedText = normalizeText(rawText ?? "");
    const billingCode = extractBillingCode(normalizedText);
    const intent = detectIntent(normalizedText);

    if (!billingCode) {
        return {
            originalText: rawText,
            normalizedText,
            billingCode: null,
            intent,
            routing: "NEEDS_CLARIFICATION",
            clarificationReason: "NO_BILLING_CODE"
        };
    }

    if (intent === "NEEDS_CLARIFICATION") {
        const acceptMatch = ACCEPT_RE.test(normalizedText);
        const declineMatch = DECLINE_RE.test(normalizedText);
        return {
            originalText: rawText,
            normalizedText,
            billingCode,
            intent,
            routing: "NEEDS_CLARIFICATION",
            clarificationReason: acceptMatch && declineMatch ? "AMBIGUOUS_INTENT" : "NO_INTENT_FOUND"
        };
    }

    return {
        originalText: rawText,
        normalizedText,
        billingCode,
        intent,
        routing: "MATCHED"
    };
}
