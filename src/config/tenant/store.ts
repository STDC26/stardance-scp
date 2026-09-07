// SCP Tenant Configuration — versioning, activation and rollback.
//
// Rules made structural rather than procedural:
//   * an invalid configuration cannot activate
//   * an unapproved configuration cannot activate
//   * activation is atomic per bundle version (one ACTIVE row per scope,
//     enforced by a partial unique index)
//   * rollback REACTIVATES a previously proven version as a new activation
//     event; no historical row is ever rewritten
//   * every state change is appended to an event log

import type { PoolClient } from "pg";
import { fail, succeed, type GovernedOutcome } from "../../core/types";
import type { ConfigurationState, TenantConfigurationBundle } from "./contract";
import { configurationChecksum, configurationReference } from "./identity";
import { validateTenantConfiguration, type ValidationFinding } from "./validate";

export interface StoredConfiguration {
    configurationId: string;
    tenantId: string;
    marketId: string;
    environment: string;
    configurationVersion: number;
    schemaVersion: string;
    state: ConfigurationState;
    checksum: string;
    predecessorVersion: number | null;
    actorOrAuthority: string;
    sourceReference: string;
    createdAt: Date;
    activatedAt: Date | null;
    bundle: TenantConfigurationBundle;
}

const COLUMNS = `configuration_id, tenant_id, market_id, environment, configuration_version,
                 schema_version, state, checksum, predecessor_version, actor_or_authority,
                 source_reference, created_at, activated_at, bundle`;

function toStored(row: Record<string, unknown>): StoredConfiguration {
    return {
        configurationId: row["configuration_id"] as string,
        tenantId: row["tenant_id"] as string,
        marketId: row["market_id"] as string,
        environment: row["environment"] as string,
        configurationVersion: row["configuration_version"] as number,
        schemaVersion: row["schema_version"] as string,
        state: row["state"] as ConfigurationState,
        checksum: row["checksum"] as string,
        predecessorVersion: (row["predecessor_version"] as number | null) ?? null,
        actorOrAuthority: row["actor_or_authority"] as string,
        sourceReference: row["source_reference"] as string,
        createdAt: row["created_at"] as Date,
        activatedAt: (row["activated_at"] as Date | null) ?? null,
        bundle: row["bundle"] as TenantConfigurationBundle
    };
}

