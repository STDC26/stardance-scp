// SCP Core Foundation — governed inbound provider decision.
//
// This is the single path from "a message arrived on a channel" to "a canonical
// Service Request transition happened", and it is where NF-09 is enforced end
// to end:
//
//   PROVIDER_ACCEPTANCE_INTENT is a non-binding cognition proposal. It must
//   pass authoritative Dispatch Offer correlation, verified sender authority,
//   current-offer validity, non-expiry, not-already-decided, and transactional
//   state validation. Classification confidence never substitutes for offer-ID
//   correlation.
//
// A CognitionResult may be supplied. It is recorded as advisory context and is
// never consulted to decide whether the transition may proceed — the decision
// token is read from the message text, and the authority comes entirely from
// respondToOffer's own checks.

import type { PoolClient } from "pg";
import { fail, succeed, type GovernedOutcome } from "../types";
import { correlateInbound } from "../../adapters/channel/whatsappChannelAdapter";
import type { NormalizedInboundMessage } from "../../adapters/channel/inboundChannel";
import {
    cognitionMayBindCanonicalState,
    type CognitionOutcome
} from "../../adapters/cognition/cognition";
import { respondToOffer, type OfferDecision, type RespondResult } from "./dispatchOffer";

const ACCEPT_RE = /\baccept(ed)?\b/i;
const DECLINE_RE = /\bdecline(d)?\b/i;

/** Reads the explicit decision token. Returns null for anything ambiguous. */
export function explicitDecisionToken(text: string): OfferDecision | null {
    const accept = ACCEPT_RE.test(text);
    const decline = DECLINE_RE.test(text);
    if (accept === decline) {
        return null; // both or neither — never guess
    }
    return accept ? "ACCEPT" : "DECLINE";
}

export interface InboundDecisionResult extends RespondResult {
    /** Advisory only; present purely so the audit trail shows what was proposed. */
    cognitionAdvisory: {
        consulted: boolean;
        classification: string | null;
        confidence: number | null;
        wasBinding: false;
    };
}

export async function applyInboundProviderDecision(
    client: PoolClient,
    message: NormalizedInboundMessage,
    idempotencyKey: string,
    cognition?: CognitionOutcome,
    options: { now?: () => Date } = {}
): Promise<GovernedOutcome<InboundDecisionResult>> {
    // Recorded for the audit trail, and structurally incapable of authorizing
    // anything: cognitionMayBindCanonicalState returns the literal `false`.
    const advisory = {
        consulted: cognition?.available === true,
        classification: cognition?.available === true ? cognition.result.classification : null,
        confidence: cognition?.available === true ? cognition.result.confidence : null,
        wasBinding: false as const
    };
    if (cognition?.available === true && cognitionMayBindCanonicalState(cognition.result)) {
        // Unreachable by construction; retained as an explicit tripwire.
        return fail("COGNITION_NOT_BINDING", "cognition may never bind canonical state");
    }

    // Authoritative correlation first. A confident classification with no offer
    // correlation stops here, which is the whole of NF-09.
    const correlation = await correlateInbound(client, message);
    if (!correlation.correlated) {
        return fail(
            correlation.refusal === "NO_SENDER_IDENTITY" ? "UNAUTHORIZED" : "OFFER_NOT_CURRENT",
            correlation.message
        );
    }

    const decision = explicitDecisionToken(message.normalizedText);
    if (!decision) {
        return fail(
            "COGNITION_NOT_BINDING",
            "no unambiguous decision token in the message; ambiguous free text cannot bind a transition"
        );
    }

    const responded = await respondToOffer(
        client,
        {
            offerId: correlation.correlation.offerId,
            identityId: correlation.correlation.identityId,
            decision,
            ...(options.now ? { now: options.now } : {})
        },
        idempotencyKey
    );
    if (!responded.ok) {
        return responded;
    }

    return succeed({ ...responded.value, cognitionAdvisory: advisory });
}
