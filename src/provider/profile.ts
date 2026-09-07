// SCP-G5-E — provider profile ingress.
//
// THE BOUNDARY: the Partner experience captures provider intent and profile
// input. SCP owns Provider, approval, availability and supply authority.
//
// FOUNDATIONAL_INVARIANT, restated where it is easiest to break: submitted
// profile != approved supply. This module creates a `core_provider` row at
// SUBMITTED and appends a profile version. It never touches `supply_status`,
// never grants a role, and never writes a capacity window — so a provider that
// has only filled in a form is, structurally, not dispatchable.
//
// Everything a client sends is intent. Tenant, market and environment come from
// the runtime; the Provider identity comes from the server-verified session;
// role code and service capabilities are validated against the governed
// configuration; the profile version number is assigned by the server.

import type { PoolClient } from "pg";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import type { IdentityLineage } from "../runtime/identity";
import { recordRuntimeEvidence } from "../runtime/evidence";
import { resolveCatalogueIdentity } from "../customer/catalogueProjection";
import {
    parseProfileIntent,
    profileFingerprint,
    deriveIdempotencyKey,
    type ContractFinding,
    type ProfileIntent,
    type ProviderScope
} from "./contracts";
import { claimIdempotency, recordProviderIngress } from "./ingress";
import { attachProviderToSession, type ResolvedSession } from "./session";
import type { ProviderReason } from "./reasons";

export interface ProviderCommandContext {
    configuration: EffectiveConfiguration;
    session: ResolvedSession;
    correlationId: string;
    now?: Date;
}

export type ProviderOutcome<T> =
    | { ok: true; value: T; replay: boolean }
    | { ok: false; reason: ProviderReason; message: string; findings?: ContractFinding[] };

export function refuse<T>(
    reason: ProviderReason,
    message: string,
    findings?: ContractFinding[]
): ProviderOutcome<T> {
    return findings ? { ok: false, reason, message, findings } : { ok: false, reason, message };
}

export interface SubmittedProfile {
    providerId: string;
    profileId: string;
    version: number;
    /** Always SUBMITTED on first creation. Never advanced by this module. */
    supplyStatus: string;
    displayName: string;
    roleCode: string;
    serviceCodes: string[];
}

function scopeOf(configuration: EffectiveConfiguration): ProviderScope {
    return {
        tenantId: configuration.identity.tenantId,
        marketId: configuration.identity.marketId,
        environment: configuration.identity.environment
    };
}

function lineageOfConfiguration(configuration: EffectiveConfiguration): IdentityLineage {
    return {
        tenantId: configuration.identity.tenantId,
        marketId: configuration.identity.marketId,
        environment: configuration.identity.environment
    };
}

/**
 * Governed role codes for this tenant, taken from the configured Partner ID
 * prefix map. BB/MS/NT/FX/EC are Freshline's vocabulary living in Freshline's
 * configuration; they are deliberately not SCP Provider domain law.
 */
export function governedRoleCodes(configuration: EffectiveConfiguration): string[] {
    return Object.keys(configuration.experience.providerExperience.displayIdPrefixes).sort();
}

/**
 * Validates declared capabilities against the governed catalogue. A capability
 * the tenant does not sell cannot become supply, whatever the form allowed.
 */
function validateAgainstConfiguration(
    intent: ProfileIntent,
    configuration: EffectiveConfiguration
): ProviderOutcome<never> | null {
    if (!governedRoleCodes(configuration).includes(intent.roleCode)) {
        return refuse(
            "ROLE_CODE_UNSUPPORTED",
            `role code ${intent.roleCode} is not in this tenant's governed role map`
        );
    }
    for (const code of intent.serviceCodes) {
        const service = configuration.catalogue.services.find((s) => s.code === code);
        if (!service) {
            return refuse("SERVICE_CODE_UNKNOWN", `service ${code} is not in the governed catalogue`);
        }
        if (!service.active) {
            return refuse("SERVICE_CODE_INACTIVE", `service ${code} is not active`);
        }
    }
    if (!configuration.locales.supported.includes(intent.locale)) {
        return refuse("LOCALE_UNSUPPORTED", `locale ${intent.locale} is not a governed supported locale`);
    }
    return null;
}

