// SCP-G5-E — governed coverage regions -> canonical SCP service areas.
//
// The Bali regions a partner may cover are stated once, in the governed tenant
// configuration. G3 reads serviceability from `core_service_area`. This module
// is the one-way projection between them, exactly as G5-D's catalogue
// projection is for services.
//
// Direction is one-way: configuration governs, Core owns. Nothing reads Core to
// decide what the coverage should be, and a region a provider types by hand can
// never become an authoritative service area because the only writer here is
// the projection.
//
// Idempotent and re-runnable. A region withdrawn from configuration is
// deactivated rather than deleted, so history stays readable and a provider's
// past coverage of it remains explicable.

import type { PoolClient } from "pg";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import type { IdentityLineage } from "../runtime/identity";

export interface ServiceAreaBinding {
    areaKey: string;
    serviceAreaId: string;
    active: boolean;
}

export interface ServiceAreaProjection {
    areas: ServiceAreaBinding[];
    created: number;
    reactivated: number;
    deactivated: number;
}

export async function projectServiceAreas(
    client: PoolClient,
    configuration: EffectiveConfiguration
): Promise<ServiceAreaProjection> {
    // The CANONICAL MARKET tenant, which is what G3 reads — not the tenant
    // configuration id. They are different values and mean different things.
    const tenantId = configuration.provenance.canonicalTenantId;
    const marketId = configuration.identity.marketId;
    const governed = configuration.coverage.regions;

    const projection: ServiceAreaProjection = {
        areas: [],
        created: 0,
        reactivated: 0,
        deactivated: 0
    };

    const { rows: existing } = await client.query<{
        service_area_id: string;
        area_key: string;
        active: boolean;
    }>(
        `SELECT service_area_id, area_key, active FROM core_service_area
          WHERE tenant_id = $1 AND market_id = $2`,
        [tenantId, marketId]
    );
    const byKey = new Map(existing.map((row) => [row.area_key, row]));

    for (const region of governed) {
        const current = byKey.get(region);
        if (!current) {
            const inserted = await client.query<{ service_area_id: string }>(
                `INSERT INTO core_service_area (tenant_id, market_id, area_key, active)
                 VALUES ($1, $2, $3, TRUE)
                 RETURNING service_area_id`,
                [tenantId, marketId, region]
            );
            projection.created += 1;
            projection.areas.push({
                areaKey: region,
                serviceAreaId: inserted.rows[0]!.service_area_id,
                active: true
            });
            continue;
        }
        if (!current.active) {
            await client.query(
                `UPDATE core_service_area SET active = TRUE WHERE service_area_id = $1`,
                [current.service_area_id]
            );
            projection.reactivated += 1;
        }
        projection.areas.push({
            areaKey: region,
            serviceAreaId: current.service_area_id,
            active: true
        });
    }

    const governedSet = new Set(governed);
    for (const row of existing) {
        if (!governedSet.has(row.area_key) && row.active) {
            await client.query(
                `UPDATE core_service_area SET active = FALSE WHERE service_area_id = $1`,
                [row.service_area_id]
            );
            projection.deactivated += 1;
        }
    }

    return projection;
}

/**
 * Resolves governed region names to canonical service-area identities. Returns
 * null when any region is unknown or inactive for this scope — the caller then
 * fails closed rather than inventing coverage.
 */
export async function resolveServiceAreas(
    client: PoolClient,
    lineage: IdentityLineage,
    tenantId: string,
    regions: readonly string[]
): Promise<Map<string, string> | null> {
    if (regions.length === 0) {
        return new Map();
    }
    const { rows } = await client.query<{ service_area_id: string; area_key: string }>(
        `SELECT service_area_id, area_key FROM core_service_area
          WHERE tenant_id = $1 AND market_id = $2 AND active = TRUE
            AND area_key = ANY($3::text[])`,
        [tenantId, lineage.marketId, [...new Set(regions)]]
    );
    const resolved = new Map(rows.map((r) => [r.area_key, r.service_area_id]));
    for (const region of regions) {
        if (!resolved.has(region)) {
            return null;
        }
    }
    return resolved;
}
