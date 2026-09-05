// SCP Core Foundation — Adapter Boundary (channel-neutral contract).
//
// ADAPTER_BOUNDARY: "WhatsApp is a channel, not a state owner." Core never sees
// raw channel text, a WhatsApp payload shape, or a vendor sender format. It
// sees only this normalized structure, and even then the structure is a
// *claim* — nothing here is authoritative until Core re-derives identity and
// offer correlation from persisted state.

/** What an inbound message is asking for, in channel-neutral terms. */
export type InboundOperationalIntent =
    | "CUSTOMER_CHANGE_REQUEST"
    | "PROVIDER_CAPACITY_EXCEPTION"
    | "PROVIDER_ACCEPTANCE_INTENT"
    | "GENERAL_INFORMATION"
    | "AMBIGUOUS_REQUIRES_REVIEW";

/**
 * A normalized inbound message. Every field is an unverified claim from the
 * outside world — the naming is deliberate so no reader mistakes it for
 * authority.
 */
export interface NormalizedInboundMessage {
    marketId: string;
    channel: "WHATSAPP" | "SMS" | "WEB" | "TEST";
    /** Normalized sender handle. Correlates to an identity, or to nothing. */
    claimedSenderHandle: string;
    /** Tenant-scoped reference extracted using that market's configured pattern. */
    claimedBillingCode: string | null;
    claimedIntent: InboundOperationalIntent;
    /** Present only when the channel itself carried an authoritative offer id. */
    correlatedOfferId: string | null;
    rawText: string;
    normalizedText: string;
}

/**
 * The only way an inbound message may reach a canonical transition. Every field
 * must be satisfied from persisted Core state — ADAPTER_BOUNDARY.INBOUND_CORRELATION.
 */
export interface InboundCorrelation {
    offerId: string;
    identityId: string;
}

export type CorrelationRefusal =
    | "NO_SENDER_IDENTITY"
    | "NO_OFFER_CORRELATION"
    | "OFFER_NOT_CURRENT"
    | "AMBIGUOUS_FREE_TEXT";