export interface CurrentProfile {
    profileId: string;
    providerId: string;
    version: number;
    legalName: string;
    displayName: string;
    contactHandle: string;
    roleCode: string;
    serviceCodes: string[];
    howYouWork: string | null;
    aboutMe: string | null;
    profileChips: string[];
    portraitMediaId: string | null;
}

/** The highest profile version for a provider. There is no mutable pointer. */
export async function currentProfile(
    client: PoolClient,
    providerId: string
): Promise<CurrentProfile | null> {
    const { rows } = await client.query<{
        profile_id: string;
        provider_id: string;
        version: number;
        legal_name: string;
        display_name: string;
        contact_handle: string;
        role_code: string;
        service_codes: string[];
        how_you_work: string | null;
        about_me: string | null;
        profile_chips: string[];
        portrait_media_id: string | null;
    }>(
        `SELECT profile_id, provider_id, version, legal_name, display_name, contact_handle,
                role_code, service_codes, how_you_work, about_me, profile_chips, portrait_media_id
           FROM core_provider_profile
          WHERE provider_id = $1
          ORDER BY version DESC
          LIMIT 1`,
        [providerId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        profileId: row.profile_id,
        providerId: row.provider_id,
        version: row.version,
        legalName: row.legal_name,
        displayName: row.display_name,
        contactHandle: row.contact_handle,
        roleCode: row.role_code,
        serviceCodes: row.service_codes,
        howYouWork: row.how_you_work,
        aboutMe: row.about_me,
        profileChips: row.profile_chips,
        portraitMediaId: row.portrait_media_id
    };
}

/**
 * Submits a provider profile. Creates the canonical Provider on first
 * submission and appends a new profile version on every subsequent one.
 */
export async function submitProviderProfile(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<SubmittedProfile>> {
    const configuration = context.configuration;
    const scope = scopeOf(configuration);
    const lineage = lineageOfConfiguration(configuration);

    const recordRefusal = async <T>(outcome: ProviderOutcome<T>): Promise<ProviderOutcome<T>> => {
        if (outcome.ok) {
            return outcome;
        }
        await recordRuntimeEvidence(client, {
            kind: "PROVIDER_INGRESS_REFUSED",
            lineage,
            outcome: "REFUSED",
            reasonCode: outcome.reason,
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            detail: {
                command: "PROVIDER_PROFILE_SUBMIT",
                correlationId: context.correlationId,
                message: outcome.message,
                findings: outcome.findings ?? []
            }
        });
        return outcome;
    };

    if (context.session.role !== "PROVIDER") {
        return recordRefusal(
            refuse(
                "NOT_PROVIDER_OWNER_OF_RECORD",
                "a provider profile may only be submitted from a provider session"
            )
        );
    }

    const parsed = parseProfileIntent(body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "provider profile does not satisfy the intake contract",
                parsed.findings
            )
        );
    }
    const intent = parsed.intent;

    const configurationFailure = validateAgainstConfiguration(intent, configuration);
    if (configurationFailure) {
        return recordRefusal(configurationFailure as ProviderOutcome<SubmittedProfile>);
    }

    // The governed catalogue must already be projected, or a capability could
    // be accepted that Core cannot express.
    const catalogue = await resolveCatalogueIdentity(
        client,
        lineage,
        intent.serviceCodes[0]!,
        []
    );
    if (!catalogue) {
        return recordRefusal(
            refuse(
                "CATALOGUE_NOT_PROJECTED",
                "the governed catalogue has not been projected into this runtime"
            )
        );
    }

    const fingerprint = profileFingerprint(scope, intent);
    const idempotencyKey =
        intent.idempotencyKey ??
        deriveIdempotencyKey("pp", fingerprint, context.correlationId);

    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_PROFILE_SUBMIT",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return recordRefusal(refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message));
    }
    if (claim.kind === "REPLAY") {
        const existing = claim.providerId ? await currentProfile(client, claim.providerId) : null;
        if (existing) {
            const status = await client.query<{ supply_status: string }>(
                `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
                [existing.providerId]
            );
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_INGRESS_REPLAYED",
                lineage,
                outcome: "OK",
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    command: "PROVIDER_PROFILE_SUBMIT",
                    correlationId: context.correlationId,
                    idempotencyKey,
                    providerId: existing.providerId
                }
            });
            return {
                ok: true,
                replay: true,
                value: {
                    providerId: existing.providerId,
                    profileId: existing.profileId,
                    version: existing.version,
                    supplyStatus: status.rows[0]!.supply_status,
                    displayName: existing.displayName,
                    roleCode: existing.roleCode,
                    serviceCodes: existing.serviceCodes
                }
            };
        }
    }

    // The SESSION identity governs which Provider this is — never a value from
    // the body. Deriving the Provider from a submitted contact handle would let
    // a new applicant attach themselves to an existing partner's identity just
    // by typing that partner's number.
    //
    // The profile's `contactHandle` is therefore coordination data on the
    // profile, not an identity claim. It may differ from the handle the session
    // was enrolled with; governing a change of contact is deferred work, not
    // something to resolve by silently rebinding an identity here.
    let providerId = context.session.providerId;

    if (providerId === null) {
        const identityId = context.session.identityId;
        const created = await client.query<{ provider_id: string }>(
            `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
             VALUES ($1, $2, $3, 'SUBMITTED')
             ON CONFLICT (market_id, identity_id) DO UPDATE SET display_name = core_provider.display_name
             RETURNING provider_id`,
            [lineage.marketId, identityId, intent.displayName]
        );
        providerId = created.rows[0]!.provider_id;
        await attachProviderToSession(client, context.session.sessionId, providerId);
    } else {
        const owned = await client.query<{ market_id: string }>(
            `SELECT market_id FROM core_provider WHERE provider_id = $1`,
            [providerId]
        );
        const row = owned.rows[0];
        if (!row) {
            return recordRefusal(refuse("NOT_PROVIDER_OWNER_OF_RECORD", "provider not found"));
        }
        if (row.market_id !== lineage.marketId) {
            return recordRefusal(
                refuse("CROSS_TENANT_REFUSED", "provider belongs to a different market")
            );
        }
    }

    if (intent.portraitMediaId !== null) {
        const media = await client.query<{ media_id: string }>(
            `SELECT media_id FROM core_provider_media
              WHERE media_id = $1 AND provider_id = $2
                AND tenant_id = $3 AND market_id = $4 AND environment = $5`,
            [
                intent.portraitMediaId,
                providerId,
                scope.tenantId,
                scope.marketId,
                scope.environment
            ]
        );
        if (media.rows.length === 0) {
            return recordRefusal(
                refuse("MEDIA_NOT_FOUND", "the referenced portrait does not belong to this provider")
            );
        }
    }

    const nextVersion = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM core_provider_profile
          WHERE provider_id = $1`,
        [providerId]
    );
    const version = Number(nextVersion.rows[0]!.next);

    const identityRow = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );
    const providerIdentityId = identityRow.rows[0]!.identity_id;

    const inserted = await client.query<{ profile_id: string }>(
        `INSERT INTO core_provider_profile
            (provider_id, tenant_id, market_id, environment, version,
             legal_name, display_name, contact_handle, role_code, service_codes,
             how_you_work, about_me, profile_chips, portrait_media_id, submitted_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13::text[],$14,$15)
         RETURNING profile_id`,
        [
            providerId,
            scope.tenantId,
            scope.marketId,
            scope.environment,
            version,
            intent.legalName,
            intent.displayName,
            intent.contactHandle,
            intent.roleCode,
            intent.serviceCodes,
            intent.howYouWork,
            intent.aboutMe,
            intent.profileChips,
            intent.portraitMediaId,
            providerIdentityId
        ]
    );
    const profileId = inserted.rows[0]!.profile_id;

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_PROFILE_SUBMIT",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: context.session.role,
        providerId,
        resultRef: profileId,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    const status = await client.query<{ supply_status: string }>(
        `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );

    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_INGRESS_ACCEPTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            command: "PROVIDER_PROFILE_SUBMIT",
            correlationId: context.correlationId,
            idempotencyKey,
            providerId,
            profileId,
            profileVersion: version,
            // Recorded so the evidence itself states that submission granted
            // nothing.
            supplyStatusAfterSubmission: status.rows[0]!.supply_status
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            providerId,
            profileId,
            version,
            supplyStatus: status.rows[0]!.supply_status,
            displayName: intent.displayName,
            roleCode: intent.roleCode,
            serviceCodes: intent.serviceCodes
        }
    };
}
