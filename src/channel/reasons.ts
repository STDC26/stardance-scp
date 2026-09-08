// SCP-G5-G — the channel-boundary refusal vocabulary.
//
// One closed set for everything the CHANNEL can refuse: authenticity,
// correlation, scope, staleness, replay and malformed intent.
//
// Deliberately separate from LifecycleReason. When Core refuses an action the
// channel carries that refusal through as CANONICAL_REFUSAL with the lifecycle
// code attached, because a transport that paraphrased Core's reasons would
// eventually paraphrase one of them wrongly — and because the difference
// between "we could not attribute this message" and "the request is in the
// wrong state" is exactly what an operator needs to see.

export const CHANNEL_REASONS = [
    // --- authenticity ---------------------------------------------------
    /** No signature header was presented. */
    "SIGNATURE_MISSING",
    /** A signature was presented and does not match the raw body. */
    "SIGNATURE_INVALID",
    /** The webhook secret is not configured for this runtime. */
    "WEBHOOK_NOT_CONFIGURED",

    // --- payload --------------------------------------------------------
    "PAYLOAD_MALFORMED",
    "UNDECLARED_FIELD",
    "FIELD_INVALID",

    // --- correlation ----------------------------------------------------
    /** No correlation token, and nothing else may substitute for one. */
    "NO_CORRELATION",
    /** The token does not resolve to a message in this scope. */
    "CORRELATION_UNKNOWN",
    /** The sender handle resolves to no verified identity. */
    "NO_SENDER_IDENTITY",
    /** The message was addressed to somebody else. */
    "WRONG_RECIPIENT",
    /** The message belongs to a different tenant/market/environment. */
    "CROSS_SCOPE_REFUSED",

    // --- staleness ------------------------------------------------------
    /** The offer this message was about is no longer open. */
    "OFFER_NOT_CURRENT",
    /** The confirmation context is no longer the live one. */
    "CONFIRMATION_NOT_CURRENT",
    /** The request has reached a terminal state. */
    "REQUEST_TERMINAL",

    // --- intent ---------------------------------------------------------
    /** Free text that could mean two things binds nothing. */
    "AMBIGUOUS_FREE_TEXT",
    /** The text carries no consequential intent this boundary handles. */
    "NO_CONSEQUENTIAL_INTENT",
    /** The intent does not belong on this message type. */
    "INTENT_NOT_APPLICABLE",

    // --- replay ---------------------------------------------------------
    /** The same provider event id arrived again with different content. */
    "EVENT_ID_CONFLICT",

    // --- canonical ------------------------------------------------------
    /** SCP refused. Its lifecycle reason code is carried through unchanged. */
    "CANONICAL_REFUSAL"
] as const;

export type ChannelReason = (typeof CHANNEL_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(CHANNEL_REASONS);

export function isChannelReason(value: unknown): value is ChannelReason {
    return typeof value === "string" && REASON_SET.has(value);
}

/**
 * HTTP status for a refusal.
 *
 * Note what is NOT here: a refused webhook still returns a 2xx-family answer in
 * many provider integrations to stop infinite retries. That is a delivery
 * decision for the host, not a governance one, so this maps the governance
 * meaning and the host decides what to do with it.
 */
export function channelHttpStatus(reason: ChannelReason): number {
    switch (reason) {
        case "SIGNATURE_MISSING":
        case "SIGNATURE_INVALID":
            return 401;
        case "WEBHOOK_NOT_CONFIGURED":
            return 503;
        case "CROSS_SCOPE_REFUSED":
        case "WRONG_RECIPIENT":
            return 403;
        case "PAYLOAD_MALFORMED":
            return 400;
        case "EVENT_ID_CONFLICT":
            return 409;
        default:
            return 422;
    }
}
