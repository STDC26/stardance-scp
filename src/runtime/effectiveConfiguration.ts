// SCP Runtime — effective configuration resolution. Retires R18 and R19.
//
// THE OWNERSHIP MODEL, in one direction only:
//
//   canonical SCP market configuration        (config/<marketId>.market.json)
//        |  owns: timezone, currency, operating hours, booking window,
//        |        dispatch timeout, offer policy, topology, billing pattern
//        v
//   tenant implementation configuration       (governed, DB-persisted, ACTIVE)
//        |  owns: brand, catalogue, commerce policy, operations policy,
//        |        experience, coverage, measurement
//        |  may state: bounded, explicit APPROVED OVERRIDES
//        v
//   runtime-resolved EFFECTIVE configuration  (this module)
//
// R18 said overlapping values must not survive as independently authoritative
// duplicates. They no longer can: schema v2 removed the duplicated fields from
// the tenant plane entirely, so there is exactly one place each semantic can be
// stated, and exactly one place a divergence can be declared.
//
// R19 said the governed bundle must actually be consumed. The runtime resolves
// from the ACTIVE row in core_tenant_configuration — the governed store — not
// from a file read, a constant, or a second copy.

import type { PoolClient } from "pg";
import { loadMarketConfig, type MarketConfig, type MarketId } from "../config/marketConfig";
import { activeConfiguration, type StoredConfiguration } from "../config/tenant/store";
import { TENANT_CONFIG_SCHEMA_VERSION_V2, type TenantConfigurationBundleV2 } from "../config/tenant/contract";
import { configurationChecksum } from "../config/tenant/identity";
import { validateTenantConfiguration } from "../config/tenant/validate";

export interface OperatingHours {
    open: string;
    close: string;
}

/** Where a resolved value came from. Every field is attributable. */
export type ValueOrigin = "CANONICAL_MARKET" | "TENANT_CONFIGURATION" | "APPROVED_OVERRIDE";

export interface ResolvedValue<T> {
    value: T;
    origin: ValueOrigin;
}

export interface EffectiveConfiguration {
    identity: {
        tenantId: string;
        organization: string;
        brand: string;
        marketId: string;
        environment: string;
    };
    provenance: {
        configurationVersion: number;
        schemaVersion: string;
        checksum: string;
        activatedAt: Date | null;
        sourceReference: string;
        canonicalMarketId: string;
    };
    /** Core-owned, possibly overridden. Each carries its origin. */
    timezone: ResolvedValue<string>;
    priceCurrency: ResolvedValue<string>;
    displayCurrency: ResolvedValue<string>;
    operatingHours: ResolvedValue<OperatingHours>;
    dispatchAcceptanceTimeoutMinutes: ResolvedValue<number>;
    bookingWindow: ResolvedValue<{ minLeadMinutes: number; maxAdvanceDays: number }>;
    offerPolicy: ResolvedValue<{ validityMinutes: number; capacityHoldTtlMinutes: number }>;
    billingCodePattern: ResolvedValue<string>;
    /** Tenant-owned. */
    brandName: string;
    catalogue: TenantConfigurationBundleV2["planes"]["CATALOGUE"];
    commerce: TenantConfigurationBundleV2["planes"]["COMMERCE"];
    operations: TenantConfigurationBundleV2["planes"]["OPERATIONS"];
    experience: TenantConfigurationBundleV2["planes"]["EXPERIENCE"];
    coverage: TenantConfigurationBundleV2["planes"]["MARKET"]["coverage"];
    measurement: TenantConfigurationBundleV2["measurement"];
}

export type ConfigurationFailureCode =
    | "NO_ACTIVE_CONFIGURATION"
    | "CONFIGURATION_SCHEMA_UNSUPPORTED"
    | "CONFIGURATION_INVALID"
    | "CONFIGURATION_CHECKSUM_MISMATCH"
    | "CANONICAL_MARKET_UNRESOLVED"
    | "CONFIGURATION_IDENTITY_MISMATCH";

export type ConfigurationOutcome =
    | { ok: true; configuration: EffectiveConfiguration }
    | { ok: false; code: ConfigurationFailureCode; message: string };

export interface ResolveInput {
    tenantId: string;
    marketId: string;
    environment: string;
}

/**
 * Resolves the one effective configuration governing this runtime.
 *
 * Fails closed at every step: no active configuration, an unsupported schema,
 * an invalid bundle, a checksum that disagrees with the stored content, an
 * unresolvable canonical market, or an identity that disagrees with the request
 * all stop startup rather than falling back to a default.
 */
