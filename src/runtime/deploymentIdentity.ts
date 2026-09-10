// LAB-INFRA-01B / SCP-DEPLOY-ID-01 — the one place a deployment says who it is.
//
// `startRuntime` requires tenantId, marketId and environment and refuses to
// guess any of them (IDENTITY_NOT_CONFIGURED). Until this boundary existed the
// only suppliers were the hosts, which receive identity as a constructor input —
// so a process that is not one of those hosts had no way to state its identity
// at all. That is what this file supplies, and the entire reason it exists.
//
// It is deliberately a COMPOSITION boundary, not a service. Only deployment code
// calls it. Core, domain services, repositories, projections and hosts continue
// to receive identity as an argument and must not reach for the environment
// themselves — otherwise identity acquires as many truths as there are call
// sites, which is the defect this boundary exists to prevent.
//
// AGENTS.md Rule 1 is why marketId is NOT read from `ACTIVE_MARKET` here.
// `src/config/marketConfig.ts` is the single sanctioned reader of the
// market-selection signal, and a second reader in this file would be exactly the
// duplication that rule forbids. So the market comes back through that
// chokepoint, which also validates it against the registry.
//
// SCP-DEPLOY-ID-01 closed the last soft edge. The chokepoint answers `bali` when
// the signal is absent, which is reasonable for a laptop and wrong for a governed
// runtime: a deployment that never named a market would previously have started
// serving one. Governed environments now pass `requireExplicit`, so absence
// refuses. The convenience survives only where it is harmless, and only because
// the environment explicitly says `development`.

import { getActiveMarketConfig, MarketSelectionError } from "../config/marketConfig";
import type { IdentityInput } from "./identity";

/** The tenant this deployment serves. No default — a wrong tenant is worse than no start. */
export const TENANT_ID_VAR = "SCP_TENANT_ID";

/** The deployment environment, e.g. `uat`. No default, for the same reason. */
export const ENVIRONMENT_VAR = "SCP_ENVIRONMENT";

/**
 * The ONLY environment in which the market-selection default is permitted. It is
 * an exact, case-insensitive match: `dev`, `local` and `development-ish` are all
 * governed, because a convenience that activates on a near-miss is not isolated.
 */
export const DEVELOPMENT_ENVIRONMENT = "development";

/** Stable prefix so a refusal is greppable in logs and CI output. */
export const DEPLOYMENT_IDENTITY_REFUSED = "DEPLOYMENT_IDENTITY_REFUSED";

export type DeploymentIdentityRefusalCode =
    | "MISSING_SCP_TENANT_ID"
    | "MISSING_SCP_ENVIRONMENT"
    | "MISSING_ACTIVE_MARKET"
    | "UNKNOWN_MARKET";

export class DeploymentIdentityError extends Error {
    public readonly code: DeploymentIdentityRefusalCode;

    public constructor(code: DeploymentIdentityRefusalCode, message: string) {
        super(`${DEPLOYMENT_IDENTITY_REFUSED} ${code}: ${message}`);
        this.name = "DeploymentIdentityError";
        this.code = code;
    }
}

/**
 * Whether this environment is governed — i.e. canonical SCP runtime may serve
 * tenant traffic or persist governed state, so identity must be explicit.
 *
 * Everything is governed except an exact `development`. Defaulting to governed
 * is deliberate: a new environment name nobody thought about is treated as
 * production-like rather than as a laptop.
 */
export function isGovernedEnvironment(environment: string): boolean {
    return environment.trim().toLowerCase() !== DEVELOPMENT_ENVIRONMENT;
}

function required(
    env: NodeJS.ProcessEnv,
    name: string,
    code: DeploymentIdentityRefusalCode
): string {
    const value = env[name]?.trim();
    if (!value) {
        throw new DeploymentIdentityError(
            code,
            `${name} is not set. Deployment identity fails closed: startup will not guess a tenant or environment.`
        );
    }
    return value;
}

/**
 * Resolves the identity this process is deployed as, for handing to
 * `startRuntime`.
 *
 * Fails closed on a missing tenant or environment always, and on a missing
 * market whenever the environment is governed. It substitutes no production
 * identity and has no fallback: a deployment that cannot say who it is does not
 * start.
 */
export function resolveDeploymentIdentity(env: NodeJS.ProcessEnv = process.env): IdentityInput {
    const tenantId = required(env, TENANT_ID_VAR, "MISSING_SCP_TENANT_ID");
    const environment = required(env, ENVIRONMENT_VAR, "MISSING_SCP_ENVIRONMENT");
    const governed = isGovernedEnvironment(environment);

    let marketId: string;
    try {
        // Through the chokepoint, never around it.
        marketId = getActiveMarketConfig(env, { requireExplicit: governed }).marketId;
    } catch (error) {
        if (error instanceof MarketSelectionError) {
            // The chokepoint decided; this boundary only restates its verdict in
            // deployment terms, preserving the machine-readable reason.
            throw new DeploymentIdentityError(error.code, error.message);
        }
        throw error;
    }

    if (!governed && env["ACTIVE_MARKET"] === undefined) {
        // 5.2(3): a convenience that is invisible is indistinguishable from a bug.
        // eslint-disable-next-line no-console
        console.warn(
            `[deployment-identity] ACTIVE_MARKET unset; using the development default "${marketId}" ` +
                `because ${ENVIRONMENT_VAR}="${environment}". This path cannot be reached in a governed environment.`
        );
    }

    return { tenantId, marketId, environment };
}