async function recordEvent(
    client: PoolClient,
    config: StoredConfiguration,
    fromState: ConfigurationState | null,
    toState: ConfigurationState,
    actor: string,
    reason?: string
): Promise<void> {
    await client.query(
        `INSERT INTO core_tenant_configuration_event
            (configuration_id, tenant_id, market_id, environment, from_state, to_state,
             actor_or_authority, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
            config.configurationId,
            config.tenantId,
            config.marketId,
            config.environment,
            fromState,
            toState,
            actor,
            reason ?? null
        ]
    );
}

export interface PublishInput {
    bundle: TenantConfigurationBundle;
    actorOrAuthority: string;
    sourceReference: string;
}

export interface PublishResult {
    configuration: StoredConfiguration;
    findings: ValidationFinding[];
}

/**
 * Persists a bundle version and validates it. A bundle that fails validation is
 * still recorded — as REJECTED, with its findings — because a rejected proposal
 * is governance evidence, not something to discard silently.
 */
export async function publishConfiguration(
    client: PoolClient,
    input: PublishInput
): Promise<GovernedOutcome<PublishResult>> {
    const bundle = input.bundle;
    const validation = validateTenantConfiguration(bundle);
    const checksum = configurationChecksum(bundle);

    const prior = await client.query<{ configuration_version: number }>(
        `SELECT configuration_version FROM core_tenant_configuration
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
          ORDER BY configuration_version DESC LIMIT 1`,
        [bundle.tenant.id, bundle.tenant.market, bundle.environment]
    );
    const predecessor = prior.rows[0]?.configuration_version ?? null;

    if (predecessor !== null && bundle.configurationVersion <= predecessor) {
        return fail(
            "STALE_STATE",
            `configuration version ${bundle.configurationVersion} does not advance past ${predecessor}`
        );
    }

    const state: ConfigurationState = validation.valid ? "VALIDATED" : "REJECTED";

    const inserted = await client.query(
        `INSERT INTO core_tenant_configuration
            (tenant_id, market_id, environment, configuration_version, schema_version, state,
             bundle, checksum, predecessor_version, actor_or_authority, source_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         RETURNING ${COLUMNS}`,
        [
            bundle.tenant.id,
            bundle.tenant.market,
            bundle.environment,
            bundle.configurationVersion,
            bundle.schemaVersion,
            state,
            JSON.stringify(bundle),
            checksum,
            predecessor,
            input.actorOrAuthority,
            input.sourceReference
        ]
    );
    const configuration = toStored(inserted.rows[0]!);
    await recordEvent(
        client,
        configuration,
        "DRAFT",
        state,
        input.actorOrAuthority,
        validation.valid ? configurationReference(bundle) : validation.findings[0]?.code
    );

    return succeed({ configuration, findings: validation.findings });
}

/** Marks a VALIDATED configuration APPROVED. Only approved versions activate. */
export async function approveConfiguration(
    client: PoolClient,
    configurationId: string,
    actor: string
): Promise<GovernedOutcome<StoredConfiguration>> {
    const { rows } = await client.query(
        `UPDATE core_tenant_configuration SET state = 'APPROVED'
          WHERE configuration_id = $1 AND state = 'VALIDATED'
      RETURNING ${COLUMNS}`,
        [configurationId]
    );
    const row = rows[0];
    if (!row) {
        const current = await loadConfiguration(client, configurationId);
        return fail(
            "STALE_STATE",
            `configuration ${configurationId} is ${current?.state ?? "absent"}, not VALIDATED`
        );
    }
    const configuration = toStored(row);
    await recordEvent(client, configuration, "VALIDATED", "APPROVED", actor);
    return succeed(configuration);
}

export interface ActivationResult {
    activated: StoredConfiguration;
    superseded: StoredConfiguration | null;
}

/**
 * Activates an APPROVED configuration atomically. The previously active version
 * becomes SUPERSEDED in the same transaction; the partial unique index means the
 * two states can never overlap.
 */
export async function activateConfiguration(
    client: PoolClient,
    configurationId: string,
    actor: string
): Promise<GovernedOutcome<ActivationResult>> {
    const candidate = await loadConfiguration(client, configurationId, true);
    if (!candidate) {
        return fail("NOT_FOUND", `configuration ${configurationId} not found`);
    }
    if (candidate.state !== "APPROVED") {
        return fail(
            "INVALID_TRANSITION",
            `configuration ${configurationId} is ${candidate.state}; only an APPROVED configuration may activate`
        );
    }

    const superseded = await supersedeActive(
        client,
        candidate.tenantId,
        candidate.marketId,
        candidate.environment,
        actor
    );

    const { rows } = await client.query(
        `UPDATE core_tenant_configuration
            SET state = 'ACTIVE', activated_at = now()
          WHERE configuration_id = $1 AND state = 'APPROVED'
      RETURNING ${COLUMNS}`,
        [configurationId]
    );
    const row = rows[0];
    if (!row) {
        return fail("STALE_STATE", "configuration changed concurrently");
    }
    const activated = toStored(row);
    await recordEvent(client, activated, "APPROVED", "ACTIVE", actor);
    return succeed({ activated, superseded });
}

async function supersedeActive(
    client: PoolClient,
    tenantId: string,
    marketId: string,
    environment: string,
    actor: string,
    reason?: string
): Promise<StoredConfiguration | null> {
    const { rows } = await client.query(
        `UPDATE core_tenant_configuration
            SET state = 'SUPERSEDED', superseded_at = now()
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3 AND state = 'ACTIVE'
      RETURNING ${COLUMNS}`,
        [tenantId, marketId, environment]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    const superseded = toStored(row);
    await recordEvent(client, superseded, "ACTIVE", "SUPERSEDED", actor, reason);
    return superseded;
}

/**
 * Rollback: reactivate a previously proven version.
 *
 * The prior row is NOT rewritten and no history is mutated — the version being
 * rolled back to returns to ACTIVE and the version being rolled back from
 * becomes SUPERSEDED, with both transitions appended to the event log. The
 * configuration timeline therefore shows that a rollback happened rather than
 * pretending the newer version never existed.
 */
export async function rollbackToVersion(
    client: PoolClient,
    scope: { tenantId: string; marketId: string; environment: string },
    targetVersion: number,
    actor: string,
    reason: string
): Promise<GovernedOutcome<ActivationResult>> {
    const target = await loadVersion(client, scope, targetVersion, true);
    if (!target) {
        return fail("NOT_FOUND", `configuration version ${targetVersion} not found`);
    }
    if (target.state === "REJECTED" || target.state === "DRAFT") {
        return fail(
            "INVALID_TRANSITION",
            `version ${targetVersion} is ${target.state} and was never proven; it cannot be rolled back to`
        );
    }
    if (target.state === "ACTIVE") {
        return succeed({ activated: target, superseded: null });
    }

    const superseded = await supersedeActive(
        client,
        scope.tenantId,
        scope.marketId,
        scope.environment,
        actor,
        reason
    );

    const { rows } = await client.query(
        `UPDATE core_tenant_configuration
            SET state = 'ACTIVE', activated_at = now(), superseded_at = NULL
          WHERE configuration_id = $1
      RETURNING ${COLUMNS}`,
        [target.configurationId]
    );
    const activated = toStored(rows[0]!);
    await recordEvent(client, activated, target.state, "ACTIVE", actor, `ROLLBACK: ${reason}`);
    return succeed({ activated, superseded });
}

export async function loadConfiguration(
    client: PoolClient,
    configurationId: string,
    forUpdate = false
): Promise<StoredConfiguration | null> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_tenant_configuration
          WHERE configuration_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [configurationId]
    );
    return rows[0] ? toStored(rows[0]) : null;
}

export async function loadVersion(
    client: PoolClient,
    scope: { tenantId: string; marketId: string; environment: string },
    configurationVersion: number,
    forUpdate = false
): Promise<StoredConfiguration | null> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_tenant_configuration
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3
            AND configuration_version = $4 ${forUpdate ? "FOR UPDATE" : ""}`,
        [scope.tenantId, scope.marketId, scope.environment, configurationVersion]
    );
    return rows[0] ? toStored(rows[0]) : null;
}

/** The configuration currently governing this tenant/market/environment. */
export async function activeConfiguration(
    client: PoolClient,
    scope: { tenantId: string; marketId: string; environment: string }
): Promise<StoredConfiguration | null> {
    const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM core_tenant_configuration
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3 AND state = 'ACTIVE'`,
        [scope.tenantId, scope.marketId, scope.environment]
    );
    return rows[0] ? toStored(rows[0]) : null;
}

export async function configurationHistory(
    client: PoolClient,
    scope: { tenantId: string; marketId: string; environment: string }
): Promise<Array<{ configurationVersion: number; fromState: string | null; toState: string }>> {
    const { rows } = await client.query<{
        configuration_version: number;
        from_state: string | null;
        to_state: string;
    }>(
        `SELECT c.configuration_version, e.from_state, e.to_state
           FROM core_tenant_configuration_event e
           JOIN core_tenant_configuration c ON c.configuration_id = e.configuration_id
          WHERE e.tenant_id = $1 AND e.market_id = $2 AND e.environment = $3
          ORDER BY e.event_id ASC`,
        [scope.tenantId, scope.marketId, scope.environment]
    );
    return rows.map((r) => ({
        configurationVersion: r.configuration_version,
        fromState: r.from_state,
        toState: r.to_state
    }));
}
