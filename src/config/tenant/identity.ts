// SCP Tenant Configuration — deterministic identity.
//
// Two callers who supply the same configuration must derive the same checksum,
// on any machine, in any environment, regardless of key ordering or how the
// JSON was formatted. That is what makes a configuration version reproducible
// and what lets a historical transaction be interpreted against the exact
// configuration that governed it.
//
// Arrays are NOT sorted: order is semantically meaningful in a catalogue (it is
// display order) and reordering services is a real change to the configuration,
// not a formatting difference.

import { createHash } from "node:crypto";
import type { TenantConfigurationBundle } from "./contract";

/**
 * Canonical serialization: object keys emitted in sorted order, arrays left in
 * their declared order, `undefined` dropped.
 */
export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function canonicalBundleJson(bundle: TenantConfigurationBundle): string {
    return canonicalize(bundle);
}

/** SHA-256 of the canonical form. This is the configuration's identity. */
export function configurationChecksum(bundle: TenantConfigurationBundle): string {
    return createHash("sha256").update(canonicalBundleJson(bundle), "utf8").digest("hex");
}

/** Stable, human-readable reference for a specific configuration version. */
export function configurationReference(bundle: TenantConfigurationBundle): string {
    return `${bundle.tenant.id}@${bundle.tenant.market}/${bundle.environment}#v${bundle.configurationVersion}`;
}

export function bundlesAreIdentical(
    a: TenantConfigurationBundle,
    b: TenantConfigurationBundle
): boolean {
    return canonicalBundleJson(a) === canonicalBundleJson(b);
}
