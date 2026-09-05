// G2-E11 / G2-E12 — end-to-end canonical flow, audit completeness,
// NF-09 enforcement, zero-LLM operation, and G1R-R01 closure at the Core
// command boundary.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, windowStartingInHours, idemKey } from "./coreTestDb";
import { createServiceRequest, loadRequest } from "../../src/core/request/serviceRequest";
import { holdCapacity, activeHoldsForRequest } from "../../src/core/capacity/capacity";
import { offerDispatch, respondToOffer } from "../../src/core/dispatch/dispatchOffer";
import { assignRequest, requestCustomerConfirmation } from "../../src/core/dispatch/assignment";
import { confirmBooking } from "../../src/core/confirmation/customerConfirmation";
import { beginFulfillment, recordFulfillmentResult } from "../../src/core/fulfillment/fulfillment";
import { eventsFor } from "../../src/core/events/eventLog";
import { applyInboundProviderDecision } from "../../src/core/dispatch/inboundDecision";
import { normalizeWhatsAppMessage } from "../../src/adapters/channel/whatsappChannelAdapter";
import {
    CognitionRegistry,
    runCognition,
    type CognitionOutcome
} from "../../src/adapters/cognition/cognition";
import {
    createRemoteInferenceStub,
    deterministicIntentAdapter
} from "../../src/adapters/cognition/intentClassificationAdapters";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G2-E11 — end-to-end canonical flow", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("runs intake -> dispatch -> acceptance -> assignment -> confirmation -> fulfillment", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const startTime = windowStartingInHours(30);

            const created = await createServiceRequest(
                client,
                {
                    marketId: world.marketId,
                    customerIdentityId: world.customerIdentityId,
                    serviceId: world.serviceId,
                    startTime,
                    addonIds: [world.addonId]
                },
                SYSTEM_ACTOR,
                idemKey("create")
            );
            expect(created.ok).toBe(true);
            if (!created.ok) return;
            const requestId = created.value.requestId;

            // 60 base + 15 add-on + 10 buffer.
            expect(created.value.durationMinutes).toBe(85);
            expect(created.value.priceMinorUnits).toBe(300000);
            expect(created.value.currencyCode).toBe("IDR");

            await holdCapacity(
                client,
                {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    requestId,
                    startTime,
                    endTime: created.value.endTime
                },
                SYSTEM_ACTOR,
                idemKey("hold")
            );

            const offered = await offerDispatch(
                client,
                { requestId, providerId: world.providerId, marketId: "bali" },
                SYSTEM_ACTOR,
                idemKey("offer")
            );
            expect(offered.ok).toBe(true);
            if (!offered.ok) return;
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_DISPATCHED");

            const accepted = await respondToOffer(
                client,
                {
                    offerId: offered.value.offerId,
                    identityId: world.providerIdentityId,
                    decision: "ACCEPT"
                },
                idemKey("accept")
            );
            expect(accepted.ok).toBe(true);
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_ACCEPTED");

            const assigned = await assignRequest(
                client,
                { requestId, offerId: offered.value.offerId, identityId: world.ownerIdentityId },
                idemKey("assign")
            );
            expect(assigned.ok).toBe(true);
            if (!assigned.ok) return;
            expect(assigned.value.committedHoldIds).toHaveLength(1);
            expect((await loadRequest(client, requestId))!.state).toBe("OWNER_ASSIGNED");

            await requestCustomerConfirmation(
                client,
                requestId,
                world.ownerIdentityId,
                idemKey("present")
            );
            expect((await loadRequest(client, requestId))!.state).toBe(
                "AWAITING_CUSTOMER_CONFIRMATION"
            );

            const confirmed = await confirmBooking(
                client,
                { requestId, identityId: world.customerIdentityId, confirmedVersion: 1 },
                idemKey("confirm")
            );
            expect(confirmed.ok).toBe(true);
            expect((await loadRequest(client, requestId))!.state).toBe("CUSTOMER_CONFIRMED");

            const begun = await beginFulfillment(
                client,
                requestId,
                world.ownerIdentityId,
                idemKey("begin")
            );
            expect(begun.ok).toBe(true);
            expect((await loadRequest(client, requestId))!.state).toBe("FULFILLMENT_ACTIVE");

            const result = await recordFulfillmentResult(
                client,
                requestId,
                world.ownerIdentityId,
                "SERVICE_COMPLETED",
                idemKey("complete")
            );
            expect(result.ok).toBe(true);
            expect((await loadRequest(client, requestId))!.state).toBe("SERVICE_COMPLETED");

            // Capacity is returned once the service is done.
            expect(await activeHoldsForRequest(client, requestId)).toHaveLength(0);

            // EVENT_AUDIT: every canonical transition is attributed and traceable.
            const events = await eventsFor(client, "SERVICE_REQUEST", requestId);
            expect(events.map((e) => e.to_state)).toEqual([
                "PENDING_ACCEPTANCE",
                "PROVIDER_DISPATCHED",
                "PROVIDER_ACCEPTED",
                "OWNER_ASSIGNED",
                "AWAITING_CUSTOMER_CONFIRMATION",
                "CUSTOMER_CONFIRMED",
                "FULFILLMENT_ACTIVE",
                "SERVICE_COMPLETED"
            ]);
            for (const event of events) {
                expect(event.actor_authority.length).toBeGreaterThan(0);
                expect(["OWNER", "PROVIDER", "CUSTOMER", "SYSTEM"]).toContain(event.actor_role);
            }
            // The three consequential acts came from three different authorities.
            const roles = events
                .filter((e) =>
                    ["PROVIDER_ACCEPTED", "OWNER_ASSIGNED", "CUSTOMER_CONFIRMED"].includes(e.to_state)
                )
                .map((e) => e.actor_role);
            expect(new Set(roles).size).toBe(3);
        });
    });

    it("IDEMPOTENCY: replaying a governed command does not duplicate the audit trail", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const created = await createServiceRequest(
                client,
                {
                    marketId: world.marketId,
                    customerIdentityId: world.customerIdentityId,
                    serviceId: world.serviceId,
                    startTime: windowStartingInHours(31)
                },
                SYSTEM_ACTOR,
                "fixed-create-key"
            );
            if (!created.ok) throw new Error(created.message);

            const offered = await offerDispatch(
                client,
                { requestId: created.value.requestId, providerId: world.providerId, marketId: "bali" },
                SYSTEM_ACTOR,
                "fixed-offer-key"
            );
            if (!offered.ok) throw new Error(offered.message);

            // Replay the identical command.
            const replay = await offerDispatch(
                client,
                { requestId: created.value.requestId, providerId: world.providerId, marketId: "bali" },
                SYSTEM_ACTOR,
                "fixed-offer-key"
            );
            expect(replay.ok).toBe(false);

            const events = await eventsFor(client, "SERVICE_REQUEST", created.value.requestId);
            expect(events.filter((e) => e.to_state === "PROVIDER_DISPATCHED")).toHaveLength(1);
        });
    });

    it("G1R-R01: a malformed request identifier returns a governed refusal, not a raw DB error", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);

            let threw: unknown = null;
            let outcome;
            try {
                outcome = await assignRequest(
                    client,
                    {
                        requestId: "appointment-1",
                        offerId: "offer-1",
                        identityId: world.ownerIdentityId
                    },
                    idemKey("assign")
                );
            } catch (err) {
                threw = err;
            }
            expect(threw).toBeNull();
            expect(outcome?.ok).toBe(false);
            if (outcome && !outcome.ok) {
                expect(outcome.code).toBe("INVALID_IDENTIFIER");
                expect(outcome.message).toContain("requestId");
            }

            // The transaction is still usable — nothing was poisoned.
            const { rows } = await client.query(`SELECT 1 AS ok`);
            expect(rows).toHaveLength(1);
        });
    });
});

