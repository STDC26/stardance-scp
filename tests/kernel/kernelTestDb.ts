// Fixtures for the G3 Service-Commerce Kernel proofs.
//
// Three worlds, all reached through the same kernel:
//   MOBILE   Freshline / Bali      tenant "freshline"
//   INSTORE  Northbeam / Saigon    tenant "northbeam", one location, two
//                                  providers, one SHARED chair
//   HYBRID   Freshline / Bangkok   both topologies under one configuration
//
// Nothing here is a Core literal: every market difference comes from
// config/<marketId>.market.json.

import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { createPool } from "../../src/db/pool";
import { loadMarketConfig, type MarketId } from "../../src/config/marketConfig";

export function getKernelPool(): Pool {
    return createPool({ database: process.env["PGDATABASE"] ?? "freshline_msos_test" });
}

export async function resetKernel(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE core_event, core_sellable_offer, core_commerce_evaluation,
                 core_fulfillment, core_customer_confirmation, core_assignment,
                 core_dispatch_offer, core_amendment, core_capacity_hold, core_capacity_window,
                 core_service_request_version, core_service_request,
                 core_service_resource_requirement, core_service_topology,
                 core_provider_location, core_provider_service,
                 core_resource, core_location_hours, core_location, core_service_area,
                 core_service_price_version, core_service_addon, core_service,
                 core_provider_alias, core_provider, core_identity_role, core_identity
        RESTART IDENTITY CASCADE
    `);
}

/**
 * A deterministic future instant at a given local hour in a market's timezone,
 * skipped forward past any weekend so INSTORE location hours (seeded Mon-Sat)
 * always apply.
 */
export function localSlot(marketId: MarketId, daysAhead: number, hour: number): Date {
    const tz = loadMarketConfig(marketId).timezone;
    let dt = DateTime.now()
        .setZone(tz)
        .plus({ days: daysAhead })
        .set({ hour, minute: 0, second: 0, millisecond: 0 });
    while (dt.weekday === 7) {
        dt = dt.plus({ days: 1 });
    }
    return dt.toJSDate();
}

let seq = 0;
// Fixture instances must be unique: several worlds can be seeded inside one
// test, and service-area keys carry a (tenant, market, area_key) unique index.
let worldSeq = 0;
function nextWorldSuffix(): string {
    worldSeq += 1;
    return String(worldSeq).padStart(3, "0");
}

export function idem(prefix: string): string {
    seq += 1;
    return `${prefix}:${seq}`;
}

async function makeIdentity(
    client: PoolClient,
    marketId: string,
    name: string,
    role: string
): Promise<string> {
    const { rows } = await client.query<{ identity_id: string }>(
        `INSERT INTO core_identity (market_id, display_name) VALUES ($1, $2)
         RETURNING identity_id`,
        [marketId, name]
    );
    const identityId = rows[0]!.identity_id;
    await client.query(
        `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, $3)`,
        [identityId, marketId, role]
    );
    return identityId;
}

async function seedAvailability(
    client: PoolClient,
    marketId: string,
    providerId: string,
    locationId: string
): Promise<void> {
    await client.query(
        `INSERT INTO core_capacity_window (market_id, provider_id, location_id, during)
         VALUES ($1, $2, $3, tstzrange(now() - interval '1 day', now() + interval '120 days', '[)'))`,
        [marketId, providerId, locationId]
    );
}

// -----------------------------------------------------------------------------
// MOBILE world — Freshline / Bali
// -----------------------------------------------------------------------------

export interface MobileWorld {
    marketId: MarketId;
    tenantId: string;
    ownerIdentityId: string;
    customerIdentityId: string;
    providerIdentityId: string;
    providerId: string;
    serviceId: string;
    addonId: string;
    serviceAreaKey: string;
}

export async function seedMobileWorld(client: PoolClient): Promise<MobileWorld> {
    const marketId: MarketId = "bali";
    const tenantId = loadMarketConfig(marketId).tenantId;

    const ownerIdentityId = await makeIdentity(client, marketId, "Bali Owner", "OWNER");
    const customerIdentityId = await makeIdentity(client, marketId, "Bali Customer", "CUSTOMER");
    const providerIdentityId = await makeIdentity(client, marketId, "Bali Therapist", "PROVIDER");

    const provider = await client.query<{ provider_id: string }>(
        `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
         VALUES ($1, $2, 'Bali Therapist', 'APPROVED') RETURNING provider_id`,
        [marketId, providerIdentityId]
    );
    const providerId = provider.rows[0]!.provider_id;

    const service = await client.query<{ service_id: string }>(
        `INSERT INTO core_service (market_id, name, base_duration_minutes)
         VALUES ($1, 'In-villa Massage', 60) RETURNING service_id`,
        [marketId]
    );
    const serviceId = service.rows[0]!.service_id;

    await client.query(
        `INSERT INTO core_service_topology (service_id, topology) VALUES ($1, 'MOBILE')`,
        [serviceId]
    );
    await client.query(
        `INSERT INTO core_provider_service (provider_id, service_id) VALUES ($1, $2)`,
        [providerId, serviceId]
    );

    const addon = await client.query<{ addon_id: string }>(
        `INSERT INTO core_service_addon (service_id, name, extra_duration_minutes, price_minor_units)
         VALUES ($1, 'Hot stones', 15, 50000) RETURNING addon_id`,
        [serviceId]
    );
    const addonId = addon.rows[0]!.addon_id;

    await client.query(
        `INSERT INTO core_service_price_version
            (service_id, price_minor_units, currency_code, buffer_minutes)
         VALUES ($1, 250000, 'IDR', 10)`,
        [serviceId]
    );

    const serviceAreaKey = `SEMINYAK-${nextWorldSuffix()}`;
    await client.query(
        `INSERT INTO core_service_area (tenant_id, market_id, area_key) VALUES ($1, $2, $3)`,
        [tenantId, marketId, serviceAreaKey]
    );

    await seedAvailability(client, marketId, providerId, "MOBILE");

    return {
        marketId,
        tenantId,
        ownerIdentityId,
        customerIdentityId,
        providerIdentityId,
        providerId,
        serviceId,
        addonId,
        serviceAreaKey
    };
}

// -----------------------------------------------------------------------------
// INSTORE world — Northbeam / Saigon
// -----------------------------------------------------------------------------

export interface InStoreWorld {
    marketId: MarketId;
    tenantId: string;
    customerIdentityId: string;
    providerAIdentityId: string;
    providerBIdentityId: string;
    providerAId: string;
    providerBId: string;
    locationId: string;
    chairResourceId: string;
    cutServiceId: string;
    colourServiceId: string;
}

export async function seedInStoreWorld(client: PoolClient): Promise<InStoreWorld> {
    const marketId: MarketId = "saigon";
    const tenantId = loadMarketConfig(marketId).tenantId;
    const timezone = loadMarketConfig(marketId).timezone;

    const customerIdentityId = await makeIdentity(client, marketId, "Saigon Customer", "CUSTOMER");
    const providerAIdentityId = await makeIdentity(client, marketId, "Barber A", "PROVIDER");
    const providerBIdentityId = await makeIdentity(client, marketId, "Barber B", "PROVIDER");

    const location = await client.query<{ location_id: string }>(
        `INSERT INTO core_location (tenant_id, market_id, name, timezone)
         VALUES ($1, $2, 'Northbeam District 1', $3) RETURNING location_id`,
        [tenantId, marketId, timezone]
    );
    const locationId = location.rows[0]!.location_id;

    // Monday..Saturday 10:00-20:30; Sunday deliberately absent so "closed" is
    // the fail-closed default rather than a special case.
    for (let weekday = 1; weekday <= 6; weekday++) {
        await client.query(
            `INSERT INTO core_location_hours (location_id, weekday, open_minute, close_minute)
             VALUES ($1, $2, 600, 1230)`,
            [locationId, weekday]
        );
    }

    const providers: string[] = [];
    for (const identityId of [providerAIdentityId, providerBIdentityId]) {
        const provider = await client.query<{ provider_id: string }>(
            `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
             VALUES ($1, $2, 'Barber', 'APPROVED') RETURNING provider_id`,
            [marketId, identityId]
        );
        const providerId = provider.rows[0]!.provider_id;
        providers.push(providerId);
        await client.query(
            `INSERT INTO core_provider_location (provider_id, location_id) VALUES ($1, $2)`,
            [providerId, locationId]
        );
        await seedAvailability(client, marketId, providerId, locationId);
    }
    const [providerAId, providerBId] = providers as [string, string];

    // ONE chair shared by both barbers — the shared-resource conflict surface.
    const chair = await client.query<{ resource_id: string }>(
        `INSERT INTO core_resource (tenant_id, market_id, location_id, resource_kind, name)
         VALUES ($1, $2, $3, 'CHAIR', 'Chair 1') RETURNING resource_id`,
        [tenantId, marketId, locationId]
    );
    const chairResourceId = chair.rows[0]!.resource_id;

    // Two services with different durations; only the colour needs the chair.
    const cut = await client.query<{ service_id: string }>(
        `INSERT INTO core_service (market_id, name, base_duration_minutes)
         VALUES ($1, 'Dry Cut', 30) RETURNING service_id`,
        [marketId]
    );
    const cutServiceId = cut.rows[0]!.service_id;

    const colour = await client.query<{ service_id: string }>(
        `INSERT INTO core_service (market_id, name, base_duration_minutes)
         VALUES ($1, 'Colour', 90) RETURNING service_id`,
        [marketId]
    );
    const colourServiceId = colour.rows[0]!.service_id;

    for (const serviceId of [cutServiceId, colourServiceId]) {
        await client.query(
            `INSERT INTO core_service_topology (service_id, topology) VALUES ($1, 'INSTORE')`,
            [serviceId]
        );
        for (const providerId of providers) {
            await client.query(
                `INSERT INTO core_provider_service (provider_id, service_id) VALUES ($1, $2)`,
                [providerId, serviceId]
            );
        }
    }

    await client.query(
        `INSERT INTO core_service_resource_requirement (service_id, resource_kind)
         VALUES ($1, 'CHAIR')`,
        [colourServiceId]
    );

    // Pricing distinct from Freshline, in the market's own currency.
    await client.query(
        `INSERT INTO core_service_price_version
            (service_id, price_minor_units, currency_code, buffer_minutes)
         VALUES ($1, 180000, 'VND', 0)`,
        [cutServiceId]
    );
    await client.query(
        `INSERT INTO core_service_price_version
            (service_id, price_minor_units, currency_code, buffer_minutes)
         VALUES ($1, 950000, 'VND', 15)`,
        [colourServiceId]
    );

    return {
        marketId,
        tenantId,
        customerIdentityId,
        providerAIdentityId,
        providerBIdentityId,
        providerAId,
        providerBId,
        locationId,
        chairResourceId,
        cutServiceId,
        colourServiceId
    };
}

// -----------------------------------------------------------------------------
// HYBRID world — Freshline / Bangkok, both topologies under one configuration
// -----------------------------------------------------------------------------

export interface HybridWorld {
    marketId: MarketId;
    tenantId: string;
    customerIdentityId: string;
    providerId: string;
    locationId: string;
    serviceId: string;
    serviceAreaKey: string;
}

export async function seedHybridWorld(client: PoolClient): Promise<HybridWorld> {
    // Penang, not Bangkok: Bangkok is a documented PRE_LAUNCH scaffold whose
    // killSwitch is deliberately engaged, and a proof must not disarm a safety
    // flag to succeed.
    const marketId: MarketId = "penang";
    const config = loadMarketConfig(marketId);
    const tenantId = config.tenantId;

    const customerIdentityId = await makeIdentity(client, marketId, "BKK Customer", "CUSTOMER");
    const providerIdentityId = await makeIdentity(client, marketId, "BKK Provider", "PROVIDER");

    const provider = await client.query<{ provider_id: string }>(
        `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
         VALUES ($1, $2, 'BKK Provider', 'APPROVED') RETURNING provider_id`,
        [marketId, providerIdentityId]
    );
    const providerId = provider.rows[0]!.provider_id;

    const location = await client.query<{ location_id: string }>(
        `INSERT INTO core_location (tenant_id, market_id, name, timezone)
         VALUES ($1, $2, 'BKK Studio', $3) RETURNING location_id`,
        [tenantId, marketId, config.timezone]
    );
    const locationId = location.rows[0]!.location_id;
    for (let weekday = 0; weekday <= 6; weekday++) {
        await client.query(
            `INSERT INTO core_location_hours (location_id, weekday, open_minute, close_minute)
             VALUES ($1, $2, 540, 1380)`,
            [locationId, weekday]
        );
    }
    await client.query(
        `INSERT INTO core_provider_location (provider_id, location_id) VALUES ($1, $2)`,
        [providerId, locationId]
    );

    const service = await client.query<{ service_id: string }>(
        `INSERT INTO core_service (market_id, name, base_duration_minutes)
         VALUES ($1, 'Signature Treatment', 60) RETURNING service_id`,
        [marketId]
    );
    const serviceId = service.rows[0]!.service_id;

    // The same service is sellable both ways — that is the hybrid claim.
    for (const topology of ["MOBILE", "INSTORE"]) {
        await client.query(
            `INSERT INTO core_service_topology (service_id, topology) VALUES ($1, $2)`,
            [serviceId, topology]
        );
    }
    await client.query(
        `INSERT INTO core_provider_service (provider_id, service_id) VALUES ($1, $2)`,
        [providerId, serviceId]
    );
    await client.query(
        `INSERT INTO core_service_price_version
            (service_id, price_minor_units, currency_code, buffer_minutes)
         VALUES ($1, 90000, 'THB', 5)`,
        [serviceId]
    );

    const serviceAreaKey = `SUKHUMVIT-${nextWorldSuffix()}`;
    await client.query(
        `INSERT INTO core_service_area (tenant_id, market_id, area_key) VALUES ($1, $2, $3)`,
        [tenantId, marketId, serviceAreaKey]
    );

    await seedAvailability(client, marketId, providerId, locationId);
    await seedAvailability(client, marketId, providerId, "MOBILE");

    return {
        marketId,
        tenantId,
        customerIdentityId,
        providerId,
        locationId,
        serviceId,
        serviceAreaKey
    };
}
