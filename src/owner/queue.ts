// SCP-G5-F — the Owner operational queue and request detail.
//
// A PROJECTION. It owns nothing, duplicates nothing, and caches nothing. Every
// field is read at request time from the canonical record that owns it:
//
//   state, version, price, times   core_service_request / _version   (G2)
//   customer context               core_demand_ingress               (G5-D)
//   qualification                  core_request_qualification        (G5-F)
//   dispatch attempt               core_dispatch_offer               (G2/G4)
//   assignment                     core_assignment                   (G4)
//   confirmation                   core_customer_confirmation        (G4)
//   fulfillment                    core_fulfillment                  (G4)
//
// The queue therefore cannot drift from canonical truth, because there is
// nothing to drift: a stale queue is simply an old read, and the next read is
// correct again. That is the whole reason it is built this way rather than as a
// maintained operational table.

import type { PoolClient } from "pg";
import type { ServiceRequestState } from "../core/types";
import { currentQualification, type QualificationOutcome } from "../lifecycle/qualification";

export interface OwnerQueueScope {
    tenantId: string;
    marketId: string;
    environment: string;
}

/**
 * Where the request stands in the operational journey, derived purely from
 * canonical records. This is a LABEL for an operator, not a state: nothing
 * consults it, and no transition is gated on it.
 */
export type OperationalStage =
    | "AWAITING_QUALIFICATION"
    | "CLARIFICATION_REQUIRED"
    | "READY_FOR_MATCHING"
    | "OFFER_OUTSTANDING"
    | "PROVIDER_ACCEPTED_AWAITING_ASSIGNMENT"
    | "ASSIGNED_AWAITING_CONFIRMATION_REQUEST"
    | "AWAITING_CUSTOMER_CONFIRMATION"
    | "CONFIRMED_AWAITING_FULFILLMENT"
    | "FULFILLMENT_ACTIVE"
    | "CLOSED";

export interface OwnerQueueEntry {
    requestId: string;
    state: ServiceRequestState;
    stage: OperationalStage;
    currentVersion: number;
    createdAt: Date;
    startTime: Date;
    endTime: Date;
    durationMinutes: number;
    priceMinorUnits: number;
    currencyCode: string;
    /** Customer context from the G5-D ingress envelope. Null if not web-sourced. */
    customer: {
        displayName: string | null;
        contactHandle: string | null;
        serviceRegion: string | null;
        accommodationType: string | null;
        locale: string | null;
        sourceChannel: string | null;
        serviceCode: string | null;
        extraCodes: string[];
    };
    qualification: {
        outcome: QualificationOutcome | null;
        sequence: number | null;
        reasonCode: string | null;
        decidedAt: Date | null;
    };
    dispatch: {
        offerId: string | null;
        providerId: string | null;
        state: string | null;
    };
    assignment: { assignmentId: string | null; providerId: string | null };
    confirmation: { confirmed: boolean };
    fulfillment: { started: boolean; result: string | null };
}

const TERMINAL: ReadonlySet<string> = new Set([
    "SERVICE_COMPLETED",
    "CANCELLED",
    "NO_SHOW",
    "UNABLE_TO_FULFILL"
]);

/**
 * Derives the operator-facing stage. Deliberately a pure function of canonical
 * facts already loaded — no query, no judgement, nothing to get out of step.
 */
export function deriveStage(entry: {
    state: ServiceRequestState;
    qualification: QualificationOutcome | null;
    hasOpenOffer: boolean;
    providerAccepted: boolean;
    hasAssignment: boolean;
    confirmed: boolean;
    fulfillmentStarted: boolean;
}): OperationalStage {
    if (TERMINAL.has(entry.state)) {
        return "CLOSED";
    }
    if (entry.state === "FULFILLMENT_ACTIVE" || entry.fulfillmentStarted) {
        return "FULFILLMENT_ACTIVE";
    }
    if (entry.state === "CUSTOMER_CONFIRMED" || entry.confirmed) {
        return "CONFIRMED_AWAITING_FULFILLMENT";
    }
    if (entry.state === "AWAITING_CUSTOMER_CONFIRMATION") {
        return "AWAITING_CUSTOMER_CONFIRMATION";
    }
    // Assigned, but the customer has not been asked yet. Two different things,
    // and an operator needs to see which one they are looking at.
    if (entry.state === "OWNER_ASSIGNED") {
        return "ASSIGNED_AWAITING_CONFIRMATION_REQUEST";
    }
    if (entry.state === "PROVIDER_ACCEPTED" || (entry.providerAccepted && !entry.hasAssignment)) {
        return "PROVIDER_ACCEPTED_AWAITING_ASSIGNMENT";
    }
    if (entry.state === "PROVIDER_DISPATCHED" || entry.hasOpenOffer) {
        return "OFFER_OUTSTANDING";
    }
    if (entry.qualification === "SERVICEABLE") {
        return "READY_FOR_MATCHING";
    }
    if (entry.qualification === "CLARIFICATION_REQUIRED") {
        return "CLARIFICATION_REQUIRED";
    }
    return "AWAITING_QUALIFICATION";
}

interface QueueRow {
    request_id: string;
    state: ServiceRequestState;
    current_version: number;
    created_at: Date;
    start_time: Date;
    end_time: Date;
    duration_minutes: number;
    price_minor_units: string;
    currency_code: string;
    display_name: string | null;
    contact_handle: string | null;
    service_region: string | null;
    accommodation_type: string | null;
    locale: string | null;
    source_channel: string | null;
    service_code: string | null;
    extra_codes: string[] | null;
    offer_id: string | null;
    offer_provider_id: string | null;
    offer_state: string | null;
    assignment_id: string | null;
    assignment_provider_id: string | null;
    confirmed: boolean;
    fulfillment_result: string | null;
}

