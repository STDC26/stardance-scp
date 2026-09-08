// G5-G unit proofs — the parts that hold without a database.
//
// Webhook authenticity, the closed inbound contract, intent classification in
// the context of the message being replied to, and the structural claim that
// the channel owns no business authority.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signPayload, verifyWebhook, SIGNATURE_HEADER } from "../../src/channel/authenticity";
import {
    DECLARED_WEBHOOK_FIELDS,
    classifyResponse,
    parseInboundEvent
} from "../../src/channel/ingress";
import { CHANNEL_REASONS, channelHttpStatus } from "../../src/channel/reasons";
import { newCorrelationToken } from "../../src/channel/outbound";

const SECRET = "unit-secret";

function goodEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        eventId: "wamid.HBgL-1",
        channel: "WHATSAPP",
        from: "+628131234567",
        text: "ACCEPT",
        correlationToken: newCorrelationToken(),
        ...overrides
    };
}

describe("G5-G / webhook authenticity — the first gate, with no way around it", () => {
    it("accepts a signature computed over the exact bytes", () => {
        const body = JSON.stringify(goodEvent());
        expect(verifyWebhook(SECRET, body, signPayload(SECRET, body)).ok).toBe(true);
    });

    it("refuses a missing signature", () => {
        const outcome = verifyWebhook(SECRET, "{}", undefined);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("SIGNATURE_MISSING");
    });

    it("refuses a wrong signature, a wrong secret and a truncated one", () => {
        const body = JSON.stringify(goodEvent());
        expect(verifyWebhook(SECRET, body, "sha256=deadbeef").ok).toBe(false);
        expect(verifyWebhook(SECRET, body, signPayload("other-secret", body)).ok).toBe(false);
        expect(verifyWebhook(SECRET, body, signPayload(SECRET, body).slice(0, 20)).ok).toBe(false);
    });

    it("refuses when the body differs by a single byte", () => {
        const body = JSON.stringify(goodEvent());
        const signature = signPayload(SECRET, body);
        expect(verifyWebhook(SECRET, body.replace("ACCEPT", "DECLINE"), signature).ok).toBe(false);
        // Even whitespace: the signature covers the bytes, not the meaning.
        expect(verifyWebhook(SECRET, ` ${body}`, signature).ok).toBe(false);
    });

    it("refuses rather than allows when no secret is configured", () => {
        // The failure mode that matters: a misconfigured channel must be shut,
        // not open.
        for (const secret of [undefined, "", "   "]) {
            const outcome = verifyWebhook(secret, "{}", signPayload(SECRET, "{}"));
            expect(outcome.ok).toBe(false);
            if (outcome.ok) continue;
            expect(outcome.code).toBe("WEBHOOK_NOT_CONFIGURED");
        }
    });

    it("names its header explicitly", () => {
        expect(SIGNATURE_HEADER).toBe("x-scp-channel-signature");
        expect(signPayload(SECRET, "x").startsWith("sha256=")).toBe(true);
    });
});

