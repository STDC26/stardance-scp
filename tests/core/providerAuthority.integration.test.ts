// G2-E04 / G2-E05 — canonical Provider representation, legacy Contractor
// mapping, and scoped-role authority enforcement.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, idemKey } from "./coreTestDb";
import {
    approveProviderSupply,
    isDispatchable,
    loadProvider,
    registerLegacyContractorAlias,
    resolveLegacyContractorId
} from "../../src/core/provider/provider";
import {
    authorizeCustomerConfirmation,
    authorizeOwnerAssignment,
    authorizeProviderResponse
} from "../../src/core/identity/authority";
import { createServiceRequest } from "../../src/core/request/serviceRequest";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G2-E04/E05 — Provider aggregate and scoped authority", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("treats submitted supply as not dispatchable until explicitly approved", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const submitted = await client.query<{ provider_id: string }>(
                `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
                 VALUES ($1, $2, 'Second', 'SUBMITTED') RETURNING provider_id`,
                [world.marketId, world.ownerIdentityId]
            );
            const providerId = submitted.rows[0]!.provider_id;

            const before = await loadProvider(client, providerId);
            expect(before!.supplyStatus).toBe("SUBMITTED");
            expect(isDispatchable(before!)).toBe(false);

            const approved = await approveProviderSupply(
                client,
                providerId,
                SYSTEM_ACTOR,
                idemKey("approve")
            );
            expect(approved.ok).toBe(true);
            const after = await loadProvider(client, providerId);
            expect(isDispatchable(after!)).toBe(true);
        });
    });

    it("resolves a legacy contractor id to exactly one canonical Provider", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const legacyId = "11111111-2222-3333-4444-555555555555";

            const registered = await registerLegacyContractorAlias(
                client,
                world.providerId,
                legacyId,
                "G1 appointments.contractor_id"
            );
            expect(registered.ok).toBe(true);

            const resolved = await resolveLegacyContractorId(client, legacyId);
            expect(resolved?.providerId).toBe(world.providerId);
        });
    });

    it("refuses to let one legacy contractor id become a second source of truth", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const other = await client.query<{ provider_id: string }>(
                `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
                 VALUES ($1, $2, 'Other', 'APPROVED') RETURNING provider_id`,
                [world.marketId, world.ownerIdentityId]
            );
            const legacyId = "99999999-8888-7777-6666-555555555555";

            const first = await registerLegacyContractorAlias(client, world.providerId, legacyId);
            expect(first.ok).toBe(true);

            const second = await registerLegacyContractorAlias(
                client,
                other.rows[0]!.provider_id,
                legacyId
            );
            expect(second.ok).toBe(false);
            if (!second.ok) {
                expect(second.code).toBe("INVALID_TRANSITION");
            }
        });
    });

    it("keeps provider, owner and customer authority mutually non-transferable", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            const created = await createServiceRequest(
                client,
                {
                    marketId: world.marketId,
                    customerIdentityId: world.customerIdentityId,
                    serviceId: world.serviceId,
                    startTime: new Date(Date.now() + 3_600_000)
                },
                SYSTEM_ACTOR,
                idemKey("create")
            );
            expect(created.ok).toBe(true);
            if (!created.ok) return;
            const requestId = created.value.requestId;

            // Provider identity cannot assign.
            const providerAssign = await authorizeOwnerAssignment(
                client,
                world.providerIdentityId,
                world.marketId
            );
            expect(providerAssign.ok).toBe(false);

            // Owner cannot confirm on the customer's behalf.
            const ownerConfirm = await authorizeCustomerConfirmation(
                client,
                world.ownerIdentityId,
                world.marketId,
                requestId
            );
            expect(ownerConfirm.ok).toBe(false);

            // Customer cannot answer a dispatch offer.
            const customerRespond = await authorizeProviderResponse(
                client,
                world.customerIdentityId,
                world.marketId,
                world.providerId
            );
            expect(customerRespond.ok).toBe(false);

            // Each authority works only in its own scope.
            expect((await authorizeOwnerAssignment(client, world.ownerIdentityId, world.marketId)).ok).toBe(true);
            expect(
                (await authorizeCustomerConfirmation(client, world.customerIdentityId, world.marketId, requestId)).ok
            ).toBe(true);
            expect(
                (await authorizeProviderResponse(client, world.providerIdentityId, world.marketId, world.providerId)).ok
            ).toBe(true);
        });
    });

    it("refuses a PROVIDER who was not the provider on the offer", async () => {
        await withTransaction(pool, async (client) => {
            const world = await seedWorld(client);
            // A second, unrelated approved provider in the same market.
            const stranger = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Stranger')
                 RETURNING identity_id`,
                [world.marketId]
            );
            const strangerId = stranger.rows[0]!.identity_id;
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'PROVIDER')`,
                [strangerId, world.marketId]
            );

            const outcome = await authorizeProviderResponse(
                client,
                strangerId,
                world.marketId,
                world.providerId
            );
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.code).toBe("UNAUTHORIZED");
            }
        });
    });

    it("refuses authority across market boundaries", async () => {
        await withTransaction(pool, async (client) => {
            const bali = await seedWorld(client, "bali");
            const outcome = await authorizeOwnerAssignment(client, bali.ownerIdentityId, "bangkok");
            expect(outcome.ok).toBe(false);
        });
    });
});
