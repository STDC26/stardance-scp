// SCP-G5-E — Provider Card submission and the separate Owner approval.
//
// Three acts that a prototype would happily collapse into one, kept apart here
// because the business meaning of each is different:
//
//   SUBMISSION   the partner says "I am ready to be reviewed". Grants nothing.
//   APPROVAL     an Owner says "yes". This is the moment a Partner ID is
//                assigned and supply is activated.
//   ACTIVATION   `core_provider.supply_status = 'APPROVED'`, written by the
//                existing G2 Core command, not by anything invented here.
//
// The Card itself owns no approval state of its own: it is a projection over a
// specific profile VERSION, so a card approved against version 2 cannot quietly
// come to describe version 3.
//
// The Partner ID is assigned here and only here. There is no field in any
// contract through which a client could propose one, and the sequence is drawn
// server-side under a lock, so C03 holds structurally rather than by validation.

import type { PoolClient } from "pg";
import { approveProviderSupply } from "../core/provider/provider";
import type { Actor } from "../core/types";
import { recordRuntimeEvidence } from "../runtime/evidence";
import type { IdentityLineage } from "../runtime/identity";
import { resolveCatalogueIdentity } from "../customer/catalogueProjection";
import {
    digest,
    parseCardDecisionIntent,
    parseCardSubmitIntent,
    deriveIdempotencyKey,
    type ProviderScope
} from "./contracts";
import { claimIdempotency, recordProviderIngress } from "./ingress";
import { currentProfile, refuse, type ProviderCommandContext, type ProviderOutcome } from "./profile";

export type CardState = "SUBMITTED" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export interface ProviderCard {
    cardId: string;
    providerId: string;
    profileId: string;
    state: CardState;
    submittedAt: Date;
    decidedAt: Date | null;
    decidedByIdentityId: string | null;
    decisionReason: string | null;
}

export interface SubmittedCard {
    cardId: string;
    providerId: string;
    profileId: string;
    state: CardState;
    /** Always SUBMITTED. Present so the caller can see nothing was activated. */
    supplyStatus: string;
    publicId: string | null;
}

export interface ApprovedCard {
    cardId: string;
    providerId: string;
    state: CardState;
    supplyStatus: string;
    publicId: string;
}

function scopeOf(context: ProviderCommandContext): ProviderScope {
    return {
        tenantId: context.configuration.identity.tenantId,
        marketId: context.configuration.identity.marketId,
        environment: context.configuration.identity.environment
    };
}

function lineageOf(context: ProviderCommandContext): IdentityLineage {
    return scopeOf(context);
}