d("G2-E12 — NF-09 and zero-LLM operation", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    async function dispatchedWorld(client: Parameters<typeof seedWorld>[0]) {
        const world = await seedWorld(client);
        const created = await createServiceRequest(
            client,
            {
                marketId: world.marketId,
                customerIdentityId: world.customerIdentityId,
                serviceId: world.serviceId,
                startTime: windowStartingInHours(40)
            },
            SYSTEM_ACTOR,
            idemKey("create")
        );
        if (!created.ok) throw new Error(created.message);
        const offered = await offerDispatch(
            client,
            { requestId: created.value.requestId, providerId: world.providerId, marketId: "bali" },
            SYSTEM_ACTOR,
            idemKey("offer")
        );
        if (!offered.ok) throw new Error(offered.message);
        return { world, requestId: created.value.requestId, offerId: offered.value.offerId };
    }

    it("NF-09: a maximally confident classification cannot bind without offer correlation", async () => {
        await withTransaction(pool, async (client) => {
            const { world, requestId } = await dispatchedWorld(client);

            const registry = new CognitionRegistry().register(
                createRemoteInferenceStub({
                    enabled: true,
                    classification: "PROVIDER_ACCEPTANCE_INTENT",
                    confidence: 1.0
                })
            );
            const cognition: CognitionOutcome = await runCognition(
                registry,
                {
                    taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
                    marketId: "bali",
                    text: "I accept"
                },
                {
                    preferredProfileIds: ["remote-inference-stub-v1"],
                    allowRemoteInference: true,
                    humanReviewBelowConfidence: 0.6
                }
            );
            expect(cognition.available).toBe(true);

            // Correct sender, correct text, no offer id.
            const message = normalizeWhatsAppMessage(
                "bali",
                world.providerHandle,
                "I accept FL-482913-Q7X2",
                null
            );

            const outcome = await applyInboundProviderDecision(
                client,
                message,
                idemKey("inbound"),
                cognition
            );
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.message).toContain("billing code is not an offer correlation");
            }
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_DISPATCHED");
        });
    });

    it("NF-09: an unverified sender cannot bind even with a correct offer id", async () => {
        await withTransaction(pool, async (client) => {
            const { requestId, offerId } = await dispatchedWorld(client);

            const message = normalizeWhatsAppMessage(
                "bali",
                "+6289999999999", // handle belongs to no identity
                "I accept",
                offerId
            );
            const outcome = await applyInboundProviderDecision(client, message, idemKey("inbound"));
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.code).toBe("UNAUTHORIZED");
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_DISPATCHED");
        });
    });

    it("NF-09: ambiguous free text cannot bind a canonical transition", async () => {
        await withTransaction(pool, async (client) => {
            const { world, requestId, offerId } = await dispatchedWorld(client);
            const message = normalizeWhatsAppMessage(
                "bali",
                world.providerHandle,
                "I accept — wait no, I decline",
                offerId
            );
            const outcome = await applyInboundProviderDecision(client, message, idemKey("inbound"));
            expect(outcome.ok).toBe(false);
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_DISPATCHED");
        });
    });

    it("NF-09: the customer cannot accept the provider's offer even with the offer id", async () => {
        await withTransaction(pool, async (client) => {
            const { world, requestId, offerId } = await dispatchedWorld(client);
            const message = normalizeWhatsAppMessage(
                "bali",
                world.customerHandle,
                "I accept",
                offerId
            );
            const outcome = await applyInboundProviderDecision(client, message, idemKey("inbound"));
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.code).toBe("UNAUTHORIZED");
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_DISPATCHED");
        });
    });

    it("binds only when every authoritative condition is satisfied", async () => {
        await withTransaction(pool, async (client) => {
            const { world, requestId, offerId } = await dispatchedWorld(client);
            const registry = new CognitionRegistry().register(deterministicIntentAdapter);
            const cognition = await runCognition(registry, {
                taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
                marketId: "bali",
                text: "I accept"
            });

            const message = normalizeWhatsAppMessage(
                "bali",
                world.providerHandle,
                "I accept",
                offerId
            );
            const outcome = await applyInboundProviderDecision(
                client,
                message,
                idemKey("inbound"),
                cognition
            );
            expect(outcome.ok).toBe(true);
            if (outcome.ok) {
                expect(outcome.value.requestState).toBe("PROVIDER_ACCEPTED");
                // Cognition rode along as advisory context and bound nothing.
                expect(outcome.value.cognitionAdvisory.consulted).toBe(true);
                expect(outcome.value.cognitionAdvisory.wasBinding).toBe(false);
            }
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_ACCEPTED");
        });
    });

    it("ZERO-LLM: the identical flow succeeds with no cognition available at all", async () => {
        await withTransaction(pool, async (client) => {
            const { world, requestId, offerId } = await dispatchedWorld(client);

            const emptyRegistry = new CognitionRegistry();
            const cognition = await runCognition(emptyRegistry, {
                taskType: "INBOUND_OPERATIONAL_INTENT_CLASSIFICATION",
                marketId: "bali",
                text: "I accept"
            });
            expect(cognition.available).toBe(false);

            const message = normalizeWhatsAppMessage(
                "bali",
                world.providerHandle,
                "I accept",
                offerId
            );
            const outcome = await applyInboundProviderDecision(
                client,
                message,
                idemKey("inbound"),
                cognition
            );
            expect(outcome.ok).toBe(true);
            if (outcome.ok) {
                expect(outcome.value.cognitionAdvisory.consulted).toBe(false);
                expect(outcome.value.requestState).toBe("PROVIDER_ACCEPTED");
            }
            expect((await loadRequest(client, requestId))!.state).toBe("PROVIDER_ACCEPTED");
        });
    });

    it("ZERO-LLM: cognition is not even required as a parameter", async () => {
        await withTransaction(pool, async (client) => {
            const { world, offerId, requestId } = await dispatchedWorld(client);
            const message = normalizeWhatsAppMessage(
                "bali",
                world.providerHandle,
                "decline",
                offerId
            );
            const outcome = await applyInboundProviderDecision(client, message, idemKey("inbound"));
            expect(outcome.ok).toBe(true);
            // Decline releases the request; it never becomes a request state.
            expect((await loadRequest(client, requestId))!.state).toBe("PENDING_ACCEPTANCE");
        });
    });
});
