// LAB-INFRA-01B — the one place a deployment says who it is.
//
// `startRuntime` requires tenantId, marketId and environment and refuses to
// guess any of them (IDENTITY_NOT_CONFIGURED). Until now the only suppliers were
// the hosts, which receive identity as a constructor input — so a process that
// is not one of those hosts had no way to state its identity at all. That is
// what this file supplies, and the entire reason it exists.
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
// chokepoint, which also validates it against the registry and throws on an
// unknown id.

import { getActiveMarketConfig } from "../config/marketConfig";
import type { IdentityInput } from "./identity";

/** The tenant this deployment serves. No default — a wrong tenant is worse than no start. */
export const TENANT_ID_VAR = "SCP_TENANT_ID";

/** The deployment environment, e.g. `uat`. No default, for the same reason. */
export const ENVIRONMENT_VAR = "SCP_ENVIRONMENT";

export class DeploymentIdentityError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DeploymentIdentityError";
    }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) {
        throw new DeploymentIdentityError(
            `${name} is not set. Deployment identity fails closed: startup will not guess a tenant or environment.`
        );
    }
    return value;
}

/**
 * Resolves the identity this process is deployed as, for handing to
 * `startRuntime`.
 *
 * Fails closed on a missing tenant or environment. It does not substitute a
 * production identity, and it has no fallback: a deployment that cannot say who
 * it is does not start.
 */
export function resolveDeploymentIdentity(env: NodeJS.ProcessEnv = process.env): IdentityInput {
    const tenantId = required(env, TENANT_ID_VAR);
    const environment = required(env, ENVIRONMENT_VAR);

    // Through the chokepoint, never around it.
    const marketId = getActiveMarketConfig(env).marketId;

    return { tenantId, marketId, environment };
}