export async function loadCard(client: PoolClient, cardId: string): Promise<ProviderCard | null> {
    const { rows } = await client.query<{
        card_id: string;
        provider_id: string;
        profile_id: string;
        state: CardState;
        submitted_at: Date;
        decided_at: Date | null;
        decided_by_identity_id: string | null;
        decision_reason: string | null;
        tenant_id: string;
        market_id: string;
        environment: string;
    }>(
        `SELECT card_id, provider_id, profile_id, state, submitted_at, decided_at,
                decided_by_identity_id, decision_reason, tenant_id, market_id, environment
           FROM core_provider_card WHERE card_id = $1`,
        [cardId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        cardId: row.card_id,
        providerId: row.provider_id,
        profileId: row.profile_id,
        state: row.state,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        decidedByIdentityId: row.decided_by_identity_id,
        decisionReason: row.decision_reason
    };
}

async function supplyStatusOf(client: PoolClient, providerId: string): Promise<string> {
    const { rows } = await client.query<{ supply_status: string }>(
        `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );
    return rows[0]?.supply_status ?? "UNKNOWN";
}

export async function publicIdOf(client: PoolClient, providerId: string): Promise<string | null> {
    const { rows } = await client.query<{ public_id: string }>(
        `SELECT public_id FROM core_provider_public_id WHERE provider_id = $1`,
        [providerId]
    );
    return rows[0]?.public_id ?? null;
}

/**
 * Submits the current profile version for Owner review. Nothing about the
 * provider's supply status changes; the partial unique index guarantees at most
 * one card is awaiting review at a time.
 */
export async function submitProviderCard(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<SubmittedCard>> {
    const configuration = context.configuration;
    const scope = scopeOf(context);
    const lineage = lineageOf(context);

    const recordRefusal = async <T>(outcome: ProviderOutcome<T>): Promise<ProviderOutcome<T>> => {
        if (!outcome.ok) {
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_INGRESS_REFUSED",
                lineage,
                outcome: "REFUSED",
                reasonCode: outcome.reason,
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    command: "PROVIDER_CARD_SUBMIT",
                    correlationId: context.correlationId,
                    message: outcome.message,
                    findings: outcome.findings ?? []
                }
            });
        }
        return outcome;
    };

    if (context.session.role !== "PROVIDER") {
        return recordRefusal(
            refuse("NOT_PROVIDER_OWNER_OF_RECORD", "a card may only be submitted from a provider session")
        );
    }
    const providerId = context.session.providerId;
    if (!providerId) {
        return recordRefusal(
            refuse("PROFILE_NOT_SUBMITTED", "submit a provider profile before submitting a card")
        );
    }

    const parsed = parseCardSubmitIntent(body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "card submission does not satisfy the contract",
                parsed.findings
            )
        );
    }

    const profile = await currentProfile(client, providerId);
    if (!profile) {
        return recordRefusal(
            refuse("PROFILE_NOT_SUBMITTED", "this provider has no profile to submit")
        );
    }

    const fingerprint = digest({
        command: "PROVIDER_CARD_SUBMIT",
        ...scope,
        providerId,
        profileId: profile.profileId
    });
    const idempotencyKey =
        parsed.intent.idempotencyKey ??
        deriveIdempotencyKey("pc", fingerprint, context.correlationId);

    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_CARD_SUBMIT",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return recordRefusal(refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message));
    }
    if (claim.kind === "REPLAY" && claim.resultRef) {
        const existing = await loadCard(client, claim.resultRef);
        if (existing) {
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_INGRESS_REPLAYED",
                lineage,
                outcome: "OK",
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    command: "PROVIDER_CARD_SUBMIT",
                    correlationId: context.correlationId,
                    idempotencyKey,
                    cardId: existing.cardId
                }
            });
            return {
                ok: true,
                replay: true,
                value: {
                    cardId: existing.cardId,
                    providerId: existing.providerId,
                    profileId: existing.profileId,
                    state: existing.state,
                    supplyStatus: await supplyStatusOf(client, providerId),
                    publicId: await publicIdOf(client, providerId)
                }
            };
        }
    }

    // A card already awaiting review is not replaced silently; the partner is
    // told, because two open cards would make "which one did the Owner approve"
    // ambiguous.
    const open = await client.query<{ card_id: string }>(
        `SELECT card_id FROM core_provider_card WHERE provider_id = $1 AND state = 'SUBMITTED'`,
        [providerId]
    );
    if (open.rows.length > 0) {
        return recordRefusal(
            refuse("CARD_ALREADY_OPEN", "a card is already awaiting Owner review for this provider")
        );
    }

    const inserted = await client.query<{ card_id: string }>(
        `INSERT INTO core_provider_card
            (provider_id, profile_id, tenant_id, market_id, environment, state,
             submitted_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,'SUBMITTED',$6)
         RETURNING card_id`,
        [
            providerId,
            profile.profileId,
            scope.tenantId,
            scope.marketId,
            scope.environment,
            context.session.identityId
        ]
    );
    const cardId = inserted.rows[0]!.card_id;

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_CARD_SUBMIT",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: context.session.role,
        providerId,
        resultRef: cardId,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    const supplyStatus = await supplyStatusOf(client, providerId);
    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_CARD_SUBMITTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            cardId,
            providerId,
            profileId: profile.profileId,
            // Stated in the record itself: submitting activated nothing.
            supplyStatusAfterSubmission: supplyStatus
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            cardId,
            providerId,
            profileId: profile.profileId,
            state: "SUBMITTED",
            supplyStatus,
            publicId: await publicIdOf(client, providerId)
        }
    };
}

/**
 * Assigns the governed Partner ID. Server-side sequence under the same
 * transaction lock as the approval, with a unique index as the backstop.
 */
async function assignPublicId(
    client: PoolClient,
    scope: ProviderScope,
    providerId: string,
    roleCode: string,
    cardId: string,
    ownerIdentityId: string
): Promise<string> {
    const existing = await publicIdOf(client, providerId);
    if (existing) {
        return existing;
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `partner-id:${scope.tenantId}:${scope.marketId}:${scope.environment}:${roleCode}`
    ]);
    const { rows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM core_provider_public_id
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3 AND role_code = $4`,
        [scope.tenantId, scope.marketId, scope.environment, roleCode]
    );
    const sequence = Number(rows[0]!.next);
    const publicId = `${roleCode}-${String(sequence).padStart(4, "0")}`;
    await client.query(
        `INSERT INTO core_provider_public_id
            (provider_id, tenant_id, market_id, environment, role_code, sequence, public_id,
             assigned_by_identity_id, assigned_by_card_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
            providerId,
            scope.tenantId,
            scope.marketId,
            scope.environment,
            roleCode,
            sequence,
            publicId,
            ownerIdentityId,
            cardId
        ]
    );
    return publicId;
}

/**
 * Materializes the provider's declared capabilities into the canonical
 * `core_provider_service` links G3 already reads. This is the point at which a
 * declared capability becomes a consumable one, and it happens only under Owner
 * approval.
 */
async function materializeCapabilities(
    client: PoolClient,
    lineage: IdentityLineage,
    providerId: string,
    serviceCodes: readonly string[]
): Promise<boolean> {
    for (const code of serviceCodes) {
        const catalogue = await resolveCatalogueIdentity(client, lineage, code, []);
        if (!catalogue) {
            return false;
        }
        await client.query(
            `INSERT INTO core_provider_service (provider_id, service_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [providerId, catalogue.serviceId]
        );
    }
    return true;
}

/**
 * Owner approval. Requires an OWNER session — a provider session reaching this
 * function is refused before anything is read, which is what makes "a provider
 * cannot approve itself" a property of the code rather than of the UI.
 */
export async function approveProviderCard(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<ApprovedCard>> {
    const configuration = context.configuration;
    const scope = scopeOf(context);
    const lineage = lineageOf(context);

    const recordRefusal = async <T>(outcome: ProviderOutcome<T>): Promise<ProviderOutcome<T>> => {
        if (!outcome.ok) {
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_INGRESS_REFUSED",
                lineage,
                outcome: "REFUSED",
                reasonCode: outcome.reason,
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    command: "PROVIDER_CARD_APPROVE",
                    correlationId: context.correlationId,
                    message: outcome.message
                }
            });
        }
        return outcome;
    };

    if (context.session.role !== "OWNER") {
        return recordRefusal(
            refuse("OWNER_AUTHORITY_REQUIRED", "card approval requires an Owner session")
        );
    }

    const parsed = parseCardDecisionIntent(body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "card decision does not satisfy the contract",
                parsed.findings
            )
        );
    }

    const fingerprint = digest({
        command: "PROVIDER_CARD_APPROVE",
        ...scope,
        cardId: parsed.intent.cardId
    });
    const idempotencyKey =
        parsed.intent.idempotencyKey ??
        deriveIdempotencyKey("ca", fingerprint, context.correlationId);

    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_CARD_APPROVE",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return recordRefusal(refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message));
    }

    const scoped = await client.query<{
        card_id: string;
        provider_id: string;
        profile_id: string;
        state: CardState;
    }>(
        `SELECT card_id, provider_id, profile_id, state FROM core_provider_card
          WHERE card_id = $1 AND tenant_id = $2 AND market_id = $3 AND environment = $4
          FOR UPDATE`,
        [parsed.intent.cardId, scope.tenantId, scope.marketId, scope.environment]
    );
    const card = scoped.rows[0];
    if (!card) {
        return recordRefusal(
            refuse("CROSS_TENANT_REFUSED", "no such card in this tenant, market and environment")
        );
    }

    if (claim.kind === "REPLAY" && card.state === "APPROVED") {
        return {
            ok: true,
            replay: true,
            value: {
                cardId: card.card_id,
                providerId: card.provider_id,
                state: card.state,
                supplyStatus: await supplyStatusOf(client, card.provider_id),
                publicId: (await publicIdOf(client, card.provider_id)) ?? ""
            }
        };
    }
    if (card.state !== "SUBMITTED") {
        return recordRefusal(
            refuse("CARD_NOT_OPEN", `card ${card.card_id} is ${card.state}, not awaiting a decision`)
        );
    }

    const profile = await currentProfile(client, card.provider_id);
    if (!profile) {
        return recordRefusal(refuse("PROFILE_NOT_SUBMITTED", "the provider has no profile"));
    }

    const publicId = await assignPublicId(
        client,
        scope,
        card.provider_id,
        profile.roleCode,
        card.card_id,
        context.session.identityId
    );

    // The PROVIDER role is granted HERE, by Owner authority, and nowhere else.
    // Until this line runs, the partner's identity holds no scoped role and
    // therefore no authority to respond to a dispatch offer.
    const providerIdentity = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_provider WHERE provider_id = $1`,
        [card.provider_id]
    );
    await client.query(
        `INSERT INTO core_identity_role (identity_id, market_id, role)
         VALUES ($1, $2, 'PROVIDER') ON CONFLICT DO NOTHING`,
        [providerIdentity.rows[0]!.identity_id, scope.marketId]
    );

    const capabilities = await materializeCapabilities(
        client,
        lineage,
        card.provider_id,
        profile.serviceCodes
    );
    if (!capabilities) {
        return recordRefusal(
            refuse(
                "CATALOGUE_NOT_PROJECTED",
                "a declared capability has no canonical catalogue binding in this runtime"
            )
        );
    }

    const actor: Actor = {
        identityId: context.session.identityId,
        role: "OWNER",
        authority: `OWNER_ROLE:${scope.marketId}+CARD_APPROVAL:${card.card_id}`
    };
    // Activation goes through the EXISTING G2 Core command, so supply status is
    // written in exactly one place in the codebase and the canonical PROVIDER
    // event is recorded by the module that owns it.
    const activated = await approveProviderSupply(
        client,
        card.provider_id,
        actor,
        `${idempotencyKey}:activate`
    );
    if (!activated.ok) {
        return recordRefusal(
            refuse("CANONICAL_REFUSAL", `${activated.code}: ${activated.message}`)
        );
    }

    await client.query(
        `UPDATE core_provider_card
            SET state = 'APPROVED', decided_at = now(), decided_by_identity_id = $2,
                decision_reason = $3
          WHERE card_id = $1`,
        [card.card_id, context.session.identityId, parsed.intent.reason]
    );

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_CARD_APPROVE",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: "OWNER",
        providerId: card.provider_id,
        resultRef: card.card_id,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_CARD_APPROVED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            cardId: card.card_id,
            providerId: card.provider_id,
            publicId,
            approvedByIdentityId: context.session.identityId,
            supplyStatus: activated.value.supplyStatus,
            // Approving a card says nothing about a schedule. Recorded so the
            // separation is visible in the evidence trail itself.
            availabilityConfirmed: false
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            cardId: card.card_id,
            providerId: card.provider_id,
            state: "APPROVED",
            supplyStatus: activated.value.supplyStatus,
            publicId
        }
    };
}

/** Owner rejection. Symmetric with approval, and equally Owner-only. */
export async function rejectProviderCard(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<{ cardId: string; providerId: string; state: CardState; supplyStatus: string }>> {
    const configuration = context.configuration;
    const scope = scopeOf(context);
    const lineage = lineageOf(context);

    if (context.session.role !== "OWNER") {
        return refuse("OWNER_AUTHORITY_REQUIRED", "card rejection requires an Owner session");
    }
    const parsed = parseCardDecisionIntent(body);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "card decision does not satisfy the contract",
            parsed.findings
        );
    }

    const fingerprint = digest({
        command: "PROVIDER_CARD_REJECT",
        ...scope,
        cardId: parsed.intent.cardId
    });
    const idempotencyKey =
        parsed.intent.idempotencyKey ??
        deriveIdempotencyKey("cr", fingerprint, context.correlationId);
    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_CARD_REJECT",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message);
    }

    const { rows } = await client.query<{ provider_id: string; state: CardState }>(
        `SELECT provider_id, state FROM core_provider_card
          WHERE card_id = $1 AND tenant_id = $2 AND market_id = $3 AND environment = $4
          FOR UPDATE`,
        [parsed.intent.cardId, scope.tenantId, scope.marketId, scope.environment]
    );
    const card = rows[0];
    if (!card) {
        return refuse("CROSS_TENANT_REFUSED", "no such card in this tenant, market and environment");
    }
    if (claim.kind === "REPLAY" && card.state === "REJECTED") {
        return {
            ok: true,
            replay: true,
            value: {
                cardId: parsed.intent.cardId,
                providerId: card.provider_id,
                state: card.state,
                supplyStatus: await supplyStatusOf(client, card.provider_id)
            }
        };
    }
    if (card.state !== "SUBMITTED") {
        return refuse("CARD_NOT_OPEN", `card is ${card.state}, not awaiting a decision`);
    }

    await client.query(
        `UPDATE core_provider_card
            SET state = 'REJECTED', decided_at = now(), decided_by_identity_id = $2,
                decision_reason = $3
          WHERE card_id = $1`,
        [parsed.intent.cardId, context.session.identityId, parsed.intent.reason]
    );

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_CARD_REJECT",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: "OWNER",
        providerId: card.provider_id,
        resultRef: parsed.intent.cardId,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_CARD_REJECTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            cardId: parsed.intent.cardId,
            providerId: card.provider_id,
            reason: parsed.intent.reason
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            cardId: parsed.intent.cardId,
            providerId: card.provider_id,
            state: "REJECTED",
            supplyStatus: await supplyStatusOf(client, card.provider_id)
        }
    };
}
