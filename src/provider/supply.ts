// SCP-G5-E — approved supply: materialization into Core, and the read model.
//
// S02 says: do not build a second matching engine. So this module does not
// decide anything. It takes the ONE Owner-confirmed availability version and
// writes it into the constructs G3 already reads —
//
//   core_provider.supply_status = 'APPROVED'   written by the G2 Core command
//                                              during Owner card approval
//   core_provider_service                      capability, written at approval
//   core_capacity_window                       bookable time, written here
//   core_provider_service_area                 MOBILE coverage, written here
//
// — and then offers a read model over them. G3 remains the sole authority on
// sellability and eligibility; G5-E only makes supply legible to it.
//
// Withdrawal is the same mechanism in reverse. When a confirmed week is
// superseded, every window that version granted is deactivated, tracked through
// `core_supply_window_link`. That is what makes A07 structural: a stale version
// cannot linger as capacity, because the capacity it created is addressable.

import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { resolveServiceAreas } from "./serviceAreas";

export interface AvailabilityDayRow {
    isoDay: number;
    available: boolean;
    startTimeLocal: string | null;
    endTimeLocal: string | null;
    regions: string[];
}

export interface AvailabilityVersionRow {
    availabilityVersionId: string;
    providerId: string;
    tenantId: string;
    marketId: string;
    environment: string;
    weekStartDate: string;
    version: number;
    state: "SUBMITTED" | "CONFIRMED" | "SUPERSEDED" | "WITHDRAWN";
    contentDigest: string;
    confirmedAt: Date | null;
    confirmedByIdentityId: string | null;
    days: AvailabilityDayRow[];
}