const QUEUE_SELECT = `
    SELECT r.request_id, r.state, r.current_version, r.created_at,
           v.start_time, v.end_time, v.duration_minutes, v.price_minor_units, v.currency_code,
           i.customer_display_name   AS display_name,
           i.customer_contact_handle AS contact_handle,
           i.service_region, i.accommodation_type, i.locale, i.source_channel,
           i.service_code, i.extra_codes,
           o.offer_id, o.provider_id AS offer_provider_id, o.state::text AS offer_state,
           a.assignment_id, a.provider_id AS assignment_provider_id,
           -- core_customer_confirmation is the confirmation CONTEXT: a row
           -- exists from the moment confirmation is requested. Only a CONFIRMED
           -- one means the customer actually confirmed.
           EXISTS (SELECT 1 FROM core_customer_confirmation cc
                    WHERE cc.request_id = r.request_id
                      AND cc.status = 'CONFIRMED') AS confirmed,
           (SELECT f.result::text FROM core_fulfillment f
             WHERE f.request_id = r.request_id
             ORDER BY f.recorded_at DESC LIMIT 1) AS fulfillment_result
      FROM core_service_request r
      JOIN core_service_request_version v
        ON v.request_id = r.request_id AND v.version = r.current_version
 LEFT JOIN core_demand_ingress i ON i.request_id = r.request_id
 LEFT JOIN LATERAL (
             SELECT d.offer_id, d.provider_id, d.state
               FROM core_dispatch_offer d
              WHERE d.request_id = r.request_id
              ORDER BY d.offered_at DESC LIMIT 1
           ) o ON TRUE
 LEFT JOIN LATERAL (
             SELECT s.assignment_id, s.provider_id
               FROM core_assignment s
              WHERE s.request_id = r.request_id AND s.status = 'ACTIVE'
              LIMIT 1
           ) a ON TRUE
`;

async function toEntry(client: PoolClient, row: QueueRow): Promise<OwnerQueueEntry> {
    const qualification = await currentQualification(client, row.request_id);
    return {
        requestId: row.request_id,
        state: row.state,
        stage: deriveStage({
            state: row.state,
            qualification: qualification?.outcome ?? null,
            hasOpenOffer: row.offer_state === "OFFERED",
            providerAccepted: row.offer_state === "ACCEPTED",
            hasAssignment: row.assignment_id !== null,
            confirmed: row.confirmed,
            fulfillmentStarted: row.fulfillment_result !== null
        }),
        currentVersion: row.current_version,
        createdAt: row.created_at,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: row.duration_minutes,
        priceMinorUnits: Number(row.price_minor_units),
        currencyCode: row.currency_code,
        customer: {
            displayName: row.display_name,
            contactHandle: row.contact_handle,
            serviceRegion: row.service_region,
            accommodationType: row.accommodation_type,
            locale: row.locale,
            sourceChannel: row.source_channel,
            serviceCode: row.service_code,
            extraCodes: row.extra_codes ?? []
        },
        qualification: {
            outcome: qualification?.outcome ?? null,
            sequence: qualification?.sequence ?? null,
            reasonCode: qualification?.reasonCode ?? null,
            decidedAt: qualification?.decidedAt ?? null
        },
        dispatch: {
            offerId: row.offer_id,
            providerId: row.offer_provider_id,
            state: row.offer_state
        },
        assignment: {
            assignmentId: row.assignment_id,
            providerId: row.assignment_provider_id
        },
        confirmation: { confirmed: row.confirmed },
        fulfillment: {
            started: row.fulfillment_result !== null,
            result: row.fulfillment_result
        }
    };
}

export interface QueueQuery {
    /** Include requests that have reached a terminal state. Off by default. */
    includeClosed?: boolean;
    limit?: number;
}

/**
 * Requests in this market needing operational attention, oldest first so the
 * queue is a work order rather than a leaderboard.
 */
export async function ownerQueue(
    client: PoolClient,
    scope: OwnerQueueScope,
    query: QueueQuery = {}
): Promise<OwnerQueueEntry[]> {
    const params: unknown[] = [scope.marketId];
    const closedFilter = query.includeClosed
        ? ""
        : `AND r.state NOT IN ('SERVICE_COMPLETED', 'CANCELLED', 'NO_SHOW', 'UNABLE_TO_FULFILL')`;
    params.push(Math.min(Math.max(query.limit ?? 100, 1), 500));

    const { rows } = await client.query<QueueRow>(
        `${QUEUE_SELECT}
          WHERE r.market_id = $1
            ${closedFilter}
          ORDER BY r.created_at ASC
          LIMIT $2`,
        params
    );
    const entries: OwnerQueueEntry[] = [];
    for (const row of rows) {
        entries.push(await toEntry(client, row));
    }
    return entries;
}

/**
 * One request, scoped. Returns null when the request does not exist in this
 * market — a caller learns nothing about requests outside its scope.
 */
export async function ownerRequestDetail(
    client: PoolClient,
    scope: OwnerQueueScope,
    requestId: string
): Promise<OwnerQueueEntry | null> {
    const { rows } = await client.query<QueueRow>(
        `${QUEUE_SELECT} WHERE r.request_id = $1 AND r.market_id = $2`,
        [requestId, scope.marketId]
    );
    const row = rows[0];
    return row ? toEntry(client, row) : null;
}
