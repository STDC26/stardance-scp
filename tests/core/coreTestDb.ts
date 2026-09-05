// Shared fixture builder for the G2 Core Foundation integration suites.
// Creates a complete, minimal governed world: an owner, a provider (with its
// identity and an approved supply status), a customer, a priced service, and a
// declared availability window.

import type { Pool, PoolClient } from "pg";
import { createPool } from "../../src/db/pool";

export function getCorePool(): Pool {
    return createPool({ database: process.env["PGDATABASE"] ?? "freshline_msos_test" });
}

export async function resetCore(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE core_event, core_fulfillment, core_customer_confirmation, core_assignment,
                 core_dispatch_offer, core_amendment, core_capacity_hold, core_capacity_window,
                 core_service_request_version, core_service_request,
                 core_service_price_version, core_service_addon, core_service,
                 core_provider_alias, core_provider, core_identity_role, core_identity
        RESTART IDENTITY CASCADE
    `);
}

export interface CoreWorld {
    marketId: string;
    ownerIdentityId: string;
    providerIdentityId: string;
    providerId: string;
    customerIdentityId: string;
    serviceId: string;
    addonId: string;
    priceVersionId: string;
    providerHandle: string;
    customerHandle: string;
}

let seq = 0;

export async function seedWorld(
    client: PoolClient,
    marketId = "bali",
    options: { basePriceMinorUnits?: number; bufferMinutes?: number } = {}
): Promise<CoreWorld> {
    seq += 1;
    const providerHandle = `+6281000${String(seq).padStart(4, "0")}`;
    const customerHandle = `+6281900${String(seq).padStart(4, "0")}`;

    const owner = await client.query<{ identity_id: string }>(
        `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Owner')
         RETURNING identity_id`,
        [marketId]
    );
    const ownerIdentityId = owner.rows[0]!.identity_id;
    await client.query(
        `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'OWNER')`,
        [ownerIdentityId, marketId]
    );

    const providerIdentity = await client.query<{ identity_id: string }>(
        `INSERT INTO core_identity (market_id, display_name, channel_handle)
         VALUES ($1, 'Provider', $2) RETURNING identity_id`,
        [marketId, providerHandle]
    );
    const providerIdentityId = providerIdentity.rows[0]!.identity_id;
    await client.query(
        `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'PROVIDER')`,
        [providerIdentityId, marketId]
    );

    const customer = await client.query<{ identity_id: string }>(
        `INSERT INTO core_identity (market_id, display_name, channel_handle)
         VALUES ($1, 'Customer', $2) RETURNING identity_id`,
        [marketId, customerHandle]
    );
    const customerIdentityId = customer.rows[0]!.identity_id;
    await client.query(
        `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'CUSTOMER')`,
        [customerIdentityId, marketId]
    );

    const provider = await client.query<{ provider_id: string }>(
        `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
         VALUES ($1, $2, 'Provider', 'APPROVED') RETURNING provider_id`,
        [marketId, providerIdentityId]
    );
    const providerId = provider.rows[0]!.provider_id;

    const service = await client.query<{ service_id: string }>(
        `INSERT INTO core_service (market_id, name, base_duration_minutes)
         VALUES ($1, 'Massage', 60) RETURNING service_id`,
        [marketId]
    );
    const serviceId = service.rows[0]!.service_id;

    const addon = await client.query<{ addon_id: string }>(
        `INSERT INTO core_service_addon (service_id, name, extra_duration_minutes, price_minor_units)
         VALUES ($1, 'Hot stones', 15, 50000) RETURNING addon_id`,
        [serviceId]
    );
    const addonId = addon.rows[0]!.addon_id;

    const price = await client.query<{ price_version_id: string }>(
        `INSERT INTO core_service_price_version
            (service_id, price_minor_units, currency_code, buffer_minutes)
         VALUES ($1, $2, 'IDR', $3) RETURNING price_version_id`,
        [serviceId, options.basePriceMinorUnits ?? 250000, options.bufferMinutes ?? 10]
    );
    const priceVersionId = price.rows[0]!.price_version_id;

    // Wide declared availability so capacity tests exercise overlap, not window
    // membership.
    await client.query(
        `INSERT INTO core_capacity_window (market_id, provider_id, location_id, during)
         VALUES ($1, $2, 'PRIMARY', tstzrange(now() - interval '1 day', now() + interval '30 days', '[)'))`,
        [marketId, providerId]
    );

    return {
        marketId,
        ownerIdentityId,
        providerIdentityId,
        providerId,
        customerIdentityId,
        serviceId,
        addonId,
        priceVersionId,
        providerHandle,
        customerHandle
    };
}

/** Deterministic future window helper. */
export function windowStartingInHours(hours: number): Date {
    return new Date(Date.now() + hours * 3_600_000);
}

let keySeq = 0;
export function idemKey(prefix: string): string {
    keySeq += 1;
    return `${prefix}:${keySeq}`;
}
