// G2-E12 — Cognition Control Boundary.
//
// Three things are proven here without any database or model:
//   1. No CognitionResult can ever be binding (NF-09, structurally).
//   2. Swapping the model profile changes advice, never truth.
//   3. Core is coherent with zero cognition available.

import { describe, expect, it } from "vitest";
import {
    CognitionRegistry,
    DEFAULT_MODEL_POLICY,
    cognitionMayBindCanonicalState,
    runCognition,
    type CognitionTask,
    type ModelPolicy
} from "../../src/adapters/cognition/cognition";
import {
    classifyDeterministically,
    createRemoteInferenceStub,
    deterministicIntentAdapter
} from "../../src/adapters/cognition/intentClassificationAdapters";

const task: CognitionTask = {
    taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
    marketId: "bali",
    text: "I accept"
};

describe("NF-09 — cognition is structurally non-binding", () => {
    it("stamps every result with binding: false", async () => {
        const registry = new CognitionRegistry().register(deterministicIntentAdapter);
        const outcome = await runCognition(registry, task);
        expect(outcome.available).toBe(true);
        if (outcome.available) {
            expect(outcome.result.binding).toBe(false);
        }
    });

    it("refuses to bind canonical state even at maximum confidence", async () => {
        const registry = new CognitionRegistry().register(
            createRemoteInferenceStub({
                enabled: true,
                classification: "PROVIDER_ACCEPTANCE_INTENT",
                confidence: 1.0
            })
        );
        const policy: ModelPolicy = {
            preferredProfileIds: ["remote-inference-stub-v1"],
            allowRemoteInference: true,
            humanReviewBelowConfidence: 0.6
        };
        const outcome = await runCognition(registry, task, policy);
        expect(outcome.available).toBe(true);
        if (outcome.available) {
            expect(outcome.result.confidence).toBe(1.0);
            // Confidence is not an input to this decision.
            expect(cognitionMayBindCanonicalState(outcome.result)).toBe(false);
        }
    });

    it("routes low-confidence classifications to human review", async () => {
        const registry = new CognitionRegistry().register(deterministicIntentAdapter);
        const outcome = await runCognition(registry, {
            ...task,
            text: "I accept but also I decline"
        });
        expect(outcome.available).toBe(true);
        if (outcome.available) {
            expect(outcome.result.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
            expect(outcome.result.requiresHumanReview).toBe(true);
        }
    });
});

describe("MODEL CHOICE MUST NOT CHANGE SCP TRUTH — interchangeability", () => {
    it("serves the same task from either profile", async () => {
        const registry = new CognitionRegistry()
            .register(deterministicIntentAdapter)
            .register(createRemoteInferenceStub({ enabled: true }));

        const local = await runCognition(registry, task, {
            preferredProfileIds: ["deterministic-rules-v1"],
            allowRemoteInference: false,
            humanReviewBelowConfidence: 0.6
        });
        const remote = await runCognition(registry, task, {
            preferredProfileIds: ["remote-inference-stub-v1"],
            allowRemoteInference: true,
            humanReviewBelowConfidence: 0.6
        });

        expect(local.available && remote.available).toBe(true);
        if (local.available && remote.available) {
            expect(local.result.profileId).not.toBe(remote.result.profileId);
            // Different provenance, identical (non-)authority.
            expect(local.result.binding).toBe(false);
            expect(remote.result.binding).toBe(false);
        }
    });

    it("skips remote profiles entirely when policy forbids remote inference", async () => {
        const registry = new CognitionRegistry().register(
            createRemoteInferenceStub({ enabled: true })
        );
        const outcome = await runCognition(registry, task, {
            preferredProfileIds: ["remote-inference-stub-v1"],
            allowRemoteInference: false,
            humanReviewBelowConfidence: 0.6
        });
        expect(outcome.available).toBe(false);
    });

    it("names no LLM provider, model family, or inference service in the contract", () => {
        const contractText = JSON.stringify(deterministicIntentAdapter.profile);
        expect(contractText).not.toMatch(/openai|anthropic|claude|gpt|gemini|llama|mistral/i);
    });
});

describe("ZERO_LLM_PROOF — Core stays coherent with cognition unavailable", () => {
    it("reports unavailability as an outcome rather than throwing", async () => {
        const registry = new CognitionRegistry(); // nothing registered at all
        const outcome = await runCognition(registry, task, DEFAULT_MODEL_POLICY);
        expect(outcome.available).toBe(false);
        if (!outcome.available) {
            expect(outcome.reason).toContain("no cognition profile");
        }
    });

    it("still reaches the same operational classification deterministically", () => {
        // The zero-LLM route: the deterministic classifier is a pure function,
        // so an operator (or Core) can classify with no inference at all.
        expect(classifyDeterministically("I accept").classification).toBe(
            "PROVIDER_ACCEPTANCE_INTENT"
        );
        expect(classifyDeterministically("I am sick").classification).toBe(
            "PROVIDER_CAPACITY_EXCEPTION"
        );
        expect(classifyDeterministically("hello there").classification).toBe("GENERAL_INFORMATION");
    });

    it("the deterministic profile is available unconditionally", () => {
        expect(deterministicIntentAdapter.isAvailable()).toBe(true);
        expect(deterministicIntentAdapter.profile.kind).toBe("DETERMINISTIC_LOCAL");
    });
});
