// LAB-INFRA-01B — synthetic UAT tenant lineage, derived rather than duplicated.
//
// The Experience Lab needs a governed configuration it can activate, and it must
// NOT be the production Freshline tenant identity. The obvious move — copy
// `freshline-bali.v2.json` to `freshline-uat.v2.json` and edit three fields —
// creates a second copy of a bundle whose checksum is its identity, and two
// copies drift. So the UAT bundle is DERIVED from the accepted source at the
// moment of activation: one source of truth, and the difference between UAT and
// the accepted bundle is exactly the three identity fields named below and
// nothing else.
//
// What this is not: it is not tenant-specific Core behaviour, and it changes no
// service-commerce semantics. Market semantics come through unaltered — the
// point of a UAT lineage is to exercise the real configuration machinery, not to
// exercise a simplified imitation of it.

import type { TenantConfigurationBundle, TenantConfigurationBundleV2 } from "./contract";

export interface UatLineage {
    tenantId: string;
    marketId: string;
    environment: string;
}

/** The synthetic lineage the Experience Lab runs as. Never a production tenant. */
export const FRESHLINE_UAT_LINEAGE: UatLineage = {
    tenantId: "freshline-uat",
    marketId: "bali",
    environment: "uat"
};

/**
 * Athena's governed lineage (SCP-SHELL-04A-EXE-01A §3.2).
 *
 * Its bundle is derived from the same accepted source as Freshline's, and that is
 * deliberate: Athena's catalogue, prices and availability live in the FIXTURE
 * provider, and writing them into `core_tenant_configuration` would put fixture
 * content into a canonical truth table — an explicit hard stop. So what this
 * lineage establishes is that the tenant EXISTS and is governed; what Athena
 * *sells* is fixture-sourced and says FIXTURE in its provenance.
 *
 * Bali is an Experience Lab deployment convenience, not a claim that Athena's
 * commercial or geographic model is Bali-specific.
 */
export const ATHENA_UAT_LINEAGE: UatLineage = {
    tenantId: "athena-uat",
    marketId: "bali",
    environment: "uat"
};

/**
 * Derives a UAT bundle from an accepted source bundle.
 *
 * Only deployment identity is replaced: `tenant.id`, `tenant.market` and
 * `environment`. Every plane — catalogue, policy, measurement — is carried over
 * byte-for-byte, because a UAT run that quietly relaxes a policy proves nothing
 * about the configuration it claims to be testing.
 *
 * `configurationVersion` is carried over too. The store refuses a version that
 * does not advance past the newest already stored for the SAME lineage, and a
 * fresh UAT lineage has none — so the source's own version is both correct and
 * traceable back to the artifact it came from.
 *
 * The source is deep-cloned. A bundle must never be mutated in place: its
 * checksum is its identity, and mutating the imported JSON module would corrupt
 * every later reader in the process.
 */
export function deriveUatBundle(
    source: TenantConfigurationBundleV2,
    lineage: UatLineage = FRESHLINE_UAT_LINEAGE
): TenantConfigurationBundleV2 {
    const derived = JSON.parse(JSON.stringify(source)) as TenantConfigurationBundleV2;

    derived.tenant.id = lineage.tenantId;
    derived.tenant.market = lineage.marketId;
    derived.environment = lineage.environment;

    return derived;
}

/**
 * Narrowing helper for the store, which is typed against the v1 bundle shape at
 * its boundary while validating either schema version internally.
 */
export function asPublishableBundle(
    bundle: TenantConfigurationBundleV2
): TenantConfigurationBundle {
    return bundle as unknown as TenantConfigurationBundle;
}