export async function loadAvailabilityVersion(
    client: PoolClient,
    availabilityVersionId: string,
    forUpdate = false
): Promise<AvailabilityVersionRow | null> {
    const { rows } = await client.query<{
        availability_version_id: string;
        provider_id: string;
        tenant_id: string;
        market_id: string;
        environment: string;
        week_start_date: Date;
        version: number;
        state: AvailabilityVersionRow["state"];
        content_digest: string;
        confirmed_at: Date | null;
        confirmed_by_identity_id: string | null;
    }>(
        `SELECT availability_version_id, provider_id, tenant_id, market_id, environment,
                week_start_date, version, state, content_digest, confirmed_at,
                confirmed_by_identity_id
           FROM core_provider_availability_version
          WHERE availability_version_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [availabilityVersionId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    const days = await client.query<{
        iso_day: number;
        available: boolean;
        start_time_local: string | null;
        end_time_local: string | null;
        regions: string[];
    }>(
        `SELECT iso_day, available, start_time_local, end_time_local, regions
           FROM core_provider_availability_day
          WHERE availability_version_id = $1
          ORDER BY iso_day`,
        [availabilityVersionId]
    );
    return {
        availabilityVersionId: row.availability_version_id,
        providerId: row.provider_id,
        tenantId: row.tenant_id,
        marketId: row.market_id,
        environment: row.environment,
        weekStartDate: DateTime.fromJSDate(row.week_start_date, { zone: "utc" }).toFormat(
            "yyyy-MM-dd"
        ),
        version: row.version,
        state: row.state,
        contentDigest: row.content_digest,
        confirmedAt: row.confirmed_at,
        confirmedByIdentityId: row.confirmed_by_identity_id,
        days: days.rows.map((d) => ({
            isoDay: d.iso_day,
            available: d.available,
            startTimeLocal: d.start_time_local,
            endTimeLocal: d.end_time_local,
            regions: d.regions
        }))
    };
}

/**
 * Writes the confirmed week into canonical capacity.
 *
 * One window per available day per covered region, so both the
 * location-agnostic G3 availability check and the location-scoped G2 capacity
 * check see the same truth. Every window is linked back to the version that
 * granted it.
 */
export async function materializeConfirmedAvailability(
    client: PoolClient,
    configuration: EffectiveConfiguration,
    version: AvailabilityVersionRow
): Promise<{ ok: true; windows: number; areas: number } | { ok: false; code: "SERVICE_AREAS_NOT_PROJECTED" }> {
    const zone = configuration.timezone.value;
    const canonicalTenantId = configuration.provenance.canonicalTenantId;

    const allRegions = [...new Set(version.days.flatMap((d) => d.regions))];
    const areas = await resolveServiceAreas(
        client,
        { tenantId: version.tenantId, marketId: version.marketId, environment: version.environment },
        canonicalTenantId,
        allRegions
    );
    if (areas === null) {
        return { ok: false, code: "SERVICE_AREAS_NOT_PROJECTED" };
    }

    // Coverage links are the union over the confirmed week: a coarse filter for
    // callers that want "can this provider work in Canggu at all". Day-precise
    // coverage stays on the availability days, which is where it is true.
    for (const serviceAreaId of new Set(areas.values())) {
        await client.query(
            `INSERT INTO core_provider_service_area (provider_id, service_area_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [version.providerId, serviceAreaId]
        );
    }

    const monday = DateTime.fromISO(version.weekStartDate, { zone });
    let windows = 0;
    for (const day of version.days) {
        if (!day.available || !day.startTimeLocal || !day.endTimeLocal) {
            continue;
        }
        const date = monday.plus({ days: day.isoDay - 1 });
        const [startHour, startMinute] = day.startTimeLocal.split(":").map(Number) as [number, number];
        const [endHour, endMinute] = day.endTimeLocal.split(":").map(Number) as [number, number];
        const start = date.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
        const end = date.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });

        for (const region of day.regions) {
            const inserted = await client.query<{ window_id: string }>(
                `INSERT INTO core_capacity_window (market_id, provider_id, location_id, during, active)
                 VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), TRUE)
                 RETURNING window_id`,
                [version.marketId, version.providerId, region, start.toJSDate(), end.toJSDate()]
            );
            await client.query(
                `INSERT INTO core_supply_window_link (window_id, availability_version_id, iso_day)
                 VALUES ($1, $2, $3)`,
                [inserted.rows[0]!.window_id, version.availabilityVersionId, day.isoDay]
            );
            windows += 1;
        }
    }

    return { ok: true, windows, areas: new Set(areas.values()).size };
}

/**
 * Deactivates every capacity window a version granted. Windows are deactivated
 * rather than deleted so the history of what was once bookable stays readable.
 */
export async function withdrawAvailabilityVersion(
    client: PoolClient,
    availabilityVersionId: string
): Promise<number> {
    const { rowCount } = await client.query(
        `UPDATE core_capacity_window
            SET active = FALSE
          WHERE active = TRUE
            AND window_id IN (
                SELECT window_id FROM core_supply_window_link
                 WHERE availability_version_id = $1
            )`,
        [availabilityVersionId]
    );
    return rowCount ?? 0;
}

// -----------------------------------------------------------------------------
// The read model
// -----------------------------------------------------------------------------

export interface ApprovedSupplyDay {
    isoDay: number;
    startTimeLocal: string;
    endTimeLocal: string;
    regions: string[];
}

export interface ApprovedSupplyEntry {
    providerId: string;
    publicId: string;
    displayName: string;
    roleCode: string;
    /** Canonical Core service ids, the form G3 consumes. */
    serviceIds: string[];
    /** Governed catalogue codes, for legibility. */
    serviceCodes: string[];
    weekStartDate: string;
    availabilityVersionId: string;
    availabilityVersion: number;
    days: ApprovedSupplyDay[];
    coverageRegions: string[];
}

export interface ApprovedSupplyQuery {
    weekStartDate: string;
    providerId?: string | undefined;
}

