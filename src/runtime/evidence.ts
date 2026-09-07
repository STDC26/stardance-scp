// SCP Runtime — normalized runtime evidence.
//
// Operational evidence, NOT business truth. Canonical SCP events and records
// remain the measurement authority; nothing written here is ever read back as
// authority for a lifecycle decision. Every row carries tenant/market/
// environment lineage, enforced by a NOT NULL + non-empty check in migration
// 009 rather than by convention.

import type { PoolClient } from "pg";
import type { IdentityLineage } from "./identity";

export type RuntimeEvidenceKind =
    | "RUNTIME_START"
    | "CONFIGURATION_RESOLVED"
    | "CONFIGURATION_REFUSED"
    | "IDENTITY_RESOLVED"
    | "IDENTITY_REFUSED"
    | "PERSISTENCE_VERIFIED"
    | "PERSISTENCE_REFUSED"
    | "ADAPTER_ATTEMPT"
    | "ADAPTER_RESULT";

export interface RuntimeEvidenceInput {
    kind: RuntimeEvidenceKind;
    lineage: IdentityLineage;
    outcome: "OK" | "REFUSED";
    reasonCode?: string | null;
    configurationVersion?: number | null;
    configurationChecksum?: string | null;
    detail?: Record<string, unknown>;
}

export async function recordRuntimeEvidence(
    client: PoolClient,
    input: RuntimeEvidenceInput
): Promise<number> {
    const { rows } = await client.query<{ evidence_id: string }>(
        `INSERT INTO core_runtime_evidence
            (kind, tenant_id, market_id, environment, configuration_version,
             configuration_checksum, outcome, reason_code, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         RETURNING evidence_id`,
        [
            input.kind,
            input.lineage.tenantId,
            input.lineage.marketId,
            input.lineage.environment,
            input.configurationVersion ?? null,
            input.configurationChecksum ?? null,
            input.outcome,
            input.reasonCode ?? null,
            JSON.stringify(input.detail ?? {})
        ]
    );
    return Number(rows[0]!.evidence_id);
}

export interface RuntimeEvidenceRow {
    kind: RuntimeEvidenceKind;
    tenantId: string;
    marketId: string;
    environment: string;
    outcome: "OK" | "REFUSED";
    reasonCode: string | null;
    configurationVersion: number | null;
    configurationChecksum: string | null;
    detail: Record<string, unknown>;
}

export async function runtimeEvidenceFor(
    client: PoolClient,
    lineage: IdentityLineage
): Promise<RuntimeEvidenceRow[]> {
    const { rows } = await client.query<{
        kind: RuntimeEvidenceKind;
        tenant_id: string;
        market_id: string;
        environment: string;
        outcome: "OK" | "REFUSED";
        reason_code: string | null;
        configuration_version: number | null;
        configuration_checksum: string | null;
        detail: Record<string, unknown>;
    }>(
        `SELECT kind, tenant_id, market_id, environment, outcome, reason_code,
                configuration_version, configuration_checksum, detail
           FROM core_runtime_evidence
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
          ORDER BY evidence_id ASC`,
        [lineage.tenantId, lineage.marketId, lineage.environment]
    );
    return rows.map((r) => ({
        kind: r.kind,
        tenantId: r.tenant_id,
        marketId: r.market_id,
        environment: r.environment,
        outcome: r.outcome,
        reasonCode: r.reason_code,
        configurationVersion: r.configuration_version,
        configurationChecksum: r.configuration_checksum,
        detail: r.detail
    }));
}