export async function resolveEffectiveConfiguration(
    client: PoolClient,
    input: ResolveInput
): Promise<ConfigurationOutcome> {
    const stored = await activeConfiguration(client, {
        tenantId: input.tenantId,
        marketId: input.marketId,
        environment: input.environment
    });
    if (!stored) {
        return {
            ok: false,
            code: "NO_ACTIVE_CONFIGURATION",
            message: `no ACTIVE governed configuration for ${input.tenantId}@${input.marketId}/${input.environment}`
        };
    }

    // R18 requires ONE ownership model. Only v2 expresses it; a v1 bundle still
    // restates Core-owned values and therefore may not govern a runtime.
    if (stored.schemaVersion !== TENANT_CONFIG_SCHEMA_VERSION_V2) {
        return {
            ok: false,
            code: "CONFIGURATION_SCHEMA_UNSUPPORTED",
            message: `runtime requires ${TENANT_CONFIG_SCHEMA_VERSION_V2}; the active configuration declares ${stored.schemaVersion}. A v1 bundle restates canonical market values and cannot govern a runtime.`
        };
    }

    return resolveFromStored(stored, input);
}

/** Pure resolution from an already-loaded configuration row. */
export function resolveFromStored(
    stored: StoredConfiguration,
    input: ResolveInput
): ConfigurationOutcome {
    const bundle = stored.bundle as unknown as TenantConfigurationBundleV2;

    if (
        bundle.tenant.id !== input.tenantId ||
        bundle.tenant.market !== input.marketId ||
        bundle.environment !== input.environment
    ) {
        return {
            ok: false,
            code: "CONFIGURATION_IDENTITY_MISMATCH",
            message: "the stored configuration does not describe the requested tenant/market/environment"
        };
    }

    // The stored checksum must still describe the stored content.
    const recomputed = configurationChecksum(bundle as never);
    if (recomputed !== stored.checksum) {
        return {
            ok: false,
            code: "CONFIGURATION_CHECKSUM_MISMATCH",
            message: `stored checksum ${stored.checksum} does not match content ${recomputed}`
        };
    }

    const validation = validateTenantConfiguration(bundle);
    if (!validation.valid) {
        return {
            ok: false,
            code: "CONFIGURATION_INVALID",
            message: `active configuration failed validation: ${validation.findings
                .map((f: { code: string; path: string }) => `${f.code}@${f.path}`)
                .join(", ")}`
        };
    }

    let canonical: MarketConfig;
    try {
        canonical = loadMarketConfig(bundle.planes.MARKET.marketConfigurationRef as MarketId);
    } catch (err) {
        return {
            ok: false,
            code: "CANONICAL_MARKET_UNRESOLVED",
            message: err instanceof Error ? err.message : String(err)
        };
    }

    const override = bundle.planes.MARKET.approvedOverrides.operatingHours;
    const canonicalHours: OperatingHours = {
        open: `${String(canonical.operatingHours.openingHour).padStart(2, "0")}:00`,
        close: `${String(canonical.operatingHours.closingHour).padStart(2, "0")}:${String(
            canonical.operatingHours.closingMinute
        ).padStart(2, "0")}`
    };

    return {
        ok: true,
        configuration: {
            identity: {
                tenantId: bundle.tenant.id,
                organization: bundle.tenant.organization,
                brand: bundle.tenant.brand,
                marketId: bundle.tenant.market,
                environment: bundle.environment
            },
            provenance: {
                configurationVersion: stored.configurationVersion,
                schemaVersion: stored.schemaVersion,
                checksum: stored.checksum,
                activatedAt: stored.activatedAt,
                sourceReference: stored.sourceReference,
                canonicalMarketId: canonical.marketId
            },
            timezone: { value: canonical.timezone, origin: "CANONICAL_MARKET" },
            priceCurrency: { value: canonical.currency.code, origin: "CANONICAL_MARKET" },
            displayCurrency: { value: canonical.currency.code, origin: "CANONICAL_MARKET" },
            operatingHours: override
                ? { value: override.daily, origin: "APPROVED_OVERRIDE" }
                : { value: canonicalHours, origin: "CANONICAL_MARKET" },
            dispatchAcceptanceTimeoutMinutes: {
                value: canonical.dispatch.acceptanceTimeoutMinutes,
                origin: "CANONICAL_MARKET"
            },
            bookingWindow: { value: canonical.bookingWindow, origin: "CANONICAL_MARKET" },
            offerPolicy: {
                value: {
                    validityMinutes: canonical.offer.validityMinutes,
                    capacityHoldTtlMinutes: canonical.offer.capacityHoldTtlMinutes
                },
                origin: "CANONICAL_MARKET"
            },
            billingCodePattern: {
                value: canonical.billing.codePattern,
                origin: "CANONICAL_MARKET"
            },
            brandName: bundle.planes.BRAND.name,
            catalogue: bundle.planes.CATALOGUE,
            commerce: bundle.planes.COMMERCE,
            operations: bundle.planes.OPERATIONS,
            experience: bundle.planes.EXPERIENCE,
            coverage: bundle.planes.MARKET.coverage,
            measurement: bundle.measurement
        }
    };
}

/** Compact, inspectable identity of the configuration governing a runtime. */
export function describeConfiguration(configuration: EffectiveConfiguration): string {
    const p = configuration.provenance;
    const i = configuration.identity;
    return `${i.tenantId}@${i.marketId}/${i.environment} v${p.configurationVersion} ${p.schemaVersion} ${p.checksum.slice(0, 12)}`;
}
