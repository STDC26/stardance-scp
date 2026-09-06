// G3-E02 Eligibility Determinism · G3-E03 Configuration Isolation
// G3-E04 Capacity Correctness (evaluation-side)

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getKernelPool,
    resetKernel,
    seedMobileWorld,
    seedInStoreWorld,
    localSlot,
    idem
} from "./kernelTestDb";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import { createSellableOffer } from "../../src/kernel/offer";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G3-E02 — eligibility determinism", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("same versioned inputs and effective time produce the same decision", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const start = localSlot("bali", 3, 14);
            const effectiveAt = new Date(start.getTime() - 24 * 3_600_000);
            const request = {
                marketId: w.marketId,
                topology: "MOBILE" as const,
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                effectiveAt
            };

            const first = await evaluateServiceCommerce(client, request);
            const second = await evaluateServiceCommerce(client, request);
            expect(first.ok && second.ok).toBe(true);
            if (!first.ok || !second.ok) return;

            expect(first.value.outcome).toBe("SELLABLE");
            expect(second.value.outcome).toBe(first.value.outcome);
            expect(second.value.reasonCode).toBe(first.value.reasonCode);
            expect(second.value.terms!.providerId).toBe(first.value.terms!.providerId);
            expect(second.value.terms!.priceMinorUnits).toBe(first.value.terms!.priceMinorUnits);
            expect(second.value.terms!.durationMinutes).toBe(first.value.terms!.durationMinutes);
            expect(second.value.terms!.endTime.getTime()).toBe(first.value.terms!.endTime.getTime());
            // Two distinct decision records, same decision.
            expect(second.value.evaluationId).not.toBe(first.value.evaluationId);
        });
    });

    it("CLIENT SUBSTITUTION: asserted price and duration never bind", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const start = localSlot("bali", 3, 14);

            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                clientAsserted: { priceMinorUnits: 1, durationMinutes: 5 }
            });
            expect(evaluated.ok).toBe(true);
            if (!evaluated.ok) return;

            // Canonical values win: 250000 IDR, 60 base + 10 buffer.
            expect(evaluated.value.terms!.priceMinorUnits).toBe(250000);
            expect(evaluated.value.terms!.durationMinutes).toBe(70);

            const stored = await client.query<{ inputs_snapshot: Record<string, unknown> }>(
                `SELECT inputs_snapshot FROM core_commerce_evaluation WHERE evaluation_id = $1`,
                [evaluated.value.evaluationId]
            );
            // The claim is recorded as provenance, and recorded as not honoured.
            expect(stored.rows[0]!.inputs_snapshot["clientAssertionsHonoured"]).toBe(false);
            expect(stored.rows[0]!.inputs_snapshot["clientAsserted"]).toEqual({
                priceMinorUnits: 1,
                durationMinutes: 5
            });
        });
    });

    it("composes duration as base + add-ons + buffer, never from the client", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 13),
                serviceAreaKey: w.serviceAreaKey,
                addonIds: [w.addonId]
            });
            expect(evaluated.ok).toBe(true);
            if (!evaluated.ok) return;
            const basis = evaluated.value.terms!.durationBasis;
            expect(basis).toEqual({
                baseDurationMinutes: 60,
                addonDurationMinutes: 15,
                bufferMinutes: 10,
                totalMinutes: 85
            });
            expect(evaluated.value.terms!.priceMinorUnits).toBe(300000);
        });
    });

    it("returns machine-readable reason codes, not prose", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);

            const wrongTopology = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                locationId: null
            });
            expect(wrongTopology.ok).toBe(true);
            if (wrongTopology.ok) {
                expect(wrongTopology.value.reasonCode).toBe("TOPOLOGY_NOT_SUPPORTED");
            }

            const unserviceable = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: "NUSA_PENIDA"
            });
            expect(unserviceable.ok).toBe(true);
            if (unserviceable.ok) {
                expect(unserviceable.value.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");
            }

            const tooSoon = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: new Date(Date.now() + 5 * 60_000),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(tooSoon.ok).toBe(true);
            if (tooSoon.ok) {
                expect(tooSoon.value.reasonCode).toBe("OUTSIDE_BOOKABLE_WINDOW");
            }

            const tooFar = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 200, 14),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(tooFar.ok).toBe(true);
            if (tooFar.ok) {
                expect(tooFar.value.reasonCode).toBe("OUTSIDE_BOOKABLE_WINDOW");
            }

            const afterHours = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 4),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(afterHours.ok).toBe(true);
            if (afterHours.ok) {
                expect(afterHours.value.reasonCode).toBe("BUSINESS_CLOSED");
            }
        });
    });

    it("refuses an inactive service and an unapproved provider distinctly", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const start = localSlot("bali", 3, 14);
            const base = {
                marketId: w.marketId,
                topology: "MOBILE" as const,
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey
            };

            await client.query(
                `UPDATE core_provider SET supply_status = 'SUBMITTED' WHERE provider_id = $1`,
                [w.providerId]
            );
            const noProvider = await evaluateServiceCommerce(client, base);
            expect(noProvider.ok && noProvider.value.reasonCode).toBe("NO_ELIGIBLE_PROVIDER");

            await client.query(
                `UPDATE core_provider SET supply_status = 'APPROVED' WHERE provider_id = $1`,
                [w.providerId]
            );
            await client.query(`UPDATE core_service SET active = FALSE WHERE service_id = $1`, [
                w.serviceId
            ]);
            const inactive = await evaluateServiceCommerce(client, base);
            expect(inactive.ok && inactive.value.reasonCode).toBe("SERVICE_NOT_ACTIVE");
        });
    });

    it("refuses a customer identity that lacks the CUSTOMER role", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                // The provider's identity, not the customer's.
                customerIdentityId: w.providerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(evaluated.ok && evaluated.value.reasonCode).toBe("CUSTOMER_NOT_ELIGIBLE");
        });
    });

    it("offers bounded deterministic alternatives when capacity is taken", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 4, 14);

        await withTransaction(pool, async (client) => {
            const taken = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("hold-slot"),
                actor: SYSTEM_ACTOR
            });
            expect(taken.ok).toBe(true);
        });

        await withTransaction(pool, async (client) => {
            const contested = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey
            });
            expect(contested.ok).toBe(true);
            if (!contested.ok) return;

            expect(contested.value.outcome).toBe("REQUIRES_ALTERNATIVE");
            expect(contested.value.reasonCode).toBe("CAPACITY_UNAVAILABLE");
            expect(contested.value.alternatives.length).toBeGreaterThan(0);
            expect(contested.value.alternatives.length).toBeLessThanOrEqual(3);

            // Bounded and ordered: the first alternative is the nearest offset
            // that actually cleared the whole rule set.
            const first = contested.value.alternatives[0]!;
            expect(new Date(first.startTime).getTime()).toBeGreaterThan(start.getTime());

            // Deterministic: the same probe returns the same ladder.
            const again = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey
            });
            expect(again.ok && again.value.alternatives).toEqual(contested.value.alternatives);
        });
    });
});

