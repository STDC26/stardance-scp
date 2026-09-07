// SCP-G5-E — the shared idempotency and lineage envelope for provider commands.
//
// Every binding provider or Owner command routes through here, so idempotency,
// concurrency serialization and lineage are enforced in exactly one place
// rather than re-implemented (and eventually mis-implemented) per command.
//
// The order is the safety property:
//
//   1. take a transaction-scoped advisory lock on the idempotency key, so
//      simultaneous retries queue instead of racing the unique index and
//      receiving a raw SQLSTATE 23505 instead of a governed answer
//   2. look for a prior claim on that key
//        same fingerprint      -> REPLAY, answer with the original result
//        different fingerprint -> CONFLICT, a reused key is not a replay
//   3. otherwise the caller does the work and records the claim, which the
//      unique index backstops
//
// Nothing here is ever read as authority for an approval or an eligibility
// decision; it answers "have I already done this?" and nothing else.

import type { PoolClient } from "pg";
import type { ProviderScope } from "./contracts";

export type ProviderCommand =
    | "PROVIDER_PROFILE_SUBMIT"
    | "PROVIDER_CARD_SUBMIT"
    | "PROVIDER_CARD_APPROVE"
    | "PROVIDER_CARD_REJECT"
    | "PROVIDER_AVAILABILITY_SUBMIT"
    | "PROVIDER_AVAILABILITY_CONFIRM"
    | "PROVIDER_MEDIA_UPLOAD";

export type IdempotencyClaim =
    | { kind: "FRESH" }
    | { kind: "REPLAY"; resultRef: string | null; providerId: string | null }
    | { kind: "CONFLICT"; message: string };

/**
 * Serializes contenders for one key and reports whether this command has
 * already been performed. Must be called inside a transaction.
 */
export async function claimIdempotency(
    client: PoolClient,
    scope: ProviderScope,
    command: ProviderCommand,
    idempotencyKey: string,
    fingerprint: string
): Promise<IdempotencyClaim> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `provider-ingress:${scope.tenantId}:${scope.marketId}:${scope.environment}:${idempotencyKey}`
    ]);

    const { rows } = await client.query<{
        command: string;
        request_fingerprint: string;
        result_ref: string | null;
        provider_id: string | null;
    }>(
        `SELECT command, request_fingerprint, result_ref, provider_id
           FROM core_provider_ingress
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3 AND idempotency_key = $4`,
        [scope.tenantId, scope.marketId, scope.environment, idempotencyKey]
    );
    const prior = rows[0];
    if (!prior) {
        return { kind: "FRESH" };
    }
    // A key reused for a DIFFERENT command is as much a collision as a key
    // reused for different content; both mean the caller lost track of it.
    if (prior.command !== command || prior.request_fingerprint !== fingerprint) {
        return {
            kind: "CONFLICT",
            message: `idempotency key ${idempotencyKey} was already used for a materially different command`
        };
    }
    return { kind: "REPLAY", resultRef: prior.result_ref, providerId: prior.provider_id };
}

export interface RecordIngressInput {
    scope: ProviderScope;
    command: ProviderCommand;
    idempotencyKey: string;
    fingerprint: string;
    actorIdentityId: string;
    actorRole: string;
    providerId: string | null;
    resultRef: string | null;
    configurationVersion: number;
    configurationChecksum: string;
    correlationId: string;
}

export async function recordProviderIngress(
    client: PoolClient,
    input: RecordIngressInput
): Promise<void> {
    await client.query(
        `INSERT INTO core_provider_ingress
            (tenant_id, market_id, environment, command, idempotency_key, request_fingerprint,
             actor_identity_id, actor_role, provider_id, result_ref,
             configuration_version, configuration_checksum, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
            input.scope.tenantId,
            input.scope.marketId,
            input.scope.environment,
            input.command,
            input.idempotencyKey,
            input.fingerprint,
            input.actorIdentityId,
            input.actorRole,
            input.providerId,
            input.resultRef,
            input.configurationVersion,
            input.configurationChecksum,
            input.correlationId
        ]
    );
}
