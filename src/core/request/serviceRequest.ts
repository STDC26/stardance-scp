// SCP Core Foundation — Service Request.
//
// Owns the canonical Service Request aggregate and its state machine. Every
// transition is predecessor-validated, optimistically locked, actor-attributed,
// idempotent, and audited. No other module mutates core_service_request.state.
//
// FOUNDATIONAL_INVARIANT: "A service is not a product with an appointment
// attached." The request carries its own commercial version history rather than
// borrowing a product's.

import type { PoolClient } from "pg";
import {
    fail,
    succeed,
    type Actor,
    type GovernedOutcome,
    type ServiceRequestState
} from "../types";
import { requireUuids } from "../identifiers";
import { recordEvent } from "../events/eventLog";
import { buildCommercialSnapshot } from "../catalogue/catalogue";

/**
 * The legal transition graph. Absent edges are refused with INVALID_TRANSITION
 * rather than silently applied — an unlisted edge is a specification question,
 * not a runtime decision.
 */
const LEGAL_TRANSITIONS: Readonly<Record<ServiceRequestState, readonly ServiceRequestState[]>> =
    Object.freeze({
        PENDING_ACCEPTANCE: ["PROVIDER_DISPATCHED", "CANCELLED"],
        // Decline and expiry both land back on PENDING_ACCEPTANCE — the offer
        // resolves, the request returns to the dispatch pool.
        PROVIDER_DISPATCHED: ["PROVIDER_ACCEPTED", "PENDING_ACCEPTANCE", "CANCELLED"],
        // Provider acceptance does NOT assign; OWNER_ASSIGNED is a separate act.
        PROVIDER_ACCEPTED: ["OWNER_ASSIGNED", "PENDING_ACCEPTANCE", "CANCELLED"],
        // Owner assignment does NOT confirm; the customer gate is separate.
        OWNER_ASSIGNED: ["AWAITING_CUSTOMER_CONFIRMATION", "PENDING_ACCEPTANCE", "CANCELLED"],
        AWAITING_CUSTOMER_CONFIRMATION: ["CUSTOMER_CONFIRMED", "PENDING_ACCEPTANCE", "CANCELLED"],
        // Back to AWAITING_CUSTOMER_CONFIRMATION when an adopted amendment
        // changed the customer-facing commitment.
        CUSTOMER_CONFIRMED: ["FULFILLMENT_ACTIVE", "AWAITING_CUSTOMER_CONFIRMATION", "CANCELLED"],
        FULFILLMENT_ACTIVE: ["SERVICE_COMPLETED", "NO_SHOW", "UNABLE_TO_FULFILL"],
        SERVICE_COMPLETED: [],
        CANCELLED: [],
        NO_SHOW: [],
        UNABLE_TO_FULFILL: []
    });

export function isLegalTransition(
    from: ServiceRequestState,
    to: ServiceRequestState
): boolean {
    return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ServiceRequestState): boolean {
    return LEGAL_TRANSITIONS[state].length === 0;
}

export interface ServiceRequestRow {
    requestId: string;
    marketId: string;
    customerIdentityId: string;
    serviceId: string;
    state: ServiceRequestState;
    currentVersion: number;
    lockVersion: number;
}

export async function loadRequest(
    client: PoolClient,
    requestId: string
): Promise<ServiceRequestRow | null> {
    const { rows } = await client.query<{
        request_id: string;
        market_id: string;
        customer_identity_id: string;
        service_id: string;
        state: ServiceRequestState;
        current_version: number;
        lock_version: number;
    }>(
        `SELECT request_id, market_id, customer_identity_id, service_id, state,
                current_version, lock_version
           FROM core_service_request WHERE request_id = $1`,
        [requestId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        requestId: row.request_id,
        marketId: row.market_id,
        customerIdentityId: row.customer_identity_id,
        serviceId: row.service_id,
        state: row.state,
        currentVersion: row.current_version,
        lockVersion: row.lock_version
    };
}

/** Loads with a row lock — the entry point for any mutating command. */
export async function loadRequestForUpdate(
    client: PoolClient,
    requestId: string
): Promise<ServiceRequestRow | null> {
    const { rows } = await client.query<{ request_id: string }>(
        `SELECT request_id FROM core_service_request WHERE request_id = $1 FOR UPDATE`,
        [requestId]
    );
    return rows[0] ? loadRequest(client, requestId) : null;
}

export interface CreateRequestInput {
    marketId: string;
    customerIdentityId: string;
    serviceId: string;
    startTime: Date;
    addonIds?: readonly string[];
}

export interface CreatedRequest {
    requestId: string;
    version: number;
    startTime: Date;
    endTime: Date;
    priceMinorUnits: number;
    currencyCode: string;
    durationMinutes: number;
}

/**
 * Creates a request at PENDING_ACCEPTANCE with version 1. The commercial
 * snapshot is locked here; nothing downstream recomputes price from the live
 * catalogue.
 */
export async function createServiceRequest(
    client: PoolClient,
    input: CreateRequestInput,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<CreatedRequest>> {
    const ids = requireUuids({
        customerIdentityId: input.customerIdentityId,
        serviceId: input.serviceId
    });
    if (!ids.ok) {
        return ids;
    }
    for (const addonId of input.addonIds ?? []) {
        const check = requireUuids({ addonId });
        if (!check.ok) {
            return check;
        }
    }

    const snapshot = await buildCommercialSnapshot(client, input.serviceId, input.addonIds ?? []);
    if (!snapshot.ok) {
        return snapshot;
    }

    const endTime = new Date(input.startTime.getTime() + snapshot.value.durationMinutes * 60_000);

    const requestRows = await client.query<{ request_id: string }>(
        `INSERT INTO core_service_request
            (market_id, customer_identity_id, service_id, state, current_version, lock_version)
         VALUES ($1, $2, $3, 'PENDING_ACCEPTANCE', 1, 1)
         RETURNING request_id`,
        [input.marketId, input.customerIdentityId, input.serviceId]
    );
    const requestId = requestRows.rows[0]!.request_id;

    await insertVersion(client, requestId, 1, snapshot.value, input.startTime, endTime);

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "SERVICE_REQUEST",
        objectId: requestId,
        fromState: null,
        toState: "PENDING_ACCEPTANCE",
        actor,
        governingRef: `version:1`,
        idempotencyKey,
        payload: {
            priceMinorUnits: snapshot.value.priceMinorUnits,
            currencyCode: snapshot.value.currencyCode,
            durationMinutes: snapshot.value.durationMinutes
        }
    });

    return succeed({
        requestId,
        version: 1,
        startTime: input.startTime,
        endTime,
        priceMinorUnits: snapshot.value.priceMinorUnits,
        currencyCode: snapshot.value.currencyCode,
        durationMinutes: snapshot.value.durationMinutes
    });
}