/**
 * The deterministic, server-owned view of who is currently approved supply.
 *
 * A provider appears only when EVERY one of these holds, and each is a fail-
 * closed AND rather than a scoring input:
 *
 *   * `core_provider.supply_status = 'APPROVED'`  (activated by Owner approval)
 *   * an APPROVED Provider Card                    (S03)
 *   * a CONFIRMED availability version for the week (S04)
 *   * that version is the current one — superseded versions are not CONFIRMED,
 *     so they cannot appear (S05)
 *   * at least one declared, catalogue-bound capability
 *
 * Ordering is by provider id so two runs against the same data return the same
 * list in the same order.
 */
export async function approvedSupply(
    client: PoolClient,
    configuration: EffectiveConfiguration,
    query: ApprovedSupplyQuery
): Promise<ApprovedSupplyEntry[]> {
    const scope = configuration.identity;
    const params: unknown[] = [
        scope.tenantId,
        scope.marketId,
        scope.environment,
        query.weekStartDate
    ];
    let providerFilter = "";
    if (query.providerId) {
        providerFilter = "AND p.provider_id = $5";
        params.push(query.providerId);
    }

    const { rows } = await client.query<{
        provider_id: string;
        public_id: string;
        display_name: string;
        role_code: string;
        service_codes: string[];
        availability_version_id: string;
        version: number;
        week_start_date: Date;
    }>(
        `SELECT p.provider_id,
                pid.public_id,
                prof.display_name,
                prof.role_code,
                prof.service_codes,
                av.availability_version_id,
                av.version,
                av.week_start_date
           FROM core_provider p
           JOIN core_provider_public_id pid
             ON pid.provider_id = p.provider_id
            AND pid.tenant_id = $1 AND pid.market_id = $2 AND pid.environment = $3
           JOIN core_provider_card card
             ON card.provider_id = p.provider_id AND card.state = 'APPROVED'
            AND card.tenant_id = $1 AND card.market_id = $2 AND card.environment = $3
           JOIN core_provider_profile prof
             ON prof.profile_id = card.profile_id
           JOIN core_provider_availability_version av
             ON av.provider_id = p.provider_id
            AND av.state = 'CONFIRMED'
            AND av.week_start_date = $4::date
            AND av.tenant_id = $1 AND av.market_id = $2 AND av.environment = $3
          WHERE p.market_id = $2
            AND p.supply_status = 'APPROVED'
            ${providerFilter}
          ORDER BY p.provider_id`,
        params
    );

    const entries: ApprovedSupplyEntry[] = [];
    for (const row of rows) {
        const days = await client.query<{
            iso_day: number;
            start_time_local: string;
            end_time_local: string;
            regions: string[];
        }>(
            `SELECT iso_day, start_time_local, end_time_local, regions
               FROM core_provider_availability_day
              WHERE availability_version_id = $1 AND available = TRUE
              ORDER BY iso_day`,
            [row.availability_version_id]
        );

        // Capability in the form G3 reads: canonical service ids that are
        // actually linked to this provider, not merely declared on a profile.
        const services = await client.query<{ service_id: string }>(
            `SELECT service_id FROM core_provider_service
              WHERE provider_id = $1 ORDER BY service_id`,
            [row.provider_id]
        );
        if (services.rows.length === 0) {
            continue;
        }

        entries.push({
            providerId: row.provider_id,
            publicId: row.public_id,
            displayName: row.display_name,
            roleCode: row.role_code,
            serviceIds: services.rows.map((s) => s.service_id),
            serviceCodes: row.service_codes,
            weekStartDate: DateTime.fromJSDate(row.week_start_date, { zone: "utc" }).toFormat(
                "yyyy-MM-dd"
            ),
            availabilityVersionId: row.availability_version_id,
            availabilityVersion: row.version,
            days: days.rows.map((d) => ({
                isoDay: d.iso_day,
                startTimeLocal: d.start_time_local,
                endTimeLocal: d.end_time_local,
                regions: d.regions
            })),
            coverageRegions: [...new Set(days.rows.flatMap((d) => d.regions))].sort()
        });
    }

    return entries;
}