d("G3-E03 — configuration isolation across tenants, markets and topologies", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("the same kernel path yields different canonical terms per market", async () => {
        await withTransaction(pool, async (client) => {
            const mobile = await seedMobileWorld(client);
            const instore = await seedInStoreWorld(client);

            const bali = await evaluateServiceCommerce(client, {
                marketId: mobile.marketId,
                topology: "MOBILE",
                serviceId: mobile.serviceId,
                customerIdentityId: mobile.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: mobile.serviceAreaKey
            });
            const saigon = await evaluateServiceCommerce(client, {
                marketId: instore.marketId,
                topology: "INSTORE",
                serviceId: instore.cutServiceId,
                customerIdentityId: instore.customerIdentityId,
                requestedStart: localSlot("saigon", 3, 14),
                locationId: instore.locationId
            });

            expect(bali.ok && saigon.ok).toBe(true);
            if (!bali.ok || !saigon.ok) return;
            expect(bali.value.outcome).toBe("SELLABLE");
            expect(saigon.value.outcome).toBe("SELLABLE");

            expect(bali.value.tenantId).toBe("freshline");
            expect(saigon.value.tenantId).toBe("northbeam");
            expect(bali.value.terms!.currencyCode).toBe("IDR");
            expect(saigon.value.terms!.currencyCode).toBe("VND");
            // 60 + 10 buffer vs 30 + 0 buffer, all from configuration and catalogue.
            expect(bali.value.terms!.durationMinutes).toBe(70);
            expect(saigon.value.terms!.durationMinutes).toBe(30);
        });
    });

    it("refuses a service reached from the wrong market", async () => {
        await withTransaction(pool, async (client) => {
            const mobile = await seedMobileWorld(client);
            const instore = await seedInStoreWorld(client);

            const leak = await evaluateServiceCommerce(client, {
                marketId: instore.marketId,
                topology: "INSTORE",
                // A Bali service addressed through the Saigon market.
                serviceId: mobile.serviceId,
                customerIdentityId: instore.customerIdentityId,
                requestedStart: localSlot("saigon", 3, 14),
                locationId: instore.locationId
            });
            expect(leak.ok && leak.value.reasonCode).toBe("SERVICE_NOT_AVAILABLE_IN_MARKET");
        });
    });

    it("refuses a cross-tenant location", async () => {
        await withTransaction(pool, async (client) => {
            const instore = await seedInStoreWorld(client);
            // A location that belongs to the other tenant entirely.
            const foreign = await client.query<{ location_id: string }>(
                `INSERT INTO core_location (tenant_id, market_id, name, timezone)
                 VALUES ('freshline', 'saigon', 'Foreign', 'Asia/Ho_Chi_Minh')
                 RETURNING location_id`
            );
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: instore.marketId,
                topology: "INSTORE",
                serviceId: instore.cutServiceId,
                customerIdentityId: instore.customerIdentityId,
                requestedStart: localSlot("saigon", 3, 14),
                locationId: foreign.rows[0]!.location_id
            });
            expect(evaluated.ok && evaluated.value.reasonCode).toBe("TENANT_MISMATCH");
        });
    });

    it("persists configuration provenance with every decision", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(evaluated.ok).toBe(true);
            if (!evaluated.ok) return;

            const { rows } = await client.query<{
                config_snapshot: Record<string, unknown>;
                decision_snapshot: Record<string, unknown>;
            }>(
                `SELECT config_snapshot, decision_snapshot FROM core_commerce_evaluation
                  WHERE evaluation_id = $1`,
                [evaluated.value.evaluationId]
            );
            const config = rows[0]!.config_snapshot;
            expect(config["tenantId"]).toBe("freshline");
            expect(config["timezone"]).toBe("Asia/Makassar");
            expect(config["bookingWindow"]).toEqual({ minLeadMinutes: 60, maxAdvanceDays: 60 });
            expect(rows[0]!.decision_snapshot["outcome"]).toBe("SELLABLE");
        });
    });
});
