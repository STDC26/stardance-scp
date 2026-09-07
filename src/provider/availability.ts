// SCP-G5-E — weekly availability: versions, and the separate Owner confirmation.
//
// The doctrine this module exists to make structural:
//
//   availability submission        != Owner-confirmed availability
//   editing a confirmed schedule   invalidates that confirmation
//   only the CURRENT confirmed     projects as approved supply
//   version
//   provider scheduling            never assigns customer work
//
// The last one needs no code, and that is the point: there is no path from here
// into DispatchOffer, Assignment, CustomerConfirmation or Fulfillment. A partner
// stating when they can work says nothing about who they will work for.
//
// Apply-to-all is handled by not handling it. The wire carries seven explicit
// days whichever way the partner entered them, so there is exactly one canonical
// representation and the content digest of an apply-to-all week is identical to
// the digest of the same week typed day by day.

import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { recordRuntimeEvidence } from "../runtime/evidence";
import type { IdentityLineage } from "../runtime/identity";
import {
    parseAvailabilityConfirmIntent,
    parseAvailabilityIntent,
    scheduleDigest,
    digest,
    deriveIdempotencyKey,
    type AvailabilityDayIntent,
    type ProviderScope
} from "./contracts";
import { claimIdempotency, recordProviderIngress } from "./ingress";
import { refuse, type ProviderCommandContext, type ProviderOutcome } from "./profile";
import { resolveServiceAreas } from "./serviceAreas";
import {
    loadAvailabilityVersion,
    materializeConfirmedAvailability,
    withdrawAvailabilityVersion,
    type AvailabilityVersionRow
} from "./supply";

export interface SubmittedAvailability {
    availabilityVersionId: string;
    providerId: string;
    weekStartDate: string;
    version: number;
    state: string;
    contentDigest: string;
    /** Versions this submission invalidated, with the confirmation they carried. */
    supersededVersionIds: string[];
    /** True when a previously CONFIRMED week was invalidated by this edit. */
    invalidatedConfirmation: boolean;
}

export interface ConfirmedAvailability {
    availabilityVersionId: string;
    providerId: string;
    weekStartDate: string;
    version: number;
    state: string;
    confirmedByIdentityId: string;
    capacityWindows: number;
    coverageAreas: number;
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

function minutesOf(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return h * 60 + m;
}

/**
 * Validates a week against governed operating policy.
 *
 * The hours come from the effective configuration, so a market that opens at
 * 08:00 by approved override is checked against 08:00 and not against a constant
 * anybody wrote down here.
 */
function validateDays(
    days: readonly AvailabilityDayIntent[],
    operatingHours: { open: string; close: string },
    governedRegions: readonly string[]
): ProviderOutcome<never> | null {
    const open = minutesOf(operatingHours.open);
    const close = minutesOf(operatingHours.close);

    for (const day of days) {
        if (!day.available) {
            continue;
        }
        const start = minutesOf(day.startTime!);
        const end = minutesOf(day.endTime!);
        if (end <= start) {
            return refuse(
                "DAY_TIME_ORDER_INVALID",
                `day ${day.isoDay} ends at ${day.endTime} which is not after ${day.startTime}`
            );
        }
        if (start < open || end > close) {
            return refuse(
                "DAY_OUTSIDE_OPERATING_HOURS",
                `day ${day.isoDay} (${day.startTime}-${day.endTime}) falls outside the governed operating hours ${operatingHours.open}-${operatingHours.close}`
            );
        }
        for (const region of day.regions) {
            if (!governedRegions.includes(region)) {
                return refuse(
                    "REGION_UNSUPPORTED",
                    `region ${region} is not in the governed coverage for this market`
                );
            }
        }
    }
    return null;
}

/**
 * Submits a seven-day week.
 *
 * If a CONFIRMED version for the week already exists and this submission is
 * materially different, that confirmation is invalidated and the capacity it
 * granted is withdrawn in the same transaction — the schedule and the supply it
 * produced can never disagree, because they move together.
 *
 * An identical resubmission is not an edit and invalidates nothing.
 */
export async function submitAvailability(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<SubmittedAvailability>> {
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
                    command: "PROVIDER_AVAILABILITY_SUBMIT",
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
            refuse(
                "NOT_PROVIDER_OWNER_OF_RECORD",
                "availability may only be submitted from a provider session"
            )
        );
    }
    const providerId = context.session.providerId;
    if (!providerId) {
        return recordRefusal(
            refuse("PROFILE_NOT_SUBMITTED", "submit a provider profile before submitting availability")
        );
    }

