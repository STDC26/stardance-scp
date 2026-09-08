// Fixtures for the G5-F Owner operational-authority proofs.
//
// Every world is composed from the REAL gates below it: a customer request is
// created through the G5-D ingress boundary, a provider is approved through the
// G5-E partner path, and provider acceptance is recorded through the G4
// orchestrator under the provider's own identity. Nothing here inserts a
// request, an offer, an assignment or a capacity window directly, because the
// point of the gate is that the Owner drives canonical machinery rather than a
// fixture pretending to be one.
//
// Time is anchored deterministically to a fixed weekday of a future week so no
// assertion depends on the wall clock at which the suite happens to run (R36).

import type { Pool } from "pg";
import { DateTime } from "luxon";
import { createPool, withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { currentAttempt } from "../../src/lifecycle/dispatchAttempt";
import { startOwnerHost, issueOwnerSession, type OwnerHost } from "../../src/host/ownerHost";
import { startPartnerHost, type PartnerHost } from "../../src/host/partnerHost";
import { startCustomerHost, type CustomerHost } from "../../src/host/customerHost";
import { INGRESS_PATH } from "../../src/host/customerHost";
import {
    activate,
    call as partnerCall,
    enrol,
    resetProvider,
    validProfile,
    week,
    SCOPE
} from "../provider/providerTestDb";
import { anchorMonday, anchoredSlot } from "../support/testTime";

export { SCOPE, activate };

export function getOwnerPool(): Pool {
    return createPool({ database: process.env["PGDATABASE"] ?? "freshline_msos_test" });
}

export async function resetOwner(pool: Pool): Promise<void> {
    await pool.query(`TRUNCATE core_request_qualification RESTART IDENTITY CASCADE`);
    await resetProvider(pool);
}

/** The Monday of a week comfortably in the future, in the governed timezone. */
export { anchorMonday };

/** A fixed market-local instant on a weekday of the anchored week. */
export { anchoredSlot };

export interface OwnerWorld {
    pool: Pool;
    ownerHost: OwnerHost;
    partnerHost: PartnerHost;
    customerHost: CustomerHost;
    ownerIdentityId: string;
    ownerToken: string;
    monday: string;
}

/** Brings up all three governed hosts against one runtime and one database. */
export async function bootWorld(pool: Pool): Promise<OwnerWorld> {
    await resetOwner(pool);
    await activate(pool, FRESHLINE_BALI_V2);

    const identity = {
        tenantId: SCOPE.tenantId,
        marketId: SCOPE.marketId,
        environment: SCOPE.environment
    };

    // The partner host projects the governed catalogue and service areas, which
    // the customer and Owner paths both depend on.
    const partner = await startPartnerHost({ pool, identity });
    if (!partner.ok) throw new Error(`${partner.code}: ${partner.message}`);

    const customer = await startCustomerHost({ pool, identity });
    if (!customer.ok) throw new Error(`${customer.code}: ${customer.message}`);

    const owner = await startOwnerHost({ pool, identity });
    if (!owner.ok) throw new Error(`${owner.code}: ${owner.message}`);

    // MOBILE topology is G3 catalogue configuration and predates G5-F.
    await pool.query(
        `INSERT INTO core_service_topology (service_id, topology)
         SELECT service_id, 'MOBILE' FROM core_service ON CONFLICT DO NOTHING`
    );

    const ownerIdentityId = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Freshline Owner')
             RETURNING identity_id`,
            [SCOPE.marketId]
        );
        await client.query(
            `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'OWNER')`,
            [rows[0]!.identity_id, SCOPE.marketId]
        );
        return rows[0]!.identity_id;
    });
    const issued = await issueOwnerSession(pool, owner.host.runtime, ownerIdentityId);
    if (!issued.ok) throw new Error(issued.message);

    return {
        pool,
        ownerHost: owner.host,
        partnerHost: partner.host,
        customerHost: customer.host,
        ownerIdentityId,
        ownerToken: issued.token,
        monday: anchorMonday()
    };
}

export async function shutdownWorld(world: OwnerWorld): Promise<void> {
    await world.ownerHost.close();
    await world.partnerHost.close();
    await world.customerHost.close();
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------

export interface Response {
    status: number;
    body: Record<string, unknown>;
}

export async function ownerCall(
    world: OwnerWorld,
    method: string,
    path: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.headers ?? {})
    };
    const token = options.token === undefined ? world.ownerToken : options.token;
    if (token) {
        headers["x-owner-session"] = token;
    }
    const response = await fetch(`${world.ownerHost.origin}${path}`, {
        method,
        headers,
        body:
            options.body === undefined
                ? undefined
                : typeof options.body === "string"
                  ? options.body
                  : JSON.stringify(options.body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

// -----------------------------------------------------------------------------
// Composed world builders
// -----------------------------------------------------------------------------

let seq = 0;

/**
 * Creates a real customer request through the G5-D ingress boundary, placed on
 * a deterministic weekday of the anchored week.
 */
export async function createDemand(
    world: OwnerWorld,
    options: { isoDay?: number; hour?: number; region?: string; serviceCode?: string } = {}
): Promise<{ requestId: string; region: string; slot: ReturnType<typeof anchoredSlot> }> {
    seq += 1;
    const slot = anchoredSlot(world.monday, options.isoDay ?? 3, options.hour ?? 11);
    const region = options.region ?? "Seminyak";
    const response = await fetch(`${world.customerHost.origin}${INGRESS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            serviceCode: options.serviceCode ?? "FRESH_CUT",
            extraCodes: [],
            requestedDate: slot.date,
            requestedTime: slot.time,
            region,
            accommodationType: "Villa",
            customerName: `Customer ${seq}`,
            contactHandle: `+62815${String(5000000 + seq).slice(0, 7)}`,
            locale: "en"
        })
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 201) {
        throw new Error(`demand ingress failed: ${JSON.stringify(body)}`);
    }
    return { requestId: body["requestId"] as string, region, slot };
}

