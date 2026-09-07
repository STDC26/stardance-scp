// SCP Runtime — tenant / brand / market / environment identity.
//
// Identity is RESOLVED from governed sources, never accepted from a caller. A
// request may say which tenant it believes it is talking about; the runtime
// checks that claim against the resolved identity and fails closed on any
// mismatch. Nothing here is a general IAM: it resolves one deployment's
// identity and propagates it.

export interface RuntimeIdentity {
    tenantId: string;
    organization: string;
    brand: string;
    marketId: string;
    environment: string;
}

export type IdentityFailureCode =
    | "IDENTITY_NOT_CONFIGURED"
    | "IDENTITY_MISMATCH"
    | "ENVIRONMENT_MISMATCH";

export type IdentityOutcome =
    | { ok: true; identity: RuntimeIdentity }
    | { ok: false; code: IdentityFailureCode; message: string };

export interface IdentityInput {
    tenantId?: string | undefined;
    marketId?: string | undefined;
    environment?: string | undefined;
}

/**
 * Resolves the runtime identity from explicit deployment inputs (typically
 * environment variables). Every field is required — a missing one fails closed
 * rather than defaulting to something plausible.
 */
export function resolveRuntimeIdentity(
    input: IdentityInput,
    resolvedFromConfiguration: { organization: string; brand: string }
): IdentityOutcome {
    const missing = (["tenantId", "marketId", "environment"] as const).filter(
        (key) => !input[key] || String(input[key]).trim() === ""
    );
    if (missing.length > 0) {
        return {
            ok: false,
            code: "IDENTITY_NOT_CONFIGURED",
            message: `runtime identity is incomplete: ${missing.join(", ")} not provided`
        };
    }
    return {
        ok: true,
        identity: {
            tenantId: input.tenantId!.trim(),
            marketId: input.marketId!.trim(),
            environment: input.environment!.trim(),
            organization: resolvedFromConfiguration.organization,
            brand: resolvedFromConfiguration.brand
        }
    };
}

/**
 * Checks a caller-supplied context against the resolved runtime identity.
 *
 * A caller may ASSERT a tenant/market/environment; it may never SET one. Any
 * disagreement is refused, which is what stops an arbitrary identifier from
 * becoming authority.
 */
export function assertIdentityMatches(
    identity: RuntimeIdentity,
    claimed: IdentityInput
): IdentityOutcome {
    if (claimed.tenantId !== undefined && claimed.tenantId !== identity.tenantId) {
        return {
            ok: false,
            code: "IDENTITY_MISMATCH",
            message: `claimed tenant "${claimed.tenantId}" does not match resolved tenant "${identity.tenantId}"`
        };
    }
    if (claimed.marketId !== undefined && claimed.marketId !== identity.marketId) {
        return {
            ok: false,
            code: "IDENTITY_MISMATCH",
            message: `claimed market "${claimed.marketId}" does not match resolved market "${identity.marketId}"`
        };
    }
    if (claimed.environment !== undefined && claimed.environment !== identity.environment) {
        return {
            ok: false,
            code: "ENVIRONMENT_MISMATCH",
            message: `claimed environment "${claimed.environment}" does not match resolved environment "${identity.environment}"`
        };
    }
    return { ok: true, identity };
}

/** The lineage every persisted record, event and adapter call must carry. */
export interface IdentityLineage {
    tenantId: string;
    marketId: string;
    environment: string;
}

export function lineageOf(identity: RuntimeIdentity): IdentityLineage {
    return {
        tenantId: identity.tenantId,
        marketId: identity.marketId,
        environment: identity.environment
    };
}
