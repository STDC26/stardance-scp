// G3-E08 Freshline Mobile Proof · G3-E09 Synthetic InStore Proof
// G3-E10 Hybrid Topology Neutrality
//
// The three suites deliberately call the SAME four kernel entry points —
// evaluateServiceCommerce, createSellableOffer, commitOffer, loadOffer. If
// topology required a Core fork, that would be visible here as a different code
// path per suite. It is not.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getKernelPool,
    resetKernel,
    seedMobileWorld,
    seedInStoreWorld,
    seedHybridWorld,
    localSlot,
    idem
} from "./kernelTestDb";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import { createSellableOffer, loadOffer } from "../../src/kernel/offer";
import { commitOffer } from "../../src/kernel/commit";
import { holdsForOffer } from "../../src/core/capacity/capacity";
import { loadRequest, loadCurrentVersion } from "../../src/core/request/serviceRequest";
import { SYSTEM_ACTOR } from "../../src/core/types";
import { loadMarketConfig } from "../../src/config/marketConfig";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G3-E08 — Freshline Bali Mobile proof", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("sells and commits the normal mobile path end to end", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);

        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("mobile"),
                actor: SYSTEM_ACTOR
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        expect(offer.topology).toBe("MOBILE");
        expect(offer.locationId).toBeNull();
        expect(offer.currencyCode).toBe("IDR");

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;

        await withTransaction(pool, async (client) => {
            const request = await loadRequest(client, committed.value.requestId);
            expect(request!.state).toBe("PENDING_ACCEPTANCE");
            const holds = await holdsForOffer(client, offer.offerId);
            expect(holds).toHaveLength(1); // provider only — mobile needs no room
            expect(holds[0]!.resourceKey).toBe(`PROVIDER:${w.providerId}`);
            expect(holds[0]!.state).toBe("CONSUMED");
        });
    });

    it("composes service + add-on duration and price", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 13),
                serviceAreaKey: w.serviceAreaKey,
                addonIds: [w.addonId],
                idempotencyKey: idem("addon"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });
        expect(offer.durationMinutes).toBe(85);
        expect(offer.priceMinorUnits).toBe(300000);
        expect(offer.endTime.getTime() - offer.startTime.getTime()).toBe(85 * 60_000);
    });

    it("refuses an unavailable provider window", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            await client.query(`UPDATE core_capacity_window SET active = FALSE`);
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                serviceAreaKey: w.serviceAreaKey
            });
            expect(evaluated.ok && evaluated.value.reasonCode).toBe("PROVIDER_UNAVAILABLE");
        });
    });

    it("refuses a capacity collision and refuses a commit on an expired hold", async () => {
        const w = await withTransaction(pool, (c) => seedMobileWorld(c));
        const start = localSlot("bali", 3, 14);

        const first = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("first"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        await withTransaction(pool, async (client) => {
            const collision = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("collision"),
                actor: SYSTEM_ACTOR
            });
            expect(collision.ok).toBe(false);
            if (!collision.ok) {
                expect(["CAPACITY_UNAVAILABLE", "CAPACITY_CONFLICT"]).toContain(
                    collision.refusal.reasonCode
                );
            }
        });

        await pool.query(
            `UPDATE core_capacity_hold SET expires_at = now() - interval '1 minute' WHERE offer_id = $1`,
            [first.offerId]
        );
        const expiredCommit = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: first.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(expiredCommit.ok).toBe(false);
        if (!expiredCommit.ok) expect(expiredCommit.reasonCode).toBe("CAPACITY_HOLD_EXPIRED");
    });
});