    const parsed = parseAvailabilityIntent(body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "availability does not satisfy the intake contract",
                parsed.findings
            )
        );
    }
    const intent = parsed.intent;

    // The week must start on a Monday, in the governed market timezone, because
    // the accepted Freshline Partner experience is Monday-start.
    const monday = DateTime.fromISO(intent.weekStartDate, { zone: configuration.timezone.value });
    if (!monday.isValid) {
        return recordRefusal(
            refuse("WEEK_START_INVALID", `${intent.weekStartDate} is not a valid date`)
        );
    }
    if (monday.weekday !== 1) {
        return recordRefusal(
            refuse(
                "WEEK_START_INVALID",
                `${intent.weekStartDate} is a ${monday.weekdayLong}; a week must start on Monday`
            )
        );
    }

    const dayFailure = validateDays(
        intent.days,
        configuration.operatingHours.value,
        configuration.coverage.regions
    );
    if (dayFailure) {
        return recordRefusal(dayFailure as ProviderOutcome<SubmittedAvailability>);
    }

    // Regions must already exist as canonical service areas, or a confirmed
    // week could not be materialized later.
    const allRegions = [...new Set(intent.days.flatMap((d) => d.regions))];
    const areas = await resolveServiceAreas(
        client,
        lineage,
        configuration.provenance.canonicalTenantId,
        allRegions
    );
    if (areas === null) {
        return recordRefusal(
            refuse(
                "SERVICE_AREAS_NOT_PROJECTED",
                "governed coverage regions have not been projected into this runtime"
            )
        );
    }

    const contentDigest = scheduleDigest(scope, intent.weekStartDate, intent.days);
    const fingerprint = digest({
        command: "PROVIDER_AVAILABILITY_SUBMIT",
        ...scope,
        providerId,
        contentDigest
    });
    const idempotencyKey =
        intent.idempotencyKey ?? deriveIdempotencyKey("av", fingerprint, context.correlationId);

    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_AVAILABILITY_SUBMIT",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return recordRefusal(refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message));
    }
    if (claim.kind === "REPLAY" && claim.resultRef) {
        const existing = await loadAvailabilityVersion(client, claim.resultRef);
        if (existing) {
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_INGRESS_REPLAYED",
                lineage,
                outcome: "OK",
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    command: "PROVIDER_AVAILABILITY_SUBMIT",
                    correlationId: context.correlationId,
                    idempotencyKey,
                    availabilityVersionId: existing.availabilityVersionId
                }
            });
            return {
                ok: true,
                replay: true,
                value: {
                    availabilityVersionId: existing.availabilityVersionId,
                    providerId: existing.providerId,
                    weekStartDate: existing.weekStartDate,
                    version: existing.version,
                    state: existing.state,
                    contentDigest: existing.contentDigest,
                    supersededVersionIds: [],
                    invalidatedConfirmation: false
                }
            };
        }
    }

    // Serialize contenders for this provider-week so two concurrent edits
    // produce two ordered versions rather than a partial-unique-index abort.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `provider-availability:${providerId}:${intent.weekStartDate}`
    ]);

    const openRows = await client.query<{
        availability_version_id: string;
        state: string;
        content_digest: string;
        version: number;
    }>(
        `SELECT availability_version_id, state, content_digest, version
           FROM core_provider_availability_version
          WHERE provider_id = $1 AND week_start_date = $2::date
            AND state IN ('SUBMITTED', 'CONFIRMED')
          ORDER BY version
          FOR UPDATE`,
        [providerId, intent.weekStartDate]
    );

    // Resubmitting exactly what is already open is not an edit. Treating it as
    // one would invalidate a live confirmed schedule for no reason, and churn a
    // version number every time a partner pressed the button twice.
    const identicalOpen = openRows.rows.find((r) => r.content_digest === contentDigest);
    if (identicalOpen) {
        const existing = await loadAvailabilityVersion(
            client,
            identicalOpen.availability_version_id
        );
        await recordProviderIngress(client, {
            scope,
            command: "PROVIDER_AVAILABILITY_SUBMIT",
            idempotencyKey,
            fingerprint,
            actorIdentityId: context.session.identityId,
            actorRole: context.session.role,
            providerId,
            resultRef: identicalOpen.availability_version_id,
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            correlationId: context.correlationId
        });
        return {
            ok: true,
            replay: false,
            value: {
                availabilityVersionId: existing!.availabilityVersionId,
                providerId,
                weekStartDate: existing!.weekStartDate,
                version: existing!.version,
                state: existing!.state,
                contentDigest,
                supersededVersionIds: [],
                invalidatedConfirmation: false
            }
        };
    }

    const supersededVersionIds: string[] = [];
    let invalidatedConfirmation = false;
    for (const row of openRows.rows) {
        await client.query(
            `UPDATE core_provider_availability_version
                SET state = 'SUPERSEDED', superseded_at = now()
              WHERE availability_version_id = $1`,
            [row.availability_version_id]
        );
        supersededVersionIds.push(row.availability_version_id);
        if (row.state === "CONFIRMED") {
            invalidatedConfirmation = true;
            // The capacity that confirmation granted goes with it. A schedule
            // and the supply it produced cannot disagree.
            await withdrawAvailabilityVersion(client, row.availability_version_id);
            await recordRuntimeEvidence(client, {
                kind: "AVAILABILITY_INVALIDATED",
                lineage,
                outcome: "OK",
                configurationVersion: configuration.provenance.configurationVersion,
                configurationChecksum: configuration.provenance.checksum,
                detail: {
                    correlationId: context.correlationId,
                    providerId,
                    availabilityVersionId: row.availability_version_id,
                    weekStartDate: intent.weekStartDate,
                    reason: "PROVIDER_EDITED_CONFIRMED_SCHEDULE"
                }
            });
        }
    }

    const nextVersion = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next
           FROM core_provider_availability_version
          WHERE provider_id = $1 AND week_start_date = $2::date`,
        [providerId, intent.weekStartDate]
    );
    const version = Number(nextVersion.rows[0]!.next);

    const inserted = await client.query<{ availability_version_id: string }>(
        `INSERT INTO core_provider_availability_version
            (provider_id, tenant_id, market_id, environment, week_start_date, version,
             state, submitted_by_identity_id, content_digest)
         VALUES ($1,$2,$3,$4,$5::date,$6,'SUBMITTED',$7,$8)
         RETURNING availability_version_id`,
        [
            providerId,
            scope.tenantId,
            scope.marketId,
            scope.environment,
            intent.weekStartDate,
            version,
            context.session.identityId,
            contentDigest
        ]
    );
    const availabilityVersionId = inserted.rows[0]!.availability_version_id;

    for (const day of intent.days) {
        await client.query(
            `INSERT INTO core_provider_availability_day
                (availability_version_id, iso_day, available, start_time_local, end_time_local, regions)
             VALUES ($1,$2,$3,$4,$5,$6::text[])`,
            [
                availabilityVersionId,
                day.isoDay,
                day.available,
                day.startTime,
                day.endTime,
                [...day.regions].sort()
            ]
        );
    }

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_AVAILABILITY_SUBMIT",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: context.session.role,
        providerId,
        resultRef: availabilityVersionId,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    await recordRuntimeEvidence(client, {
        kind: "AVAILABILITY_SUBMITTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            providerId,
            availabilityVersionId,
            weekStartDate: intent.weekStartDate,
            version,
            contentDigest,
            supersededVersionIds,
            invalidatedConfirmation,
            // Stated in the record: submitting is not confirming.
            ownerConfirmed: false
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            availabilityVersionId,
            providerId,
            weekStartDate: intent.weekStartDate,
            version,
            state: "SUBMITTED",
            contentDigest,
            supersededVersionIds,
            invalidatedConfirmation
        }
    };
}

/**
 * Owner confirmation of one specific availability version.
 *
 * Naming the version rather than the provider-week is deliberate: an Owner
 * confirms a schedule they looked at. If the partner edited in the meantime,
 * the version they looked at is SUPERSEDED and the confirmation is refused
 * rather than silently landing on content nobody reviewed.
 */
export async function confirmAvailability(
    client: PoolClient,
    context: ProviderCommandContext,
    body: unknown
): Promise<ProviderOutcome<ConfirmedAvailability>> {
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
                    command: "PROVIDER_AVAILABILITY_CONFIRM",
                    correlationId: context.correlationId,
                    message: outcome.message
                }
            });
        }
        return outcome;
    };

    if (context.session.role !== "OWNER") {
        return recordRefusal(
            refuse("OWNER_AUTHORITY_REQUIRED", "availability confirmation requires an Owner session")
        );
    }

    const parsed = parseAvailabilityConfirmIntent(body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "availability confirmation does not satisfy the contract",
                parsed.findings
            )
        );
    }

    const fingerprint = digest({
        command: "PROVIDER_AVAILABILITY_CONFIRM",
        ...scope,
        availabilityVersionId: parsed.intent.availabilityVersionId
    });
    const idempotencyKey =
        parsed.intent.idempotencyKey ??
        deriveIdempotencyKey("ac", fingerprint, context.correlationId);
    const claim = await claimIdempotency(
        client,
        scope,
        "PROVIDER_AVAILABILITY_CONFIRM",
        idempotencyKey,
        fingerprint
    );
    if (claim.kind === "CONFLICT") {
        return recordRefusal(refuse("IDEMPOTENCY_KEY_CONFLICT", claim.message));
    }

    const version: AvailabilityVersionRow | null = await loadAvailabilityVersion(
        client,
        parsed.intent.availabilityVersionId,
        true
    );
    if (!version) {
        return recordRefusal(
            refuse("AVAILABILITY_VERSION_UNKNOWN", "no such availability version")
        );
    }
    if (
        version.tenantId !== scope.tenantId ||
        version.marketId !== scope.marketId ||
        version.environment !== scope.environment
    ) {
        return recordRefusal(
            refuse(
                "CROSS_TENANT_REFUSED",
                "the availability version belongs to a different tenant, market or environment"
            )
        );
    }

    if (claim.kind === "REPLAY" && version.state === "CONFIRMED") {
        return {
            ok: true,
            replay: true,
            value: {
                availabilityVersionId: version.availabilityVersionId,
                providerId: version.providerId,
                weekStartDate: version.weekStartDate,
                version: version.version,
                state: version.state,
                confirmedByIdentityId: version.confirmedByIdentityId ?? "",
                capacityWindows: 0,
                coverageAreas: 0
            }
        };
    }

    if (version.state === "SUPERSEDED" || version.state === "WITHDRAWN") {
        return recordRefusal(
            refuse(
                "AVAILABILITY_SUPERSEDED",
                `version ${version.version} is ${version.state}; the provider has since changed this week`
            )
        );
    }
    if (version.state !== "SUBMITTED") {
        return recordRefusal(
            refuse("AVAILABILITY_NOT_SUBMITTED", `version is ${version.state}, not awaiting confirmation`)
        );
    }

    await client.query(
        `UPDATE core_provider_availability_version
            SET state = 'CONFIRMED', confirmed_at = now(), confirmed_by_identity_id = $2
          WHERE availability_version_id = $1`,
        [version.availabilityVersionId, context.session.identityId]
    );

    const materialized = await materializeConfirmedAvailability(client, configuration, version);
    if (!materialized.ok) {
        return recordRefusal(
            refuse(
                "SERVICE_AREAS_NOT_PROJECTED",
                "governed coverage regions have not been projected into this runtime"
            )
        );
    }

    await recordProviderIngress(client, {
        scope,
        command: "PROVIDER_AVAILABILITY_CONFIRM",
        idempotencyKey,
        fingerprint,
        actorIdentityId: context.session.identityId,
        actorRole: "OWNER",
        providerId: version.providerId,
        resultRef: version.availabilityVersionId,
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        correlationId: context.correlationId
    });

    await recordRuntimeEvidence(client, {
        kind: "AVAILABILITY_CONFIRMED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            providerId: version.providerId,
            availabilityVersionId: version.availabilityVersionId,
            weekStartDate: version.weekStartDate,
            version: version.version,
            confirmedByIdentityId: context.session.identityId,
            capacityWindows: materialized.windows,
            coverageAreas: materialized.areas,
            // Confirming a schedule says nothing about a card, and assigns no
            // customer work. Recorded so the separation is visible.
            cardApprovalUnaffected: true,
            assignmentsCreated: 0
        }
    });

    await recordRuntimeEvidence(client, {
        kind: "APPROVED_SUPPLY_PROJECTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            providerId: version.providerId,
            availabilityVersionId: version.availabilityVersionId,
            capacityWindows: materialized.windows
        }
    });

    return {
        ok: true,
        replay: false,
        value: {
            availabilityVersionId: version.availabilityVersionId,
            providerId: version.providerId,
            weekStartDate: version.weekStartDate,
            version: version.version,
            state: "CONFIRMED",
            confirmedByIdentityId: context.session.identityId,
            capacityWindows: materialized.windows,
            coverageAreas: materialized.areas
        }
    };
}