describe("G5-G / correlation tokens", () => {
    it("are long, unguessable and unique", () => {
        const tokens = new Set(Array.from({ length: 500 }, () => newCorrelationToken()));
        expect(tokens.size).toBe(500);
        for (const token of tokens) {
            expect(token.length).toBeGreaterThanOrEqual(24);
            expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });
});

describe("G5-G / the closed inbound contract", () => {
    it("accepts a well-formed event", () => {
        const parsed = parseInboundEvent(goodEvent());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.event.text).toBe("ACCEPT");
    });

    it("declares only what a sender may legitimately state", () => {
        expect([...DECLARED_WEBHOOK_FIELDS].sort()).toEqual([
            "channel",
            "correlationToken",
            "eventId",
            "from",
            "messageId",
            "receipt",
            "text"
        ]);
    });

    it("refuses every field through which a caller could name its target", () => {
        for (const field of [
            "requestId",
            "offerId",
            "providerId",
            "identityId",
            "confirmationId",
            "decision",
            "intent",
            "state",
            "actionType",
            "tenantId",
            "marketId",
            "environment",
            "actorIdentityId"
        ]) {
            const parsed = parseInboundEvent(goodEvent({ [field]: "anything" }));
            expect(parsed.ok, `${field} must be refused`).toBe(false);
        }
    });

    it("requires an event id, a channel and a sender", () => {
        for (const field of ["eventId", "channel", "from"]) {
            const event = goodEvent();
            delete event[field];
            expect(parseInboundEvent(event).ok, field).toBe(false);
        }
    });

    it("accepts only DELIVERED or READ as a receipt", () => {
        expect(parseInboundEvent(goodEvent({ receipt: "DELIVERED" })).ok).toBe(true);
        expect(parseInboundEvent(goodEvent({ receipt: "READ" })).ok).toBe(true);
        expect(parseInboundEvent(goodEvent({ receipt: "ACCEPTED" })).ok).toBe(false);
        expect(parseInboundEvent(goodEvent({ receipt: "CONFIRMED" })).ok).toBe(false);
    });

    it("refuses a non-object body and an oversized field", () => {
        expect(parseInboundEvent("ACCEPT").ok).toBe(false);
        expect(parseInboundEvent([goodEvent()]).ok).toBe(false);
        expect(parseInboundEvent(null).ok).toBe(false);
        expect(parseInboundEvent(goodEvent({ text: "x".repeat(5000) })).ok).toBe(false);
    });
});

describe("G5-G / intent is read in the context of the message it replies to", () => {
    it("reads a provider reply with the provider vocabulary", () => {
        expect(classifyResponse("PROVIDER_OFFER", "ACCEPT")).toBe("PROVIDER_ACCEPT");
        expect(classifyResponse("PROVIDER_OFFER", "accepted, on my way")).toBe("PROVIDER_ACCEPT");
        expect(classifyResponse("PROVIDER_OFFER", "decline")).toBe("PROVIDER_DECLINE");
        expect(classifyResponse("PROVIDER_OFFER", "tidak")).toBe("PROVIDER_DECLINE");
    });

    it("reads a customer reply with the customer vocabulary", () => {
        expect(classifyResponse("CUSTOMER_CONFIRMATION_REQUEST", "CONFIRM")).toBe("CUSTOMER_CONFIRM");
        expect(classifyResponse("CUSTOMER_CONFIRMATION_REQUEST", "ya")).toBe("CUSTOMER_CONFIRM");
        expect(classifyResponse("CUSTOMER_CONFIRMATION_REQUEST", "cancel")).toBe("CUSTOMER_DECLINE");
    });

    it("never lets one party's word act in the other's conversation", () => {
        // The same text resolves to different intents because the message type
        // decides which conversation it belongs to.
        expect(classifyResponse("PROVIDER_OFFER", "yes")).toBe("PROVIDER_ACCEPT");
        expect(classifyResponse("CUSTOMER_CONFIRMATION_REQUEST", "yes")).toBe("CUSTOMER_CONFIRM");
        // A provider cannot produce a customer intent, whatever they type.
        for (const text of ["confirm", "CONFIRM the booking", "yes confirm"]) {
            expect(classifyResponse("PROVIDER_OFFER", text)).not.toBe("CUSTOMER_CONFIRM");
        }
    });

    it("refuses ambiguity rather than guessing", () => {
        expect(classifyResponse("PROVIDER_OFFER", "accept... actually decline")).toBe("AMBIGUOUS");
        expect(classifyResponse("CUSTOMER_CONFIRMATION_REQUEST", "yes but cancel")).toBe("AMBIGUOUS");
    });

    it("returns NONE for text carrying no consequential intent", () => {
        for (const text of ["what time?", "thanks!", "😀", "see you", ""]) {
            expect(classifyResponse("PROVIDER_OFFER", text)).toBe("NONE");
        }
    });
});

