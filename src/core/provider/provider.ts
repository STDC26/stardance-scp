// SCP Core Foundation — Provider.
//
// CANONICAL_PROVIDER_MODEL: PROVIDER is the single authoritative supply
// aggregate. "Partner" is an experience/business term with no aggregate of its
// own; "Contractor" is migration-era implementation vocabulary that survives
// only as a tracked alias resolved through `resolveLegacyContractorId`.
//
// FOUNDATIONAL_INVARIANT: submitted profile != approved supply. Only APPROVED
// providers are dispatchable.

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type GovernedOutcome, type ProviderSupplyStatus } from "../types";
import { recordEvent } from "../events/eventLog";

export interface Provider {
    providerId: string;
    marketId: string;
    identityId: string;
    displayName: string;
    supplyStatus: ProviderSupplyStatus;
}

export async function loadProvider(
    client: PoolClient,
    providerId: string
): Promise<Provider | null> {
    const { rows } = await client.query<{
        provider_id: string;
        market_id: string;
        identity_id: string;
        display_name: string;
        supply_status: ProviderSupplyStatus;
    }>(
        `SELECT provider_id, market_id, identity_id, display_name, supply_status
           FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        providerId: row.provider_id,
        marketId: row.market_id,
        identityId: row.identity_id,
        displayName: row.display_name,
        supplyStatus: row.supply_status
    };
}

/**
 * Approves submitted supply. Separate command from creation precisely because
 * a submitted profile must not be dispatchable by default.
 */
export async function approveProviderSupply(
    client: PoolClient,
    providerId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<Provider>> {
    const provider = await loadProvider(client, providerId);
    if (!provider) {
        return fail("NOT_FOUND", `provider ${providerId} not found`);
    }
    if (provider.supplyStatus === "APPROVED") {
        return succeed(provider);
    }
    await client.query(
        `UPDATE core_provider SET supply_status = 'APPROVED', updated_at = now()
          WHERE provider_id = $1`,
        [providerId]
    );
    await recordEvent(client, {
        marketId: provider.marketId,
        objectType: "PROVIDER",
        objectId: providerId,
        fromState: provider.supplyStatus,
        toState: "APPROVED",
        actor,
        idempotencyKey
    });
    return succeed({ ...provider, supplyStatus: "APPROVED" });
}

/** Dispatchability gate. Used by the dispatch module before offering work. */
export function isDispatchable(provider: Provider): boolean {
    return provider.supplyStatus === "APPROVED";
}

/**
 * Registers a migration alias. The unique constraint on (alias_kind,
 * alias_value) is what prevents one legacy contractor id from resolving to two
 * Providers, i.e. what prevents the alias becoming a competing authority.
 */
export async function registerLegacyContractorAlias(
    client: PoolClient,
    providerId: string,
    legacyContractorId: string,
    note?: string
): Promise<GovernedOutcome<string>> {
    const { rows } = await client.query<{ alias_id: string }>(
        `INSERT INTO core_provider_alias (provider_id, alias_kind, alias_value, note)
         VALUES ($1, 'LEGACY_CONTRACTOR_ID', $2, $3)
         ON CONFLICT (alias_kind, alias_value) DO NOTHING
         RETURNING alias_id`,
        [providerId, legacyContractorId, note ?? null]
    );
    const row = rows[0];
    if (!row) {
        return fail(
            "INVALID_TRANSITION",
            `legacy contractor id ${legacyContractorId} is already aliased to a different provider`
        );
    }
    return succeed(row.alias_id);
}

/** Translates migration-era vocabulary into canonical Provider identity. */
export async function resolveLegacyContractorId(
    client: PoolClient,
    legacyContractorId: string
): Promise<Provider | null> {
    const { rows } = await client.query<{ provider_id: string }>(
        `SELECT provider_id FROM core_provider_alias
          WHERE alias_kind = 'LEGACY_CONTRACTOR_ID' AND alias_value = $1`,
        [legacyContractorId]
    );
    const row = rows[0];
    return row ? loadProvider(client, row.provider_id) : null;
}
