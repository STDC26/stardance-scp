// SCP-G5-F — strict eligible matching and approved-supply observability.
//
// This module runs NO matching logic. It asks G3 the question and reports the
// answer, and it asks G5-E who is currently approved supply and reports that.
// There is no scoring, no ranking, no fallback, no relaxation and no second
// eligibility rule anywhere in this file — which is what "no Owner UI shortcut
// may bypass Core eligibility" means when it is structural rather than a policy.
//
// In particular the MOBILE service-area invariant repaired under
// SCP-G5-E-CORR-01 (R32) is inherited automatically: the Owner asks
// `evaluateServiceCommerce` for a specific service area, and the kernel still
// requires the same capacity window to satisfy the interval AND that area. The
// Owner surface cannot weaken it because the Owner surface does not implement it.

import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { evaluateServiceCommerce, type ServiceCommerceEvaluation } from "../kernel/evaluation";
import type { MarketId } from "../config/marketConfig";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { approvedSupply, type ApprovedSupplyEntry } from "../provider/supply";
import type { OwnerQueueEntry } from "./queue";

export interface SupplySnapshot {
    /** The Monday of the week the request falls in, market-local. */
    weekStartDate: string;
    /** Providers who are approved supply for that week. */
    approved: ApprovedSupplyEntry[];
    approvedCount: number;
    /** Those whose confirmed week covers the requested region on that day. */
    coveringRequestedRegion: ApprovedSupplyEntry[];
    coveringCount: number;
    /** Server time the snapshot was taken. It is an observation, not a state. */
    synchronizedAt: Date;
}

/** The Monday of the week containing an instant, in the governed timezone. */
export function weekStartFor(instant: Date, timezone: string): string {
    return DateTime.fromJSDate(instant).setZone(timezone).startOf("week").toFormat("yyyy-MM-dd");
}

function isoDayOf(instant: Date, timezone: string): number {
    return DateTime.fromJSDate(instant).setZone(timezone).weekday;
}

/**
 * What supply exists for a request right now.
 *
 * Observational. Refreshing re-reads canonical records; it cannot manufacture
 * supply, and an empty result is a fact about the world rather than an error.
 * Only current Owner-confirmed availability appears, because that is all
 * `approvedSupply` returns — submitted, superseded and unconfirmed weeks are
 * absent by construction, not by filtering here.
 */
export async function supplySnapshot(
    client: PoolClient,
    configuration: EffectiveConfiguration,
    entry: OwnerQueueEntry,
    now: Date = new Date()
): Promise<SupplySnapshot> {
    const timezone = configuration.timezone.value;
    const weekStartDate = weekStartFor(entry.startTime, timezone);
    const approved = await approvedSupply(client, configuration, { weekStartDate });

    const isoDay = isoDayOf(entry.startTime, timezone);
    const region = entry.customer.serviceRegion;
    const covering = approved.filter((provider) =>
        provider.days.some(
            (day) => day.isoDay === isoDay && (region === null || day.regions.includes(region))
        )
    );

    return {
        weekStartDate,
        approved,
        approvedCount: approved.length,
        coveringRequestedRegion: covering,
        coveringCount: covering.length,
        synchronizedAt: now
    };
}

export interface StrictMatch {
    providerId: string;
    publicId: string;
    displayName: string;
    startTime: Date;
    endTime: Date;
    durationMinutes: number;
    priceMinorUnits: number;
    currencyCode: string;
    serviceAreaKey: string | null;
}

export interface MatchResult {
    /** The kernel's own decision record, unmodified. */
    evaluation: ServiceCommerceEvaluation;
    /** Present only when the kernel said SELLABLE. */
    match: StrictMatch | null;
    /** The kernel's refusal reason, verbatim, when it did not. */
    reasonCode: string | null;
    /** Supply context, so an operator can see why there was or was not a match. */
    supply: SupplySnapshot;
}

/**
 * Asks G3 whether this request is sellable, and to whom.
 *
 * The request's own canonical version supplies the service, the time and the
 * duration; the G5-D ingress envelope supplies the service area the customer
 * asked for. Nothing is chosen by the Owner surface — if the kernel refuses,
 * the refusal is reported as it stands.
 */
export async function strictMatch(
    client: PoolClient,
    configuration: EffectiveConfiguration,
    entry: OwnerQueueEntry,
    options: { preferredProviderId?: string | undefined; now?: Date } = {}
): Promise<MatchResult | { ok: false; reason: "REQUEST_NOT_EVALUABLE"; message: string }> {
    const supply = await supplySnapshot(client, configuration, entry, options.now);

    const serviceRow = await client.query<{ service_id: string; customer_identity_id: string }>(
        `SELECT service_id, customer_identity_id FROM core_service_request WHERE request_id = $1`,
        [entry.requestId]
    );
    const request = serviceRow.rows[0];
    if (!request) {
        return { ok: false, reason: "REQUEST_NOT_EVALUABLE", message: "request not found" };
    }
    const addons = await client.query<{ addon_id: string }>(
        `SELECT jsonb_array_elements(addons_snapshot)->>'addonId' AS addon_id
           FROM core_service_request_version
          WHERE request_id = $1 AND version = $2`,
        [entry.requestId, entry.currentVersion]
    );

    const outcome = await evaluateServiceCommerce(client, {
        marketId: configuration.identity.marketId as MarketId,
        // MOBILE is the topology the governed Bali market sells through. The
        // service area comes from what the customer actually asked for, so the
        // R32 same-window invariant applies to the Owner's question too.
        topology: "MOBILE",
        serviceId: request.service_id,
        customerIdentityId: request.customer_identity_id,
        serviceAreaKey: entry.customer.serviceRegion,
        requestedStart: entry.startTime,
        addonIds: addons.rows.map((r) => r.addon_id).filter((id): id is string => id !== null),
        ...(options.preferredProviderId
            ? { preferredProviderId: options.preferredProviderId }
            : {}),
        ...(options.now ? { effectiveAt: options.now } : {})
    });
    if (!outcome.ok) {
        return {
            ok: false,
            reason: "REQUEST_NOT_EVALUABLE",
            message: `${outcome.code}: ${outcome.message}`
        };
    }
    const evaluation = outcome.value;

    let match: StrictMatch | null = null;
    if (evaluation.outcome === "SELLABLE" && evaluation.terms) {
        const provider = supply.approved.find(
            (candidate) => candidate.providerId === evaluation.terms!.providerId
        );
        match = {
            providerId: evaluation.terms.providerId,
            publicId: provider?.publicId ?? "",
            displayName: provider?.displayName ?? "",
            startTime: evaluation.terms.startTime,
            endTime: evaluation.terms.endTime,
            durationMinutes: evaluation.terms.durationMinutes,
            priceMinorUnits: evaluation.terms.priceMinorUnits,
            currencyCode: evaluation.terms.currencyCode,
            serviceAreaKey: evaluation.terms.serviceAreaKey
        };
    }

    return { evaluation, match, reasonCode: evaluation.reasonCode, supply };
}
