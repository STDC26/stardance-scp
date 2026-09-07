// SCP-G5-D — governed configuration catalogue -> canonical Core catalogue.
//
// The customer surface must be governed by CONFIGURATION, and canonical
// commercial truth must live in CORE. Those two facts need a mapping, and this
// module is it: it projects the ACTIVE governed catalogue into `core_service`,
// `core_service_addon` and `core_service_price_version`, and records the
// resulting identity in `core_catalogue_binding`.
//
// Direction is one-way. Configuration governs; Core owns. Nothing here reads
// Core to decide what the catalogue should be, and nothing downstream reads
// configuration to decide what a persisted request cost — the price snapshot on
// a Service Request version stays authoritative, exactly as G2 established.
//
// Projection is idempotent and re-runnable. Activating a new configuration
// version and re-projecting changes what customers see and what new requests
// cost, with no Core code change — which is the property that makes catalogue
// and pricing configuration rather than deployment.
//
// R16: the durations that govern exclusive capacity were declared in the bundle
// as ENGINEERING ASSUMPTIONS, not confirmed business facts. Projecting one must
// not launder it into truth, so every binding carries its provenance and the
// default is UNCONFIRMED. Only an explicit human ratification can say otherwise,
// and G5-D contains no path that does.

import type { PoolClient } from "pg";
import { loadMarketConfig, type MarketId } from "../config/marketConfig";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import type { IdentityLineage } from "../runtime/identity";

export type DurationProvenance = "CC_SUPPLIED_UNCONFIRMED" | "HUMAN_CONFIRMED";

export interface ServiceBinding {
    serviceCode: string;
    serviceId: string;
    name: string;
    priceMinorUnits: number;
    currencyCode: string;
    baseDurationMinutes: number;
    active: boolean;
    durationProvenance: DurationProvenance;
}

export interface ExtraBinding {
    serviceCode: string;
    extraCode: string;
    addonId: string;
    serviceId: string;
    name: string;
    priceMinorUnits: number;
    extraDurationMinutes: number;
    active: boolean;
    durationProvenance: DurationProvenance;
}

export interface CatalogueProjection {
    services: ServiceBinding[];
    extras: ExtraBinding[];
    servicesCreated: number;
    servicesUpdated: number;
    extrasCreated: number;
    extrasUpdated: number;
    priceVersionsAppended: number;
    configurationVersion: number;
    configurationChecksum: string;
}

export type ProjectionFailureCode = "CATALOGUE_CURRENCY_MISMATCH" | "CANONICAL_MARKET_UNRESOLVED";

export type ProjectionOutcome =
    | { ok: true; projection: CatalogueProjection }
    | { ok: false; code: ProjectionFailureCode; message: string };

/**
 * Whether a bundle declares its catalogue durations to be engineering
 * assumptions rather than confirmed business facts.
 *
 * This REPORTS the declaration; it does not decide provenance. Absence of the
 * declaration is not ratification, so projection still defaults to UNCONFIRMED
 * either way and only an explicit caller-supplied `HUMAN_CONFIRMED` changes it.
 * R16 is retired by a human, not by a heuristic.
 */
export function declaresUnconfirmedDurations(bundle: unknown): boolean {
    const meta = (bundle as { _meta?: { ccSuppliedValues?: unknown } } | null)?._meta;
    const declared = Array.isArray(meta?.ccSuppliedValues) ? meta.ccSuppliedValues : [];
    return declared.some((entry) => typeof entry === "string" && entry.includes("uration"));
}

interface BindingRow {
    binding_id: string;
    service_id: string;
    addon_id: string | null;
}

async function loadBinding(
    client: PoolClient,
    lineage: IdentityLineage,
    serviceCode: string,
    extraCode: string | null
): Promise<BindingRow | null> {
    const { rows } = await client.query<BindingRow>(
        `SELECT binding_id, service_id, addon_id
           FROM core_catalogue_binding
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
            AND service_code = $4 AND COALESCE(extra_code, '') = COALESCE($5, '')`,
        [lineage.tenantId, lineage.marketId, lineage.environment, serviceCode, extraCode]
    );
    return rows[0] ?? null;
}

/**
 * Converts a configuration price (stated in major units, as a human writes it)
 * into the minor units Core stores. IDR declares zero decimal digits, so the two
 * coincide here; deriving the factor from the canonical market rather than
 * assuming it keeps the next market honest.
 */
function toMinorUnits(amount: number, decimalDigits: number): number {
    return Math.round(amount * 10 ** decimalDigits);
}

/**
 * Projects the governed catalogue into Core. Safe to re-run: an unchanged
 * configuration produces no new rows, and a changed price appends a new price
 * version rather than rewriting the old one.
 */
