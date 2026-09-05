// SCP Core Foundation — Cognition Control Boundary.
//
// COGNITION_RULE: "MODEL CHOICE MUST NOT CHANGE SCP TRUTH."
//
// COGNITION_BOUNDARY: Core must not depend on a specific LLM provider, model
// family, hosted inference service, or local runtime. Everything generative or
// interpretive passes through the four objects below, and SCP must stay
// operationally coherent with zero LLM availability.
//
// The strongest guarantee here is structural rather than procedural: a
// CognitionResult carries `binding: false` as a literal type, so there is no
// value any adapter can construct that a canonical transition would accept as
// authority. NF-09 cannot be violated by writing a more confident classifier.

export type CognitionTaskType = "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION";

export interface CognitionTask {
    taskType: CognitionTaskType;
    marketId: string;
    /** Channel-neutral text. Never a raw vendor payload. */
    text: string;
}

export type ModelKind = "DETERMINISTIC_LOCAL" | "LOCAL_INFERENCE" | "REMOTE_INFERENCE";

export interface ModelProfile {
    profileId: string;
    kind: ModelKind;
    displayName: string;
    /** Interchangeability is the point: profiles are swapped, Core is not. */
    supports: readonly CognitionTaskType[];
}

export interface ModelPolicy {
    /** Tried in order. First available profile that supports the task wins. */
    preferredProfileIds: readonly string[];
    /** When false, REMOTE_INFERENCE profiles are skipped entirely. */
    allowRemoteInference: boolean;
    /** At or below this confidence, the result is routed to human review. */
    humanReviewBelowConfidence: number;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = Object.freeze({
    preferredProfileIds: ["deterministic-rules-v1"],
    allowRemoteInference: false,
    humanReviewBelowConfidence: 0.6
});

/**
 * The output of any cognition adapter.
 *
 * `binding` is typed as the literal `false`. It is not a flag an adapter may
 * set — it is a statement about what this object can ever be used for.
 */
export interface CognitionResult {
    taskType: CognitionTaskType;
    profileId: string;
    classification: string;
    confidence: number;
    binding: false;
    requiresHumanReview: boolean;
    rationale: string;
}

export interface CognitionAdapter {
    profile: ModelProfile;
    isAvailable(): boolean;
    run(task: CognitionTask): Promise<Omit<CognitionResult, "binding" | "requiresHumanReview">>;
}

export type CognitionOutcome =
    | { available: true; result: CognitionResult }
    /**
     * Zero-LLM path. Core must continue to function on this branch — every
     * caller is required to have a non-cognition route to the same decision.
     */
    | { available: false; reason: string };

export class CognitionRegistry {
    private readonly adapters = new Map<string, CognitionAdapter>();

    register(adapter: CognitionAdapter): this {
        this.adapters.set(adapter.profile.profileId, adapter);
        return this;
    }

    get(profileId: string): CognitionAdapter | undefined {
        return this.adapters.get(profileId);
    }

    /** Profiles currently usable under a policy, in policy preference order. */
    availableFor(task: CognitionTask, policy: ModelPolicy): CognitionAdapter[] {
        const usable: CognitionAdapter[] = [];
        for (const profileId of policy.preferredProfileIds) {
            const adapter = this.adapters.get(profileId);
            if (!adapter) continue;
            if (!adapter.profile.supports.includes(task.taskType)) continue;
            if (!policy.allowRemoteInference && adapter.profile.kind === "REMOTE_INFERENCE") continue;
            if (!adapter.isAvailable()) continue;
            usable.push(adapter);
        }
        return usable;
    }
}

/**
 * Runs a cognition task under policy. Returns `available: false` rather than
 * throwing when nothing can serve it — unavailability is an ordinary operating
 * condition, not an error.
 */
export async function runCognition(
    registry: CognitionRegistry,
    task: CognitionTask,
    policy: ModelPolicy = DEFAULT_MODEL_POLICY
): Promise<CognitionOutcome> {
    const candidates = registry.availableFor(task, policy);
    const adapter = candidates[0];
    if (!adapter) {
        return {
            available: false,
            reason: "no cognition profile is available under the active model policy"
        };
    }
    const raw = await adapter.run(task);
    return {
        available: true,
        result: {
            ...raw,
            binding: false,
            requiresHumanReview: raw.confidence <= policy.humanReviewBelowConfidence
        }
    };
}

/**
 * NF-09, made executable. Any attempt to treat a classification as authority
 * for a canonical transition resolves here, and always refuses.
 *
 * Confidence is deliberately not a parameter of this decision.
 */
export function cognitionMayBindCanonicalState(_result: CognitionResult): false {
    return false;
}