d("G3-E09 — synthetic Northbeam Saigon InStore proof", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("sells and commits an InStore booking at a physical location", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 14);

        const offer = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                idempotencyKey: idem("instore"),
                actor: SYSTEM_ACTOR
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        expect(offer.topology).toBe("INSTORE");
        expect(offer.locationId).toBe(w.locationId);
        expect(offer.currencyCode).toBe("VND");
        expect(offer.priceMinorUnits).toBe(180000);
        expect(offer.durationMinutes).toBe(30);
        expect(offer.tenantId).toBe("northbeam");

        const committed = await withTransaction(pool, (client) =>
            commitOffer(client, {
                offerId: offer.offerId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("commit")
            })
        );
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;

        const version = await withTransaction(pool, (c) =>
            loadCurrentVersion(c, committed.value.requestId)
        );
        expect(version!.priceMinorUnits).toBe(180000);
    });

    it("PROVIDER CONFLICT: the same barber cannot be double-booked", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 14);

        await withTransaction(pool, async (client) => {
            const first = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId,
                idempotencyKey: idem("A1"),
                actor: SYSTEM_ACTOR
            });
            expect(first.ok).toBe(true);
        });

        await withTransaction(pool, async (client) => {
            const conflict = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId
            });
            expect(conflict.ok && conflict.value.reasonCode).toBe("CAPACITY_UNAVAILABLE");

            // The other barber is still free — the conflict is provider-scoped.
            const other = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerBId
            });
            expect(other.ok && other.value.outcome).toBe("SELLABLE");
        });
    });

    it("SHARED RESOURCE CONFLICT: one chair cannot serve two barbers at once", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 12);

        await withTransaction(pool, async (client) => {
            const first = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.colourServiceId, // requires CHAIR
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId,
                idempotencyKey: idem("colourA"),
                actor: SYSTEM_ACTOR
            });
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            // Two holds: the barber AND the chair.
            const holds = await holdsForOffer(client, first.offer.offerId);
            expect(holds).toHaveLength(2);
            expect(holds.map((h) => h.resourceKey).sort()).toEqual(
                [`PROVIDER:${w.providerAId}`, `RESOURCE:${w.chairResourceId}`].sort()
            );
        });

        await withTransaction(pool, async (client) => {
            // Barber B is free, but the only chair is not.
            const blocked = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.colourServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerBId
            });
            expect(blocked.ok && blocked.value.reasonCode).toBe("REQUIRED_RESOURCE_UNAVAILABLE");
        });
    });

    it("LOCATION CLOSED is narrower than business hours and refuses distinctly", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 14);
        const timezone = loadMarketConfig("saigon").timezone;
        const weekday = DateTime.fromJSDate(start).setZone(timezone).weekday % 7;

        // The market is open until 20:30; this location closes at noon that day.
        await pool.query(
            `UPDATE core_location_hours SET close_minute = 720
              WHERE location_id = $1 AND weekday = $2`,
            [w.locationId, weekday]
        );

        await withTransaction(pool, async (client) => {
            const evaluated = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId
            });
            expect(evaluated.ok && evaluated.value.reasonCode).toBe("LOCATION_CLOSED");
        });
    });

    it("ABUTTING INTERVALS succeed — back-to-back is not an overlap", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 14);
        const next = new Date(start.getTime() + 30 * 60_000); // cut = 30m, 0 buffer

        await withTransaction(pool, async (client) => {
            const first = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId,
                idempotencyKey: idem("slot1"),
                actor: SYSTEM_ACTOR
            });
            expect(first.ok).toBe(true);

            const abutting = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.cutServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: next,
                locationId: w.locationId,
                preferredProviderId: w.providerAId,
                idempotencyKey: idem("slot2"),
                actor: SYSTEM_ACTOR
            });
            expect(abutting.ok).toBe(true);
        });
    });

    it("offers a deterministic alternative time when the preferred slot is taken", async () => {
        const w = await withTransaction(pool, (c) => seedInStoreWorld(c));
        const start = localSlot("saigon", 3, 14);

        await withTransaction(pool, async (client) => {
            await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.colourServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId,
                idempotencyKey: idem("taken"),
                actor: SYSTEM_ACTOR
            });
        });

        await withTransaction(pool, async (client) => {
            const contested = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.colourServiceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: start,
                locationId: w.locationId,
                preferredProviderId: w.providerAId
            });
            expect(contested.ok).toBe(true);
            if (!contested.ok) return;
            expect(contested.value.outcome).toBe("REQUIRES_ALTERNATIVE");
            expect(contested.value.alternatives.length).toBeGreaterThan(0);
            for (const alternative of contested.value.alternatives) {
                expect(new Date(alternative.startTime).getTime()).toBeGreaterThan(start.getTime());
            }
        });
    });
});