/**
 * Drives a partner to approved supply through the real G5-E path, with a week
 * the caller chooses so day/region asymmetry can be exercised.
 */
export async function createApprovedProvider(
    world: OwnerWorld,
    options: { days?: Array<Record<string, unknown>>; displayName?: string } = {}
): Promise<{ providerId: string; providerIdentityId: string; publicId: string; token: string }> {
    seq += 1;
    const origin = world.partnerHost.origin;
    const { token } = await enrol(origin, options.displayName ?? `Partner ${seq}`);
    const profile = await partnerCall(origin, "POST", "/api/partner/profile", {
        token,
        body: validProfile({
            displayName: options.displayName ?? `Partner ${seq}`,
            contactHandle: `+62816${String(6000000 + seq).slice(0, 7)}`
        })
    });
    if (profile.status !== 201) {
        throw new Error(`profile failed: ${JSON.stringify(profile.body)}`);
    }
    const providerId = profile.body["providerId"] as string;

    const card = await partnerCall(origin, "POST", "/api/partner/card", { token, body: {} });
    const partnerOwner = await issueOwnerSession(world.pool, world.partnerHost.runtime, world.ownerIdentityId);
    if (!partnerOwner.ok) throw new Error(partnerOwner.message);
    const approved = await partnerCall(origin, "POST", "/api/operations/cards/approve", {
        token: partnerOwner.token,
        body: { cardId: card.body["cardId"] }
    });
    if (approved.status !== 201) {
        throw new Error(`card approval failed: ${JSON.stringify(approved.body)}`);
    }

    const availability = await partnerCall(origin, "POST", "/api/partner/availability", {
        token,
        body: { weekStartDate: world.monday, days: options.days ?? week() }
    });
    if (availability.status !== 201) {
        throw new Error(`availability failed: ${JSON.stringify(availability.body)}`);
    }
    const confirmed = await partnerCall(origin, "POST", "/api/operations/availability/confirm", {
        token: partnerOwner.token,
        body: { availabilityVersionId: availability.body["availabilityVersionId"] }
    });
    if (confirmed.status !== 201) {
        throw new Error(`availability confirmation failed: ${JSON.stringify(confirmed.body)}`);
    }

    const identity = await world.pool.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );

    return {
        providerId,
        providerIdentityId: identity.rows[0]!.identity_id,
        publicId: approved.body["publicId"] as string,
        token
    };
}

/**
 * Records provider acceptance through the canonical G4 orchestrator under the
 * PROVIDER's own identity.
 *
 * Deliberately NOT an Owner route: the Owner surface must be unable to
 * manufacture acceptance, so the fixture uses the same separately-attributed
 * authority a real provider response would.
 */
export async function recordProviderAcceptance(
    world: OwnerWorld,
    requestId: string,
    providerIdentityId: string,
    providerId: string,
    idempotencyKey = `accept:${requestId}`
) {
    return withTransaction(world.pool, async (client) => {
        // Core binds a response to the dispatch ATTEMPT, so the fixture reads
        // the current one exactly as a real provider channel would have to.
        const attempt = await currentAttempt(client, requestId);
        if (!attempt) {
            throw new Error("no open dispatch attempt to accept");
        }
        return executeOperationalAction(client, {
            actionType: "RECORD_PROVIDER_ACCEPTANCE",
            marketId: "bali",
            requestId,
            actorIdentityId: providerIdentityId,
            idempotencyKey,
            payload: { attemptId: attempt.attemptId, providerId }
        });
    });
}