export async function projectCatalogue(
    client: PoolClient,
    configuration: EffectiveConfiguration,
    options: { durationProvenance?: DurationProvenance } = {}
): Promise<ProjectionOutcome> {
    const provenance = options.durationProvenance ?? "CC_SUPPLIED_UNCONFIRMED";
    const lineage: IdentityLineage = {
        tenantId: configuration.identity.tenantId,
        marketId: configuration.identity.marketId,
        environment: configuration.identity.environment
    };

    let decimalDigits: number;
    try {
        decimalDigits = loadMarketConfig(
            configuration.provenance.canonicalMarketId as MarketId
        ).currency.decimalDigits;
    } catch (err) {
        return {
            ok: false,
            code: "CANONICAL_MARKET_UNRESOLVED",
            message: err instanceof Error ? err.message : String(err)
        };
    }

    const currency = configuration.priceCurrency.value;
    for (const service of configuration.catalogue.services) {
        if (service.price.currency !== currency) {
            return {
                ok: false,
                code: "CATALOGUE_CURRENCY_MISMATCH",
                message: `service ${service.code} is priced in ${service.price.currency}; the canonical market currency is ${currency}`
            };
        }
    }
    for (const extra of configuration.catalogue.extras) {
        if (extra.price.currency !== currency) {
            return {
                ok: false,
                code: "CATALOGUE_CURRENCY_MISMATCH",
                message: `extra ${extra.code} is priced in ${extra.price.currency}; the canonical market currency is ${currency}`
            };
        }
    }

    const projection: CatalogueProjection = {
        services: [],
        extras: [],
        servicesCreated: 0,
        servicesUpdated: 0,
        extrasCreated: 0,
        extrasUpdated: 0,
        priceVersionsAppended: 0,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum
    };

    for (const service of configuration.catalogue.services) {
        const priceMinorUnits = toMinorUnits(service.price.amount, decimalDigits);
        const existing = await loadBinding(client, lineage, service.code, null);

        let serviceId: string;
        if (existing) {
            serviceId = existing.service_id;
            await client.query(
                `UPDATE core_service
                    SET name = $2, base_duration_minutes = $3, active = $4
                  WHERE service_id = $1`,
                [serviceId, service.name, service.durationMinutes, service.active]
            );
            await client.query(
                `UPDATE core_catalogue_binding
                    SET projected_from_version = $2, projected_from_checksum = $3,
                        duration_provenance = $4, updated_at = now()
                  WHERE binding_id = $1`,
                [
                    existing.binding_id,
                    projection.configurationVersion,
                    projection.configurationChecksum,
                    provenance
                ]
            );
            projection.servicesUpdated += 1;
        } else {
            const inserted = await client.query<{ service_id: string }>(
                `INSERT INTO core_service (market_id, name, base_duration_minutes, active)
                 VALUES ($1, $2, $3, $4)
                 RETURNING service_id`,
                [lineage.marketId, service.name, service.durationMinutes, service.active]
            );
            serviceId = inserted.rows[0]!.service_id;
            await client.query(
                `INSERT INTO core_catalogue_binding
                    (tenant_id, market_id, environment, kind, service_code, extra_code,
                     service_id, addon_id, duration_provenance,
                     projected_from_version, projected_from_checksum)
                 VALUES ($1,$2,$3,'SERVICE',$4,NULL,$5,NULL,$6,$7,$8)`,
                [
                    lineage.tenantId,
                    lineage.marketId,
                    lineage.environment,
                    service.code,
                    serviceId,
                    provenance,
                    projection.configurationVersion,
                    projection.configurationChecksum
                ]
            );
            projection.servicesCreated += 1;
        }

        // Price versions are append-only (COMMERCIAL_TRUTH.NO_SILENT_REPRICE).
        // A changed governed price deactivates the current version and appends a
        // new one; already-persisted requests keep the snapshot they accepted.
        const active = await client.query<{
            price_version_id: string;
            price_minor_units: string;
            currency_code: string;
        }>(
            `SELECT price_version_id, price_minor_units, currency_code
               FROM core_service_price_version
              WHERE service_id = $1 AND active = TRUE
              ORDER BY effective_from DESC
              LIMIT 1`,
            [serviceId]
        );
        const current = active.rows[0];
        const unchanged =
            current !== undefined &&
            Number(current.price_minor_units) === priceMinorUnits &&
            current.currency_code === currency;

        if (!unchanged) {
            if (current) {
                await client.query(
                    `UPDATE core_service_price_version SET active = FALSE WHERE price_version_id = $1`,
                    [current.price_version_id]
                );
            }
            await client.query(
                `INSERT INTO core_service_price_version
                    (service_id, price_minor_units, currency_code, buffer_minutes, active)
                 VALUES ($1, $2, $3, 0, TRUE)`,
                [serviceId, priceMinorUnits, currency]
            );
            projection.priceVersionsAppended += 1;
        }

        projection.services.push({
            serviceCode: service.code,
            serviceId,
            name: service.name,
            priceMinorUnits,
            currencyCode: currency,
            baseDurationMinutes: service.durationMinutes,
            active: service.active,
            durationProvenance: provenance
        });

        // Core scopes an add-on to a service, while the governed catalogue states
        // extras once for the tenant. Each extra is therefore projected per
        // service, and the binding records which pair produced which add-on.
        for (const extra of configuration.catalogue.extras) {
            const extraPrice = toMinorUnits(extra.price.amount, decimalDigits);
            const existingExtra = await loadBinding(client, lineage, service.code, extra.code);

            let addonId: string;
            if (existingExtra && existingExtra.addon_id) {
                addonId = existingExtra.addon_id;
                await client.query(
                    `UPDATE core_service_addon
                        SET name = $2, extra_duration_minutes = $3, price_minor_units = $4, active = $5
                      WHERE addon_id = $1`,
                    [addonId, extra.name, extra.extraDurationMinutes, extraPrice, extra.active]
                );
                await client.query(
                    `UPDATE core_catalogue_binding
                        SET projected_from_version = $2, projected_from_checksum = $3,
                            duration_provenance = $4, updated_at = now()
                      WHERE binding_id = $1`,
                    [
                        existingExtra.binding_id,
                        projection.configurationVersion,
                        projection.configurationChecksum,
                        provenance
                    ]
                );
                projection.extrasUpdated += 1;
            } else {
                const insertedAddon = await client.query<{ addon_id: string }>(
                    `INSERT INTO core_service_addon
                        (service_id, name, extra_duration_minutes, price_minor_units, active)
                     VALUES ($1,$2,$3,$4,$5)
                     RETURNING addon_id`,
                    [serviceId, extra.name, extra.extraDurationMinutes, extraPrice, extra.active]
                );
                addonId = insertedAddon.rows[0]!.addon_id;
                await client.query(
                    `INSERT INTO core_catalogue_binding
                        (tenant_id, market_id, environment, kind, service_code, extra_code,
                         service_id, addon_id, duration_provenance,
                         projected_from_version, projected_from_checksum)
                     VALUES ($1,$2,$3,'EXTRA',$4,$5,$6,$7,$8,$9,$10)`,
                    [
                        lineage.tenantId,
                        lineage.marketId,
                        lineage.environment,
                        service.code,
                        extra.code,
                        serviceId,
                        addonId,
                        provenance,
                        projection.configurationVersion,
                        projection.configurationChecksum
                    ]
                );
                projection.extrasCreated += 1;
            }

            projection.extras.push({
                serviceCode: service.code,
                extraCode: extra.code,
                addonId,
                serviceId,
                name: extra.name,
                priceMinorUnits: extraPrice,
                extraDurationMinutes: extra.extraDurationMinutes,
                active: extra.active,
                durationProvenance: provenance
            });
        }
    }

    return { ok: true, projection };
}

