// SCP Core Foundation — WhatsApp channel adapter.
//
// Closes the FL_PARSER_RESIDUAL. The Freshline `FL-######-XXXX` shape is no
// longer a literal in a code path Core depends on: this adapter compiles the
// billing pattern from `config/<marketId>.market.json` at call time, so a
// market with a different billing series (see the synthetic Bangkok
// configuration) is extracted correctly with no source change.
//
// The G1 `src/services/whatsappParser.ts` is left byte-identical. It remains
// the migration-era Phase 0/1 surface with its own inherited proof; Core does
// not import it. This adapter is the canonical channel path.
//
// FREE_TEXT_RULE: ambiguous free text cannot bind a canonical state
// transition. The adapter's job is to produce a *claim* and, where the text is
// not clean, to say so — never to resolve the ambiguity itself.

import type { PoolClient } from "pg";
import { loadMarketConfig, type MarketId } from "../../config/marketConfig";
import { identityForChannelHandle } from "../../core/identity/authority";
import { loadOffer } from "../../core/dispatch/dispatchOffer";
import type {
    CorrelationRefusal,
    InboundCorrelation,
    InboundOperationalIntent,
    NormalizedInboundMessage
} from "./inboundChannel";

// Deliberately narrow, exactly as the G1 parser's vocabulary is narrow: a typo
// or a bare "yes" must route to review, not to an automated transition.
const ACCEPT_RE = /\baccept(ed)?\b/i;
const DECLINE_RE = /\bdecline(d)?\b/i;
const CHANGE_RE = /\b(reschedul(e|ed|ing)|change|move|postpone)\b/i;
const CAPACITY_RE = /\b(cannot make it|can't make it|unavailable|sick|withdraw)\b/i;

/**
 * Compiles this market's billing-code pattern. The anchors in the configured
 * pattern are stripped for a mid-text search — the config declares the shape of
 * a whole code, and the adapter looks for that shape inside a sentence.
 */
export function billingCodeMatcher(marketId: MarketId): RegExp {
    const configured = loadMarketConfig(marketId).billing.codePattern;
    const body = configured.replace(/^\^/, "").replace(/\$$/, "");
    return new RegExp(body, "i");
}

export function extractBillingCode(marketId: MarketId, text: string): string | null {
    const match = billingCodeMatcher(marketId).exec(text);
    return match ? match[0].toUpperCase() : null;
}

function classifyIntent(text: string): InboundOperationalIntent {
    const accept = ACCEPT_RE.test(text);
    const decline = DECLINE_RE.test(text);
    if (accept && decline) {
        return "AMBIGUOUS_REQUIRES_REVIEW";
    }
    if (CAPACITY_RE.test(text)) {
        return "PROVIDER_CAPACITY_EXCEPTION";
    }
    if (CHANGE_RE.test(text)) {
        return "CUSTOMER_CHANGE_REQUEST";
    }
    if (accept || decline) {
        return "PROVIDER_ACCEPTANCE_INTENT";
    }
    return "GENERAL_INFORMATION";
}

export function normalizeText(raw: string): string {
    return raw
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Turns a raw channel payload into a channel-neutral claim. Performs zero
 * database work and grants zero authority.
 */
export function normalizeWhatsAppMessage(
    marketId: MarketId,
    senderHandle: string,
    rawText: string,
    correlatedOfferId: string | null = null
): NormalizedInboundMessage {
    const normalizedText = normalizeText(rawText);
    return {
        marketId,
        channel: "WHATSAPP",
        claimedSenderHandle: senderHandle.trim(),
        claimedBillingCode: extractBillingCode(marketId, normalizedText),
        claimedIntent: classifyIntent(normalizedText),
        correlatedOfferId,
        rawText,
        normalizedText
    };
}

export type CorrelationOutcome =
    | { correlated: true; correlation: InboundCorrelation }
    | { correlated: false; refusal: CorrelationRefusal; message: string };

/**
 * The gate between a channel claim and a canonical transition. All four
 * INBOUND_CORRELATION conditions are resolved from persisted state:
 * verified sender identity, an authoritative offer id, that offer still being
 * current, and unambiguous text.
 *
 * A billing code alone never correlates — it identifies a request, not the
 * specific offer whose decision window is open.
 */
export async function correlateInbound(
    client: PoolClient,
    message: NormalizedInboundMessage
): Promise<CorrelationOutcome> {
    if (message.claimedIntent === "AMBIGUOUS_REQUIRES_REVIEW") {
        return {
            correlated: false,
            refusal: "AMBIGUOUS_FREE_TEXT",
            message: "ambiguous free text cannot bind a canonical state transition"
        };
    }

    const identity = await identityForChannelHandle(
        client,
        message.marketId,
        message.claimedSenderHandle
    );
    if (!identity) {
        return {
            correlated: false,
            refusal: "NO_SENDER_IDENTITY",
            message: `sender handle ${message.claimedSenderHandle} does not resolve to a verified identity`
        };
    }

    if (!message.correlatedOfferId) {
        return {
            correlated: false,
            refusal: "NO_OFFER_CORRELATION",
            message:
                "no authoritative Dispatch Offer id accompanied this message; a billing code is not an offer correlation"
        };
    }

    const offer = await loadOffer(client, message.correlatedOfferId);
    if (!offer || offer.state !== "OFFERED") {
        return {
            correlated: false,
            refusal: "OFFER_NOT_CURRENT",
            message: `offer ${message.correlatedOfferId} is not currently open`
        };
    }

    return {
        correlated: true,
        correlation: { offerId: offer.offerId, identityId: identity.identityId }
    };
}
