// SCP Runtime — the production-capable entry path.
//
// ONE startup sequence, and it fails closed at every step:
//
//   1. connectivity        — authoritative persistence must be reachable
//   2. schema              — the relations the runtime needs must exist
//   3. identity            — tenant/market/environment must be explicitly given
//   4. configuration       — one ACTIVE governed bundle, resolved to one
//                            effective configuration
//   5. adapters            — bounded, replaceable, non-authoritative
//
// There is no fallback anywhere in this file. A missing or invalid input stops
// startup and says why; it never substitutes a plausible default, because a
// runtime that guesses its own tenant or its own operating hours is worse than
// a runtime that refuses to start.

import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import {
    resolveRuntimeIdentity,
    lineageOf,
    type IdentityInput,
    type RuntimeIdentity
} from "./identity";
import { verifyConnectivity, verifySchema, type SchemaCheck } from "./persistence";
import {
    resolveEffectiveConfiguration,
    describeConfiguration,
    type EffectiveConfiguration
} from "./effectiveConfiguration";
import { recordRuntimeEvidence } from "./evidence";
import { AdapterSpine } from "../adapters/spine/adapter";
import { createWhatsAppTransport } from "../adapters/spine/transports";

export type StartupFailureCode =
    | "PERSISTENCE_UNAVAILABLE"
    | "SCHEMA_INCOMPATIBLE"
    | "IDENTITY_NOT_CONFIGURED"
    | "IDENTITY_MISMATCH"
    | "ENVIRONMENT_MISMATCH"
    | "NO_ACTIVE_CONFIGURATION"
    | "CONFIGURATION_SCHEMA_UNSUPPORTED"
    | "CONFIGURATION_INVALID"
    | "CONFIGURATION_CHECKSUM_MISMATCH"
    | "CANONICAL_MARKET_UNRESOLVED"
    | "CONFIGURATION_IDENTITY_MISMATCH";

export interface RuntimeContext {
    identity: RuntimeIdentity;
    configuration: EffectiveConfiguration;
    schema: SchemaCheck;
    adapters: AdapterSpine;
    /** Inspectable one-line identity of what is governing this runtime. */
    describe(): string;
}

export type StartupOutcome =
    | { ok: true; runtime: RuntimeContext }
    | { ok: false; code: StartupFailureCode; message: string };

export interface StartupInput {
    pool: Pool;
    /** Typically from environment variables. All three are required. */
    identity: IdentityInput;
    /** Enable the WhatsApp transport boundary. Not activated in G5-C. */
    enableWhatsAppTransport?: boolean;
}

/**
 * Starts the runtime. Every refusal is recorded as runtime evidence where the
 * lineage is known well enough to attribute it — a startup that fails should
 * leave a trace, not vanish.
 */
export async function startRuntime(input: StartupInput): Promise<StartupOutcome> {
    const connectivity = await verifyConnectivity(input.pool);
    if (!connectivity.ok) {
        return {
            ok: false,
            code: "PERSISTENCE_UNAVAILABLE",
            message: connectivity.message ?? "authoritative persistence is unreachable"
        };
    }

    // Identity must be explicit BEFORE anything is read, so every subsequent
    // read is already scoped and every refusal is attributable.
    const claimed = input.identity;
    if (
        !claimed.tenantId?.trim() ||
        !claimed.marketId?.trim() ||
        !claimed.environment?.trim()
    ) {
        return {
            ok: false,
            code: "IDENTITY_NOT_CONFIGURED",
            message:
                "runtime identity requires tenantId, marketId and environment; startup will not guess them"
        };
    }
    const lineage = {
        tenantId: claimed.tenantId.trim(),
        marketId: claimed.marketId.trim(),
        environment: claimed.environment.trim()
    };

    return withTransaction(input.pool, async (client: PoolClient) => {
        const schema = await verifySchema(client);
        if (!schema.ok) {
            await recordRuntimeEvidence(client, {
                kind: "PERSISTENCE_REFUSED",
                lineage,
                outcome: "REFUSED",
                reasonCode: "SCHEMA_INCOMPATIBLE",
                detail: { missing: schema.missing }
            });
            return {
                ok: false as const,
                code: "SCHEMA_INCOMPATIBLE" as const,
                message: `required relations are missing: ${schema.missing.join(", ")}`
            };
        }
        await recordRuntimeEvidence(client, {
            kind: "PERSISTENCE_VERIFIED",
            lineage,
            outcome: "OK",
            detail: {
                database: connectivity.database,
                requiredRelations: schema.present.length,
                legacyPresentButNonAuthoritative: schema.legacyPresentButNonAuthoritative
            }
        });

        const resolved = await resolveEffectiveConfiguration(client, lineage);
        if (!resolved.ok) {
            await recordRuntimeEvidence(client, {
                kind: "CONFIGURATION_REFUSED",
                lineage,
                outcome: "REFUSED",
                reasonCode: resolved.code,
                detail: { message: resolved.message }
            });
            return { ok: false as const, code: resolved.code, message: resolved.message };
        }
        const configuration = resolved.configuration;

        const identity = resolveRuntimeIdentity(claimed, {
            organization: configuration.identity.organization,
            brand: configuration.identity.brand
        });
        if (!identity.ok) {
            await recordRuntimeEvidence(client, {
                kind: "IDENTITY_REFUSED",
                lineage,
                outcome: "REFUSED",
                reasonCode: identity.code,
                detail: { message: identity.message }
            });
            return { ok: false as const, code: identity.code, message: identity.message };
        }

        await recordRuntimeEvidence(client, {
            kind: "IDENTITY_RESOLVED",
            lineage,
            outcome: "OK",
            detail: {
                tenantId: identity.identity.tenantId,
                organization: identity.identity.organization,
                brand: identity.identity.brand,
                marketId: identity.identity.marketId,
                environment: identity.identity.environment
            }
        });

        await recordRuntimeEvidence(client, {
            kind: "CONFIGURATION_RESOLVED",
            lineage,
            outcome: "OK",
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            detail: {
                schemaVersion: configuration.provenance.schemaVersion,
                canonicalMarketId: configuration.provenance.canonicalMarketId,
                timezone: configuration.timezone,
                priceCurrency: configuration.priceCurrency,
                operatingHours: configuration.operatingHours,
                paymentActive: configuration.commerce.payment.active,
                paymentPolicy: configuration.commerce.payment.policy,
                dynamicPricingActive: configuration.commerce.locationDynamicPricing.active
            }
        });

        const adapters = new AdapterSpine().register(
            createWhatsAppTransport({ enabled: input.enableWhatsAppTransport === true })
        );

        await recordRuntimeEvidence(client, {
            kind: "RUNTIME_START",
            lineage,
            outcome: "OK",
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            detail: { adapterChannels: adapters.channels() }
        });

        return {
            ok: true as const,
            runtime: {
                identity: identity.identity,
                configuration,
                schema,
                adapters,
                describe: () => describeConfiguration(configuration)
            }
        };
    });
}

export { lineageOf };