export interface ResolvedCatalogueIdentity {
    serviceId: string;
    addonIds: string[];
    durationProvenance: DurationProvenance;
}

/**
 * Resolves configuration codes to the canonical Core identities they were
 * projected into. Returns null when the catalogue has not been projected for
 * this scope — ingress then fails closed rather than creating catalogue rows as
 * a side effect of a customer submission.
 */
export async function resolveCatalogueIdentity(
    client: PoolClient,
    lineage: IdentityLineage,
    serviceCode: string,
    extraCodes: readonly string[]
): Promise<ResolvedCatalogueIdentity | null> {
    const service = await client.query<{ service_id: string; duration_provenance: string }>(
        `SELECT service_id, duration_provenance
           FROM core_catalogue_binding
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
            AND kind = 'SERVICE' AND service_code = $4`,
        [lineage.tenantId, lineage.marketId, lineage.environment, serviceCode]
    );
    const serviceRow = service.rows[0];
    if (!serviceRow) {
        return null;
    }

    const addonIds: string[] = [];
    for (const code of extraCodes) {
        const extra = await client.query<{ addon_id: string }>(
            `SELECT addon_id
               FROM core_catalogue_binding
              WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
                AND kind = 'EXTRA' AND service_code = $4 AND extra_code = $5`,
            [lineage.tenantId, lineage.marketId, lineage.environment, serviceCode, code]
        );
        const addonId = extra.rows[0]?.addon_id;
        if (!addonId) {
            return null;
        }
        addonIds.push(addonId);
    }

    return {
        serviceId: serviceRow.service_id,
        addonIds,
        durationProvenance: serviceRow.duration_provenance as DurationProvenance
    };
}