/** Writes an immutable request version row. Never updates an existing one. */
export async function insertVersion(
    client: PoolClient,
    requestId: string,
    version: number,
    snapshot: {
        serviceId: string;
        priceVersionId: string;
        priceMinorUnits: number;
        currencyCode: string;
        durationMinutes: number;
        addons: unknown[];
    },
    startTime: Date,
    endTime: Date
): Promise<string> {
    const { rows } = await client.query<{ request_version_id: string }>(
        `INSERT INTO core_service_request_version
            (request_id, version, service_id, price_version_id, price_minor_units,
             currency_code, duration_minutes, addons_snapshot, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING request_version_id`,
        [
            requestId,
            version,
            snapshot.serviceId,
            snapshot.priceVersionId,
            snapshot.priceMinorUnits,
            snapshot.currencyCode,
            snapshot.durationMinutes,
            JSON.stringify(snapshot.addons),
            startTime,
            endTime
        ]
    );
    return rows[0]!.request_version_id;
}

export interface RequestVersion {
    requestVersionId: string;
    version: number;
    priceMinorUnits: number;
    currencyCode: string;
    durationMinutes: number;
    startTime: Date;
    endTime: Date;
}

export async function loadVersion(
    client: PoolClient,
    requestId: string,
    version: number
): Promise<RequestVersion | null> {
    const { rows } = await client.query<{
        request_version_id: string;
        version: number;
        price_minor_units: string;
        currency_code: string;
        duration_minutes: number;
        start_time: Date;
        end_time: Date;
    }>(
        `SELECT request_version_id, version, price_minor_units, currency_code,
                duration_minutes, start_time, end_time
           FROM core_service_request_version
          WHERE request_id = $1 AND version = $2`,
        [requestId, version]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        requestVersionId: row.request_version_id,
        version: row.version,
        priceMinorUnits: Number(row.price_minor_units),
        currencyCode: row.currency_code,
        durationMinutes: row.duration_minutes,
        startTime: row.start_time,
        endTime: row.end_time
    };
}

/** The version currently authoritative for the request. */
export async function loadCurrentVersion(
    client: PoolClient,
    requestId: string
): Promise<RequestVersion | null> {
    const request = await loadRequest(client, requestId);
    return request ? loadVersion(client, requestId, request.currentVersion) : null;
}

export interface TransitionInput {
    requestId: string;
    expectedFrom: ServiceRequestState;
    to: ServiceRequestState;
    actor: Actor;
    idempotencyKey: string;
    governingRef?: string | null;
    payload?: Record<string, unknown>;
}

/**
 * The single sanctioned way to move a Service Request. Validates the
 * predecessor state, checks the transition is legal, and applies an optimistic
 * lock so a concurrent writer that read the same row loses cleanly rather than
 * double-applying.
 */
export async function transitionRequest(
    client: PoolClient,
    input: TransitionInput
): Promise<GovernedOutcome<{ state: ServiceRequestState; lockVersion: number }>> {
    const ids = requireUuids({ requestId: input.requestId });
    if (!ids.ok) {
        return ids;
    }

    const request = await loadRequestForUpdate(client, input.requestId);
    if (!request) {
        return fail("NOT_FOUND", `service request ${input.requestId} not found`);
    }
    if (request.state !== input.expectedFrom) {
        return fail(
            "STALE_STATE",
            `service request ${input.requestId} is ${request.state}, expected ${input.expectedFrom}`
        );
    }
    if (!isLegalTransition(input.expectedFrom, input.to)) {
        return fail(
            "INVALID_TRANSITION",
            `${input.expectedFrom} -> ${input.to} is not a legal Service Request transition`
        );
    }

    const updated = await client.query(
        `UPDATE core_service_request
            SET state = $2, lock_version = lock_version + 1, updated_at = now()
          WHERE request_id = $1 AND lock_version = $3`,
        [input.requestId, input.to, request.lockVersion]
    );
    if (updated.rowCount === 0) {
        return fail("STALE_STATE", `service request ${input.requestId} was modified concurrently`);
    }

    const write = await recordEvent(client, {
        marketId: request.marketId,
        objectType: "SERVICE_REQUEST",
        objectId: input.requestId,
        fromState: input.expectedFrom,
        toState: input.to,
        actor: input.actor,
        governingRef: input.governingRef ?? null,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload
    });
    if (write === "REPLAY") {
        // The same governed command was already recorded. The state write above
        // is harmless (it re-applied the same target state) but the audit trail
        // must not gain a duplicate row.
        return succeed({ state: input.to, lockVersion: request.lockVersion + 1 });
    }

    return succeed({ state: input.to, lockVersion: request.lockVersion + 1 });
}
