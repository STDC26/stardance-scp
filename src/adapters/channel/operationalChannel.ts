// SCP Operational Lifecycle — bounded channel adapter.
//
// A channel event is a CLAIM. It becomes an OperationalAction only after the
// sender is resolved to a verified identity and the event is correlated to an
// exact current operational context. No channel record is ever the lifecycle
// owner, and ambiguous free text can never bind.
//
// This is deliberately thin: it normalizes and correlates, then hands the
// orchestrator a fully-formed action. It performs no state change of its own.

import type { PoolClient } from "pg";
import type { MarketId } from "../../config/marketConfig";
import { identityForChannelHandle } from "../../core/identity/authority";
import { currentAttempt } from "../../lifecycle/dispatchAttempt";
import { liveContext } from "../../lifecycle/confirmationContext";
import type { OperationalActionType, ActionPayload } from "../../lifecycle/actions";
import type { LifecycleReason } from "../../lifecycle/reasons";
import { normalizeText } from "./whatsappChannelAdapter";

export interface OperationalChannelEvent {
    marketId: MarketId;
    channel: "WHATSAPP" | "SMS" | "WEB" | "TEST";
    /** Unverified. Resolved against core_identity, never trusted as given. */
    claimedSenderHandle: string;
    /** The Service Request the channel believes this concerns. */
    claimedRequestId: string;
    rawText: string;
    /** Present only when the channel itself carried an authoritative id. */
    correlatedAttemptId?: string | null;
    /** Monotonic per-channel sequence, used to detect out-of-order delivery. */
    deliverySequence?: number;
}

export interface NormalizedOperationalIntent {
    actionType: OperationalActionType;
    payload: ActionPayload;
}

export type ChannelResolution =
    | {
          resolved: true;
          actionType: OperationalActionType;
          actorIdentityId: string;
          payload: ActionPayload;
      }
    | { resolved: false; reasonCode: LifecycleReason; message: string };

const ACCEPT_RE = /\baccept(ed)?\b/i;
const DECLINE_RE = /\b(decline(d)?|reject(ed)?)\b/i;
const CONFIRM_RE = /\bconfirm(ed)?\b/i;
const CANCEL_RE = /\bcancel(led|ed)?\b/i;

/**
 * Reads an unambiguous operational intent from text, or nothing. Two competing
 * tokens, or none, yield null — the adapter never guesses which one the sender
 * meant.
 */
export function readOperationalIntent(text: string): OperationalActionType | null {
    const matches: OperationalActionType[] = [];
    if (ACCEPT_RE.test(text)) matches.push("RECORD_PROVIDER_ACCEPTANCE");
    if (DECLINE_RE.test(text)) matches.push("RECORD_PROVIDER_REJECTION");
    if (CONFIRM_RE.test(text)) matches.push("RECORD_CUSTOMER_CONFIRMATION");
    if (CANCEL_RE.test(text)) matches.push("CANCEL_SERVICE");
    return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolves a channel event into an actionable, correlated command — or refuses
 * with a governed reason. Every correlation is re-derived from persisted state.
 */
export async function resolveChannelEvent(
    client: PoolClient,
    event: OperationalChannelEvent
): Promise<ChannelResolution> {
    const normalized = normalizeText(event.rawText);

    const intent = readOperationalIntent(normalized);
    if (!intent) {
        return {
            resolved: false,
            reasonCode: "AMBIGUOUS_ACTION",
            message: "channel text carries no single unambiguous operational intent"
        };
    }

    const identity = await identityForChannelHandle(
        client,
        event.marketId,
        event.claimedSenderHandle.trim()
    );
    if (!identity) {
        return {
            resolved: false,
            reasonCode: "AUTHORITY_REFUSED",
            message: `sender ${event.claimedSenderHandle} does not resolve to a verified identity`
        };
    }

    // Correlate to the exact current operational context for this intent.
    if (
        intent === "RECORD_PROVIDER_ACCEPTANCE" ||
        intent === "RECORD_PROVIDER_REJECTION"
    ) {
        const attempt = await currentAttempt(client, event.claimedRequestId);
        if (!attempt) {
            return {
                resolved: false,
                reasonCode: "CORRELATION_REQUIRED",
                message: "no current dispatch attempt to respond to"
            };
        }
        // A channel-supplied attempt id that disagrees with the current one is
        // a stale delivery, not a new decision.
        if (event.correlatedAttemptId && event.correlatedAttemptId !== attempt.attemptId) {
            return {
                resolved: false,
                reasonCode: "STALE_DISPATCH_RESPONSE",
                message: "the event references a dispatch attempt that is no longer current"
            };
        }
        return {
            resolved: true,
            actionType: intent,
            actorIdentityId: identity.identityId,
            payload: { attemptId: attempt.attemptId }
        };
    }

    if (intent === "RECORD_CUSTOMER_CONFIRMATION") {
        const context = await liveContext(client, event.claimedRequestId);
        if (!context || context.status !== "PENDING") {
            return {
                resolved: false,
                reasonCode: "CORRELATION_REQUIRED",
                message: "no pending confirmation context to bind"
            };
        }
        return {
            resolved: true,
            actionType: intent,
            actorIdentityId: identity.identityId,
            payload: {
                contextVersion: context.contextVersion,
                commitmentVersion: context.commitmentVersion
            }
        };
    }

    return {
        resolved: true,
        actionType: intent,
        actorIdentityId: identity.identityId,
        payload: { reasonCode: "CUSTOMER_CANCELLED" }
    };
}
