// LAB-INFRA-01B — activates the synthetic UAT configuration through the real
// governed lifecycle, and through nothing else.
//
// The temptation this file exists to refuse: a single INSERT setting
// state = 'ACTIVE' would make the Experience Lab start in one line. It would also
// mean UAT never exercises publish validation, never exercises the
// VALIDATED -> APPROVED -> ACTIVE transitions, and never exercises supersession —
// so the first time that machinery mattered would be in production, untested.
// UAT isolation is achieved by using a synthetic TENANT LINEAGE, never by
// bypassing the configuration plane.
//
// All three steps run inside one transaction. Activation is either wholly true or
// wholly absent; a database left holding an APPROVED-but-not-ACTIVE row after a
// mid-sequence failure would be a governance state nobody asked for.

import type { PoolClient } from "pg";
import type { Pool } from "pg";

import { withTransaction } from "../db/pool";
import { FRESHLINE_BALI_V2 } from "../config/tenant/freshline";
import {
    asPublishableBundle,
    deriveUatBundle,
    FRESHLINE_UAT_LINEAGE,
    type UatLineage
} from "../config/tenant/uat";
import {
    activateConfiguration,
    approveConfiguration,
    publishConfiguration
} from "../config/tenant/store";

/**
 * Recorded verbatim in the audit trail, so a reviewer can see why the actor was
 * permitted rather than merely that it acted.
 */
export const UAT_ACTOR = "LAB-INFRA-01B/EXE";

/** Where the bundle came from. Traceable to the accepted artifact, not invented. */
export const UAT_SOURCE_REFERENCE = "config/tenants/freshline-bali.v2.json (derived: UAT lineage)";

export interface UatActivationEvidence {
    configurationId: string;
    tenantId: string;
    marketId: string;
    environment: string;
    configurationVersion: number;
    schemaVersion: string;
    checksum: string;
    predecessorVersion: number | null;
    publishedState: string;
    approvedState: string;
    activatedState: string;
    supersededCount: number;
    validationFindings: number;
}

export class UatActivationError extends Error {
    public readonly code: string;

    public constructor(step: string, code: string, message: string) {
        super(`${step} refused (${code}): ${message}`);
        this.name = "UatActivationError";
        this.code = code;
    }
}

/**
 * Publishes, approves and activates the UAT configuration for `lineage`.
 *
 * Every refusal is surfaced as an error carrying the governed failure code. None
 * of them is worked around here — a refusal from the configuration plane is the
 * plane doing its job, and the caller's business is to report it.
 */
export async function activateUatConfiguration(
    pool: Pool,
    lineage: UatLineage = FRESHLINE_UAT_LINEAGE
): Promise<UatActivationEvidence> {
    const bundle = deriveUatBundle(FRESHLINE_BALI_V2, lineage);

    return withTransaction(pool, async (client: PoolClient) => {
        const published = await publishConfiguration(client, {
            bundle: asPublishableBundle(bundle),
            actorOrAuthority: UAT_ACTOR,
            sourceReference: UAT_SOURCE_REFERENCE
        });
        if (!published.ok) {
            throw new UatActivationError("publishConfiguration", published.code, published.message);
        }

        const stored = published.value.configuration;

        const approved = await approveConfiguration(client, stored.configurationId, UAT_ACTOR);
        if (!approved.ok) {
            throw new UatActivationError("approveConfiguration", approved.code, approved.message);
        }

        const activated = await activateConfiguration(client, stored.configurationId, UAT_ACTOR);
        if (!activated.ok) {
            throw new UatActivationError("activateConfiguration", activated.code, activated.message);
        }

        const active = activated.value.activated;

        return {
            configurationId: active.configurationId,
            tenantId: active.tenantId,
            marketId: active.marketId,
            environment: active.environment,
            configurationVersion: active.configurationVersion,
            schemaVersion: active.schemaVersion,
            checksum: active.checksum,
            predecessorVersion: active.predecessorVersion,
            publishedState: stored.state,
            approvedState: approved.value.state,
            activatedState: active.state,
            supersededCount: activated.value.superseded === null ? 0 : 1,
            validationFindings: published.value.findings.length
        };
    });
}
