// SCP Core Foundation — cognition adapters for the first proof task,
// INBOUND_OPERATIONAL_INTENT_CLASSIFICATION.
//
// Two adapters are registered so model interchangeability is demonstrable
// rather than asserted:
//
//   * deterministic-rules-v1 — no inference of any kind. Always available.
//     This is what keeps SCP coherent at zero LLM availability.
//   * remote-inference-stub-v1 — stands in for a hosted model. Reports itself
//     unavailable unless explicitly enabled, and is skipped outright when the
//     policy forbids remote inference.
//
// Swapping between them changes the *rationale* and *confidence* of an
// advisory classification. It changes no canonical state, because no
// CognitionResult can bind one.

import type {
    CognitionAdapter,
    CognitionResult,
    CognitionTask,
    ModelProfile
} from "./cognition";
import type { InboundOperationalIntent } from "../channel/inboundChannel";

const SUPPORTED = ["INBOUND_OPERATIONAL_INTENT_CLASSIFICATION"] as const;

const ACCEPT_RE = /\baccept(ed)?\b/i;
const DECLINE_RE = /\bdecline(d)?\b/i;
const CHANGE_RE = /\b(reschedul(e|ed|ing)|change|move|postpone)\b/i;
const CAPACITY_RE = /\b(cannot make it|can't make it|unavailable|sick|withdraw)\b/i;

export function classifyDeterministically(text: string): {
    classification: InboundOperationalIntent;
    confidence: number;
    rationale: string;
} {
    const accept = ACCEPT_RE.test(text);
    const decline = DECLINE_RE.test(text);

    if (accept && decline) {
        return {
            classification: "AMBIGUOUS_REQUIRES_REVIEW",
            confidence: 0.0,
            rationale: "text contains both an acceptance and a decline token"
        };
    }
    if (CAPACITY_RE.test(text)) {
        return {
            classification: "PROVIDER_CAPACITY_EXCEPTION",
            confidence: 0.8,
            rationale: "matched capacity-exception vocabulary"
        };
    }
    if (CHANGE_RE.test(text)) {
        return {
            classification: "CUSTOMER_CHANGE_REQUEST",
            confidence: 0.8,
            rationale: "matched reschedule/change vocabulary"
        };
    }
    if (accept || decline) {
        return {
            classification: "PROVIDER_ACCEPTANCE_INTENT",
            confidence: 0.9,
            rationale: `matched exact ${accept ? "acceptance" : "decline"} token`
        };
    }
    return {
        classification: "GENERAL_INFORMATION",
        confidence: 0.5,
        rationale: "no operational vocabulary matched"
    };
}

const DETERMINISTIC_PROFILE: ModelProfile = {
    profileId: "deterministic-rules-v1",
    kind: "DETERMINISTIC_LOCAL",
    displayName: "Deterministic rule classifier",
    supports: SUPPORTED
};

export const deterministicIntentAdapter: CognitionAdapter = {
    profile: DETERMINISTIC_PROFILE,
    // No network, no model weights, no runtime. Availability is unconditional,
    // which is precisely what the zero-LLM guarantee rests on.
    isAvailable: () => true,
    async run(task: CognitionTask): Promise<Omit<CognitionResult, "binding" | "requiresHumanReview">> {
        const verdict = classifyDeterministically(task.text);
        return {
            taskType: task.taskType,
            profileId: DETERMINISTIC_PROFILE.profileId,
            classification: verdict.classification,
            confidence: verdict.confidence,
            rationale: verdict.rationale
        };
    }
};

const REMOTE_PROFILE: ModelProfile = {
    profileId: "remote-inference-stub-v1",
    kind: "REMOTE_INFERENCE",
    displayName: "Remote inference stub (no provider bound)",
    supports: SUPPORTED
};

/**
 * Stands in for a hosted model without naming or importing one. Core depends on
 * the CognitionAdapter contract; binding an actual provider is a deployment
 * concern that happens outside this boundary.
 */
export function createRemoteInferenceStub(options: {
    enabled: boolean;
    /** Deterministic so tests can assert interchangeability, not randomness. */
    classification?: InboundOperationalIntent;
    confidence?: number;
}): CognitionAdapter {
    return {
        profile: REMOTE_PROFILE,
        isAvailable: () => options.enabled,
        async run(task: CognitionTask) {
            return {
                taskType: task.taskType,
                profileId: REMOTE_PROFILE.profileId,
                classification: options.classification ?? "PROVIDER_ACCEPTANCE_INTENT",
                confidence: options.confidence ?? 0.99,
                rationale: "remote inference stub — no provider bound"
            };
        }
    };
}