describe("G5-G / refusal vocabulary", () => {
    it("maps every reason to a status", () => {
        for (const reason of CHANNEL_REASONS) {
            const status = channelHttpStatus(reason);
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThan(600);
        }
        expect(channelHttpStatus("SIGNATURE_INVALID")).toBe(401);
        expect(channelHttpStatus("WRONG_RECIPIENT")).toBe(403);
        expect(channelHttpStatus("EVENT_ID_CONFLICT")).toBe(409);
        expect(channelHttpStatus("WEBHOOK_NOT_CONFIGURED")).toBe(503);
    });
});

describe("G5-G / the channel owns no business authority", () => {
    function filesUnder(dir: string): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                out.push(...filesUnder(full));
            } else if (full.endsWith(".ts")) {
                out.push(full);
            }
        }
        return out;
    }

    const root = join(__dirname, "..", "..", "src");
    const channelFiles = [...filesUnder(join(root, "channel")), join(root, "host", "channelHost.ts")];
    const stripped = channelFiles
        .map((f) =>
            readFileSync(f, "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^[ \t]*\/\/.*$/gm, "")
        )
        .join("\n");

    it("writes to no canonical Service-Commerce table", () => {
        for (const table of [
            "core_service_request",
            "core_dispatch_offer",
            "core_assignment",
            "core_customer_confirmation",
            "core_fulfillment",
            "core_operational_action",
            "core_request_qualification",
            "core_capacity_window",
            "core_provider",
            "core_identity_role",
            "appointments"
        ]) {
            expect(stripped, `the channel must not write ${table}`).not.toMatch(
                new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, "i")
            );
        }
    });

    it("performs every consequence through the one governed orchestrator", () => {
        expect(stripped).toContain("executeOperationalAction");
        for (const forbidden of [
            "transitionRequest",
            "decideAttempt",
            "confirmContext",
            "assignProvider",
            "recordQualification"
        ]) {
            expect(stripped, `the channel must not call ${forbidden}`).not.toContain(forbidden);
        }
    });

    it("names no lifecycle state of its own", () => {
        for (const state of [
            "PROVIDER_DISPATCHED",
            "PROVIDER_ACCEPTED",
            "OWNER_ASSIGNED",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CUSTOMER_CONFIRMED",
            "FULFILLMENT_ACTIVE",
            "SERVICE_COMPLETED"
        ]) {
            expect(stripped, `the channel must not name ${state}`).not.toContain(state);
        }
    });

    it("builds no interpretation engine", () => {
        for (const forbidden of ["openai", "anthropic", "llm", "gpt", "completion(", "embedding"]) {
            expect(stripped.toLowerCase(), `no ${forbidden}`).not.toContain(forbidden);
        }
    });

    it("carries no Freshline-specific business rule", () => {
        for (const literal of ["Seminyak", "Canggu", "FRESH_CUT", "bali"]) {
            expect(stripped, `the channel must not carry ${literal}`).not.toContain(literal);
        }
    });

    it("Core, kernel and lifecycle import nothing from the channel module", () => {
        const governed = ["core", "kernel", "lifecycle"].flatMap((d) => filesUnder(join(root, d)));
        for (const file of governed) {
            const source = readFileSync(file, "utf8");
            expect(source, `${file} must not import the channel module`).not.toMatch(
                /from\s+["'][^"']*\/channel\/(ingress|outbound|authenticity|reasons)["']/
            );
        }
    });

    it("the delivery-receipt path cannot reach a governed command", () => {
        const outbound = readFileSync(join(root, "channel", "outbound.ts"), "utf8");
        const receiptFn = outbound.slice(outbound.indexOf("export async function recordDeliveryReceipt"));
        expect(receiptFn).toContain("core_channel_message");
        expect(receiptFn).not.toContain("executeOperationalAction");
        expect(receiptFn).not.toContain("core_service_request");
    });
});
