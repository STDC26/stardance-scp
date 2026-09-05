// G2-E09 — Versioned Amendment sub-record.
//
// The invariant under test throughout: "Existing commitment remains
// authoritative until a replacement is validly adopted." Every assertion about
// `current_version` is really an assertion about that rule.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, windowStartingInHours, idemKey } from "./coreTestDb";
import {
    createServiceRequest,
    loadCurrentVersion,
    loadRequest
} from "../../src/core/request/serviceRequest";
import {
    applyAmendment,
    proposeAmendment,
    rejectAmendment,
    validateAmendment
} from "../../src/core/request/amendment";
import { offerDispatch, respondToOffer } from "../../src/core/dispatch/dispatchOffer";
import { assignRequest, requestCustomerConfirmation } from "../../src/core/dispatch/assignment";
import { confirmBooking, activeConfirmation } from "../../src/core/confirmation/customerConfirmation";
import { holdCapacity } from "../../src/core/capacity/capacity";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** Drives a request all the way to CUSTOMER_CONFIRMED with committed capacity. */
async function confirmedBooking(pool: Pool, startHours = 48) {
    return withTransaction(pool, async (client) => {
        const world = await seedWorld(client);
        const startTime = windowStartingInHours(startHours);

        const created = await createServiceRequest(
            client,
            {
                marketId: world.marketId,
                customerIdentityId: world.customerIdentityId,
                serviceId: world.serviceId,
                startTime
            },
            SYSTEM_ACTOR,
            idemKey("create")
        );
        if (!created.ok) throw new Error(created.message);
        const requestId = created.value.requestId;

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
        if (!offered.ok) throw new Error(offered.message);

        const accepted = await respondToOffer(
            client,
            { offerId: offered.value.offerId, identityId: world.providerIdentityId, decision: "ACCEPT" },
            idemKey("accept")
        );
        if (!accepted.ok) throw new Error(accepted.message);

        const assigned = await assignRequest(
            client,
            { requestId, offerId: offered.value.offerId, identityId: world.ownerIdentityId },
            idemKey("assign")
        );
        if (!assigned.ok) throw new Error(assigned.message);

        await requestCustomerConfirmation(client, requestId, world.ownerIdentityId, idemKey("present"));

        const confirmed = await confirmBooking(
            client,
            { requestId, identityId: world.customerIdentityId, confirmedVersion: 1 },
            idemKey("confirm")
        );
        if (!confirmed.ok) throw new Error(confirmed.message);

        return { world, requestId, startTime, endTime: created.value.endTime };
    });
}