d("G3-E10 — Hybrid topology neutrality", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getKernelPool();
        await resetKernel(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("sells the SAME service both MOBILE and INSTORE under one configuration", async () => {
        const w = await withTransaction(pool, (c) => seedHybridWorld(c));

        const mobile = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("penang", 3, 10),
                serviceAreaKey: w.serviceAreaKey,
                idempotencyKey: idem("hybrid-mobile"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        const instore = await withTransaction(pool, async (client) => {
            const outcome = await createSellableOffer(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("penang", 3, 15),
                locationId: w.locationId,
                idempotencyKey: idem("hybrid-instore"),
                actor: SYSTEM_ACTOR
            });
            if (!outcome.ok) throw new Error(outcome.refusal.reasonCode);
            return outcome.offer;
        });

        // Same aggregate, same states, same commercial contract — the only
        // difference is which constraints applied.
        expect(mobile.topology).toBe("MOBILE");
        expect(instore.topology).toBe("INSTORE");
        expect(mobile.locationId).toBeNull();
        expect(instore.locationId).toBe(w.locationId);
        expect(mobile.currencyCode).toBe(instore.currencyCode);
        expect(mobile.durationMinutes).toBe(instore.durationMinutes);
        expect(mobile.state).toBe("ACTIVE");
        expect(instore.state).toBe("ACTIVE");

        // Both commit through the identical contract into the identical target.
        for (const offer of [mobile, instore]) {
            const committed = await withTransaction(pool, (client) =>
                commitOffer(client, {
                    offerId: offer.offerId,
                    actorIdentityId: w.customerIdentityId,
                    idempotencyKey: idem("commit")
                })
            );
            expect(committed.ok).toBe(true);
            if (!committed.ok) continue;
            const request = await withTransaction(pool, (c) =>
                loadRequest(c, committed.value.requestId)
            );
            expect(request!.state).toBe("PENDING_ACCEPTANCE");
            const reloaded = await withTransaction(pool, (c) => loadOffer(c, offer.offerId));
            expect(reloaded!.state).toBe("COMMITTED");
        }
    });

    it("still applies topology-specific constraints inside the hybrid market", async () => {
        const w = await withTransaction(pool, (c) => seedHybridWorld(c));

        await withTransaction(pool, async (client) => {
            // INSTORE without a location is refused even though the market
            // supports INSTORE.
            const noLocation = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "INSTORE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("penang", 3, 12),
                locationId: null
            });
            expect(noLocation.ok && noLocation.value.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");

            // MOBILE without a serviceable area is refused for the same reason
            // code but a different constraint.
            const noArea = await evaluateServiceCommerce(client, {
                marketId: w.marketId,
                topology: "MOBILE",
                serviceId: w.serviceId,
                customerIdentityId: w.customerIdentityId,
                requestedStart: localSlot("penang", 3, 12),
                serviceAreaKey: "NOT_A_REAL_AREA"
            });
            expect(noArea.ok && noArea.value.reasonCode).toBe("LOCATION_NOT_SERVICEABLE");
        });
    });

    it("a MOBILE-only market refuses INSTORE, proving topology is configured not assumed", async () => {
        await withTransaction(pool, async (client) => {
            const mobileOnly = await seedMobileWorld(client);
            const refused = await evaluateServiceCommerce(client, {
                marketId: mobileOnly.marketId, // bali: supported = [MOBILE]
                topology: "INSTORE",
                serviceId: mobileOnly.serviceId,
                customerIdentityId: mobileOnly.customerIdentityId,
                requestedStart: localSlot("bali", 3, 14),
                locationId: null
            });
            expect(refused.ok && refused.value.reasonCode).toBe("TOPOLOGY_NOT_SUPPORTED");
        });
    });
});
