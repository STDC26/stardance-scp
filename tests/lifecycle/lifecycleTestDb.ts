// Fixtures for the G4 operational lifecycle proofs.
//
// Every world is driven to PENDING_ACCEPTANCE through the REAL G3 kernel
// (evaluate -> offer -> commit), not by inserting a request directly. That is
// deliberate: it proves G4 consumes the canonical G3 entry state rather than
// assuming it.

import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getKernelPool,
    resetKernel,
    seedMobileWorld,
    seedInStoreWorld,
    seedHybridWorld,
    localSlot,
    idem,
    type MobileWorld,
    type InStoreWorld,
    type HybridWorld
} from "../kernel/kernelTestDb";
import { createSellableOffer } from "../../src/kernel/offer";
import { commitOffer } from "../../src/kernel/commit";
import { SYSTEM_ACTOR } from "../../src/core/types";

export { localSlot, idem, resetKernel as resetLifecycle, getKernelPool as getLifecyclePool };
export type { MobileWorld, InStoreWorld, HybridWorld };

/** Gives a provider and a customer a verified inbound channel handle. */
export async function attachChannelHandles(
    client: PoolClient,
    marketId: string,
    identities: { providerIdentityId?: string; customerIdentityId?: string }
): Promise<{ providerHandle: string; customerHandle: string }> {
    const stamp = Math.abs(hash(`${marketId}:${identities.providerIdentityId ?? ""}`)) % 100000;
    const providerHandle = `+chan-p-${stamp}`;
    const customerHandle = `+chan-c-${stamp}`;
    if (identities.providerIdentityId) {
        await client.query(`UPDATE core_identity SET channel_handle = $2 WHERE identity_id = $1`, [
            identities.providerIdentityId,
            providerHandle
        ]);
    }
    if (identities.customerIdentityId) {
        await client.query(`UPDATE core_identity SET channel_handle = $2 WHERE identity_id = $1`, [
            identities.customerIdentityId,
            customerHandle
        ]);
    }
    return { providerHandle, customerHandle };
}

function hash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) {
        h = (h * 31 + value.charCodeAt(i)) | 0;
    }
    return h;
}

export interface CommittedMobile extends MobileWorld {
    requestId: string;
    offerId: string;
    providerHandle: string;
    customerHandle: string;
}

/** Freshline Bali MOBILE world with a request already at PENDING_ACCEPTANCE. */
export async function seedCommittedMobile(
    pool: Pool,
    hoursAhead = 30
): Promise<CommittedMobile> {
    return withTransaction(pool, async (client) => {
        const world = await seedMobileWorld(client);
        const handles = await attachChannelHandles(client, world.marketId, {
            providerIdentityId: world.providerIdentityId,
            customerIdentityId: world.customerIdentityId
        });

        const offered = await createSellableOffer(client, {
            marketId: world.marketId,
            topology: "MOBILE",
            serviceId: world.serviceId,
            customerIdentityId: world.customerIdentityId,
            requestedStart: localSlot("bali", 3, 14 + (hoursAhead % 3)),
            serviceAreaKey: world.serviceAreaKey,
            idempotencyKey: idem("g4-offer"),
            actor: SYSTEM_ACTOR
        });
        if (!offered.ok) throw new Error(`offer refused: ${offered.refusal.reasonCode}`);

        const committed = await commitOffer(client, {
            offerId: offered.offer.offerId,
            actorIdentityId: world.customerIdentityId,
            idempotencyKey: idem("g4-commit")
        });
        if (!committed.ok) throw new Error(`commit refused: ${committed.reasonCode}`);

        return {
            ...world,
            requestId: committed.value.requestId,
            offerId: offered.offer.offerId,
            providerHandle: handles.providerHandle,
            customerHandle: handles.customerHandle
        };
    });
}

export interface CommittedInStore extends InStoreWorld {
    requestId: string;
    offerId: string;
    /** An owner identity, since the InStore fixture has none by default. */
    ownerIdentityId: string;
}

/** Northbeam Saigon INSTORE world at PENDING_ACCEPTANCE. */
export async function seedCommittedInStore(pool: Pool): Promise<CommittedInStore> {
    return withTransaction(pool, async (client) => {
        const world = await seedInStoreWorld(client);

        const owner = await client.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Saigon Owner')
             RETURNING identity_id`,
            [world.marketId]
        );
        const ownerIdentityId = owner.rows[0]!.identity_id;
        await client.query(
            `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'OWNER')`,
            [ownerIdentityId, world.marketId]
        );

        const offered = await createSellableOffer(client, {
            marketId: world.marketId,
            topology: "INSTORE",
            serviceId: world.colourServiceId,
            customerIdentityId: world.customerIdentityId,
            requestedStart: localSlot("saigon", 3, 13),
            locationId: world.locationId,
            preferredProviderId: world.providerAId,
            idempotencyKey: idem("g4-instore-offer"),
            actor: SYSTEM_ACTOR
        });
        if (!offered.ok) throw new Error(`offer refused: ${offered.refusal.reasonCode}`);

        const committed = await commitOffer(client, {
            offerId: offered.offer.offerId,
            actorIdentityId: world.customerIdentityId,
            idempotencyKey: idem("g4-instore-commit")
        });
        if (!committed.ok) throw new Error(`commit refused: ${committed.reasonCode}`);

        return {
            ...world,
            ownerIdentityId,
            requestId: committed.value.requestId,
            offerId: offered.offer.offerId
        };
    });
}

export interface CommittedHybrid extends HybridWorld {
    ownerIdentityId: string;
    mobileRequestId: string;
    instoreRequestId: string;
}

/** Penang HYBRID world with one MOBILE and one INSTORE request. */
export async function seedCommittedHybrid(pool: Pool): Promise<CommittedHybrid> {
    return withTransaction(pool, async (client) => {
        const world = await seedHybridWorld(client);

        const owner = await client.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Penang Owner')
             RETURNING identity_id`,
            [world.marketId]
        );
        const ownerIdentityId = owner.rows[0]!.identity_id;
        await client.query(
            `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'OWNER')`,
            [ownerIdentityId, world.marketId]
        );

        const commitOne = async (
            topology: "MOBILE" | "INSTORE",
            hour: number
        ): Promise<string> => {
            const offered = await createSellableOffer(client, {
                marketId: world.marketId,
                topology,
                serviceId: world.serviceId,
                customerIdentityId: world.customerIdentityId,
                requestedStart: localSlot("penang", 3, hour),
                ...(topology === "INSTORE"
                    ? { locationId: world.locationId }
                    : { serviceAreaKey: world.serviceAreaKey }),
                idempotencyKey: idem(`g4-hybrid-${topology}`),
                actor: SYSTEM_ACTOR
            });
            if (!offered.ok) throw new Error(`offer refused: ${offered.refusal.reasonCode}`);
            const committed = await commitOffer(client, {
                offerId: offered.offer.offerId,
                actorIdentityId: world.customerIdentityId,
                idempotencyKey: idem(`g4-hybrid-commit-${topology}`)
            });
            if (!committed.ok) throw new Error(`commit refused: ${committed.reasonCode}`);
            return committed.value.requestId;
        };

        return {
            ...world,
            ownerIdentityId,
            mobileRequestId: await commitOne("MOBILE", 10),
            instoreRequestId: await commitOne("INSTORE", 15)
        };
    });
}
