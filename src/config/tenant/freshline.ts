// SCP Tenant Configuration — Freshline Bali bundle loader.
//
// The bundle is DATA. This module exists only so the JSON has a typed entry
// point and a deterministic identity; it introduces no Freshline behavior into
// Core, and nothing under src/core, src/kernel or src/lifecycle imports it.

import freshlineBaliV1 from "../../../config/tenants/freshline-bali.v1.json";
import type { TenantConfigurationBundle } from "./contract";
import { configurationChecksum, configurationReference } from "./identity";
import { validateTenantConfiguration, type ValidationResult } from "./validate";

export const FRESHLINE_BALI_V1 = freshlineBaliV1 as unknown as TenantConfigurationBundle;

export const FRESHLINE_BALI_SCOPE = {
    tenantId: FRESHLINE_BALI_V1.tenant.id,
    marketId: FRESHLINE_BALI_V1.tenant.market,
    environment: FRESHLINE_BALI_V1.environment
} as const;

export function freshlineChecksum(): string {
    return configurationChecksum(FRESHLINE_BALI_V1);
}

export function freshlineReference(): string {
    return configurationReference(FRESHLINE_BALI_V1);
}

export function validateFreshline(): ValidationResult {
    return validateTenantConfiguration(FRESHLINE_BALI_V1);
}

/**
 * Deep clone helper for tests and for building a successor version: a bundle
 * must never be mutated in place, because its checksum is its identity.
 */
export function cloneBundle(bundle: TenantConfigurationBundle): TenantConfigurationBundle {
    return JSON.parse(JSON.stringify(bundle)) as TenantConfigurationBundle;
}