d("G2-E09 — Amendment", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("a proposed amendment does NOT disturb the authoritative commitment", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const before = await loadCurrentVersion(client, requestId);

            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(72),
                    reason: "customer wants a later slot"
                },
                idemKey("propose")
            );
            expect(proposed.ok).toBe(true);
            if (!proposed.ok) return;
            expect(proposed.value.state).toBe("PROPOSED");

            const after = await loadCurrentVersion(client, requestId);
            const request = await loadRequest(client, requestId);
            expect(after!.version).toBe(before!.version);
            expect(after!.startTime.getTime()).toBe(before!.startTime.getTime());
            expect(request!.state).toBe("CUSTOMER_CONFIRMED");
        });
    });

    it("validation writes a candidate version WITHOUT making it authoritative", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            expect(proposed.ok).toBe(true);
            if (!proposed.ok) return;

            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                { newStartTime: windowStartingInHours(72) },
                idemKey("validate")
            );
            expect(validated.ok).toBe(true);
            if (!validated.ok) return;

            expect(validated.value.candidateVersion).toBe(2);
            expect(validated.value.authoritativeVersion).toBe(1);
            expect(validated.value.requiresReconfirmation).toBe(true);

            // Version 2 exists as a row, but version 1 still governs.
            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);
        });
    });

    it("NO SILENT REPRICE: the price delta is reported, not quietly applied", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);

            // Adding a paid add-on changes the price.
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                { newAddonIds: [world.addonId] },
                idemKey("validate")
            );
            expect(validated.ok).toBe(true);
            if (!validated.ok) return;

            expect(validated.value.priceDeltaMinorUnits).toBe(50000);
            expect(validated.value.requiresReconfirmation).toBe(true);

            // The committed price is untouched while the amendment is open.
            const current = await loadCurrentVersion(client, requestId);
            expect(current!.priceMinorUnits).toBe(250000);
        });
    });

    it("adoption moves the authoritative version and forces reconfirmation", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                { newStartTime: windowStartingInHours(96) },
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);

            expect((await activeConfirmation(client, requestId))?.confirmedVersion).toBe(1);

            const applied = await applyAmendment(
                client,
                proposed.value.amendmentId,
                world.ownerIdentityId,
                idemKey("apply")
            );
            expect(applied.ok).toBe(true);
            if (!applied.ok) return;

            expect(applied.value.adoptedVersion).toBe(2);
            expect(applied.value.reconfirmationRequired).toBe(true);
            expect(applied.value.requestState).toBe("AWAITING_CUSTOMER_CONFIRMATION");

            // Prior consent no longer stands.
            expect(await activeConfirmation(client, requestId)).toBeNull();

            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(2);
        });
    });

    it("the customer can reconfirm the adopted version, and only that version", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                { newStartTime: windowStartingInHours(120) },
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);
            await applyAmendment(client, proposed.value.amendmentId, world.ownerIdentityId, idemKey("apply"));

            // Confirming the superseded version is refused.
            const stale = await confirmBooking(
                client,
                { requestId, identityId: world.customerIdentityId, confirmedVersion: 1 },
                idemKey("confirm")
            );
            expect(stale.ok).toBe(false);
            if (!stale.ok) expect(stale.code).toBe("STALE_STATE");

            const fresh = await confirmBooking(
                client,
                { requestId, identityId: world.customerIdentityId, confirmedVersion: 2 },
                idemKey("confirm")
            );
            expect(fresh.ok).toBe(true);
        });
    });

    it("a capacity collision on adoption leaves the committed version authoritative", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const blockedStart = windowStartingInHours(200);

        // Somebody else takes the window the amendment wants to move into.
        await withTransaction(pool, async (client) => {
            const blocked = await holdCapacity(
                client,
                {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    startTime: blockedStart,
                    endTime: new Date(blockedStart.getTime() + 4 * 3_600_000)
                },
                SYSTEM_ACTOR,
                idemKey("blocker")
            );
            expect(blocked.ok).toBe(true);
        });

        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                { newStartTime: blockedStart },
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);

            const applied = await applyAmendment(
                client,
                proposed.value.amendmentId,
                world.ownerIdentityId,
                idemKey("apply")
            );
            expect(applied.ok).toBe(false);
            if (!applied.ok) expect(applied.code).toBe("CAPACITY_CONFLICT");

            // Committed terms survived the failed adoption intact.
            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);
            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("CUSTOMER_CONFIRMED");
            expect((await activeConfirmation(client, requestId))?.confirmedVersion).toBe(1);
        });
    });

    it("permits only one open amendment per request", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const first = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            expect(first.ok).toBe(true);

            const second = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            expect(second.ok).toBe(false);
            if (!second.ok) expect(second.code).toBe("AMENDMENT_IN_FLIGHT");
        });
    });

    it("a rejected amendment frees the slot and changes nothing", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const first = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            if (!first.ok) throw new Error(first.message);

            const rejected = await rejectAmendment(
                client,
                first.value.amendmentId,
                world.ownerIdentityId,
                idemKey("reject")
            );
            expect(rejected.ok).toBe(true);

            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);

            const reopened = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId },
                idemKey("propose")
            );
            expect(reopened.ok).toBe(true);
        });
    });
});
