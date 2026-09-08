// SCP-G5-G — inbound webhook authenticity.
//
// The first gate. Nothing downstream — not correlation, not intent, not a
// governed action — runs until the bytes that arrived are proven to have come
// from the configured transport.
//
// Three properties the implementation deliberately has:
//
//   * it verifies the RAW BODY, not a re-serialized object. Re-serializing
//     changes key order and whitespace, so a signature that validated against
//     the parsed form would validate against a payload the sender never sent.
//   * comparison is constant-time. A byte-by-byte early exit leaks the prefix
//     of a valid signature to anyone willing to measure.
//   * there is no bypass. No "skip in development" flag, no header that
//     disables it, no unsigned fallback — an unconfigured secret refuses the
//     request rather than waving it through, because a channel that trusts
//     unsigned input when misconfigured is worse than one that is simply down.

import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthenticityFailure =
    | "SIGNATURE_MISSING"
    | "SIGNATURE_INVALID"
    | "WEBHOOK_NOT_CONFIGURED";

export type AuthenticityOutcome =
    | { ok: true }
    | { ok: false; code: AuthenticityFailure; message: string };

/** The header the transport presents its signature in. */
export const SIGNATURE_HEADER = "x-scp-channel-signature";

/**
 * Computes the expected signature over the exact bytes received.
 *
 * `sha256=<hex>` mirrors the shape the common WhatsApp Business / Meta webhook
 * integrations use, so a real transport can be substituted without changing
 * this contract.
 */
export function signPayload(secret: string, rawBody: Buffer | string): string {
    const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Verifies an inbound webhook.
 *
 * A missing secret is `WEBHOOK_NOT_CONFIGURED`, not "allowed" — the channel
 * refuses to accept consequential input it cannot authenticate.
 */
export function verifyWebhook(
    secret: string | undefined,
    rawBody: Buffer | string,
    presented: string | undefined
): AuthenticityOutcome {
    if (!secret || secret.trim() === "") {
        return {
            ok: false,
            code: "WEBHOOK_NOT_CONFIGURED",
            message: "no channel webhook secret is configured for this runtime"
        };
    }
    if (!presented || presented.trim() === "") {
        return {
            ok: false,
            code: "SIGNATURE_MISSING",
            message: "no signature was presented"
        };
    }

    const expected = Buffer.from(signPayload(secret, rawBody), "utf8");
    const actual = Buffer.from(presented.trim(), "utf8");
    // Length is compared first because timingSafeEqual throws on a mismatch;
    // the length of a signature is not a secret.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return {
            ok: false,
            code: "SIGNATURE_INVALID",
            message: "the presented signature does not match the received body"
        };
    }
    return { ok: true };
}
