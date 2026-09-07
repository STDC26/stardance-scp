// Fixtures for the G5-E provider-experience and supply-ingress proofs.
//
// Every world is built the way production builds one: publish -> approve ->
// activate a governed configuration, then start the Partner host on the G5-C
// runtime spine. Nothing here inserts a provider, a capability or a capacity
// window directly, because the point of the gate is that the governed workflow
// is the only way those come into being.

import type { Pool } from "pg";
import { DateTime } from "luxon";
import { createPool, withTransaction } from "../../src/db/pool";
import {
    publishConfiguration,
    approveConfiguration,
    activateConfiguration
} from "../../src/config/tenant/store";
import { FRESHLINE_BALI_V2, cloneBundle } from "../../src/config/tenant/freshline";
import type { TenantConfigurationBundleV2 } from "../../src/config/tenant/contract";
import {
    startPartnerHost,
    issueOwnerSession,
    type PartnerHost
} from "../../src/host/partnerHost";

export const SCOPE = { tenantId: "freshline-bali", marketId: "bali", environment: "candidate" };
export const ACTOR = "PTC/DRJ";
export const SOURCE = "SCP-G5-E-01";

export function getProviderPool(): Pool {
    return createPool({ database: process.env["PGDATABASE"] ?? "freshline_msos_test" });
}

export async function resetProvider(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE core_provider_ingress, core_provider_media, core_provider_session,
                 core_supply_window_link, core_provider_service_area,
                 core_provider_availability_day, core_provider_availability_version,
                 core_provider_public_id, core_provider_card, core_provider_profile,
                 core_demand_ingress, core_catalogue_binding, core_runtime_evidence,
                 core_tenant_configuration_event, core_tenant_configuration,
                 core_event, core_fulfillment, core_customer_confirmation, core_assignment,
                 core_operational_recovery, core_operational_action,
                 core_dispatch_offer, core_amendment, core_capacity_hold, core_capacity_window,
                 core_commerce_evaluation, core_sellable_offer,
                 core_service_area, core_service_resource_requirement, core_resource,
                 core_location_hours, core_location,
                 core_provider_service, core_provider_location,
                 core_service_request_version, core_service_request,
                 core_service_price_version, core_service_addon, core_service,
                 core_provider_alias, core_provider, core_identity_role, core_identity
        RESTART IDENTITY CASCADE
    `);
}

export async function activate(pool: Pool, bundle: unknown): Promise<number> {
    return withTransaction(pool, async (client) => {
        const published = await publishConfiguration(client, {
            bundle: bundle as never,
            actorOrAuthority: ACTOR,
            sourceReference: SOURCE
        });
        if (!published.ok) throw new Error(published.message);
        if (published.value.configuration.state !== "VALIDATED") {
            throw new Error(
                `bundle rejected: ${published.value.findings.map((f) => f.code).join(", ")}`
            );
        }
        const id = published.value.configuration.configurationId;
        const approved = await approveConfiguration(client, id, ACTOR);
        if (!approved.ok) throw new Error(approved.message);
        const activated = await activateConfiguration(client, id, ACTOR);
        if (!activated.ok) throw new Error(activated.message);
        return activated.value.activated.configurationVersion;
    });
}

export function bundleAtVersion(
    version: number,
    mutate: (b: TenantConfigurationBundleV2) => void = () => {}
): TenantConfigurationBundleV2 {
    const b = cloneBundle(FRESHLINE_BALI_V2 as never) as unknown as TenantConfigurationBundleV2;
    b.configurationVersion = version;
    mutate(b);
    return b;
}

export async function startPartner(
    pool: Pool,
    overrides: Partial<typeof SCOPE> = {},
    options: { projectOnStart?: boolean } = {}
) {
    return startPartnerHost({
        pool,
        identity: {
            tenantId: overrides.tenantId ?? SCOPE.tenantId,
            marketId: overrides.marketId ?? SCOPE.marketId,
            environment: overrides.environment ?? SCOPE.environment
        },
        ...options
    });
}

export async function startPartnerOrThrow(
    pool: Pool,
    overrides?: Partial<typeof SCOPE>,
    options?: { projectOnStart?: boolean }
): Promise<PartnerHost> {
    const outcome = await startPartner(pool, overrides, options);
    if (!outcome.ok) {
        throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    return outcome.host;
}

/** Seeds an Owner identity with the OWNER role and mints an Owner session. */
export async function ownerSession(
    pool: Pool,
    host: PartnerHost,
    marketId = SCOPE.marketId
): Promise<{ identityId: string; token: string }> {
    const identityId = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ($1, 'Freshline Owner')
             RETURNING identity_id`,
            [marketId]
        );
        const id = rows[0]!.identity_id;
        await client.query(
            `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1, $2, 'OWNER')`,
            [id, marketId]
        );
        return id;
    });
    const issued = await issueOwnerSession(pool, host.runtime, identityId);
    if (!issued.ok) {
        throw new Error(issued.message);
    }
    return { identityId, token: issued.token };
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

export interface Response {
    status: number;
    body: Record<string, unknown>;
}

export async function call(
    origin: string,
    method: string,
    path: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.headers ?? {})
    };
    if (options.token) {
        headers["x-partner-session"] = options.token;
    }
    const response = await fetch(`${origin}${path}`, {
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
    return {
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {}
    };
}

let seq = 0;

/** Enrols a fresh applicant and returns its session token. */
export async function enrol(
    origin: string,
    displayName = "Wayan Partner"
): Promise<{ token: string; contactHandle: string }> {
    seq += 1;
    const contactHandle = `+62813${String(4000000 + seq).slice(0, 7)}`;
    const response = await call(origin, "POST", "/api/partner/session", {
        body: { contactHandle, displayName }
    });
    if (response.status !== 201) {
        throw new Error(`enrolment failed: ${JSON.stringify(response.body)}`);
    }
    return { token: response.body["sessionToken"] as string, contactHandle };
}

export function validProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        legalName: "I Wayan Sudiarta",
        displayName: "Wayan",
        contactHandle: "+628131234567",
        roleCode: "BB",
        serviceCodes: ["FRESH_CUT", "FRESH_CUT_BEARD"],
        howYouWork: "Mobile, calm, on time.",
        aboutMe: "Ten years cutting hair in Seminyak.",
        locale: "en",
        ...overrides
    };
}

/** The Monday of a week comfortably in the future, in the governed timezone. */
export function futureMonday(weeksAhead = 2): string {
    return DateTime.now()
        .setZone("Asia/Makassar")
        .plus({ weeks: weeksAhead })
        .startOf("week")
        .toFormat("yyyy-MM-dd");
}

export interface DaySpec {
    isoDay: number;
    available: boolean;
    startTime?: string;
    endTime?: string;
    regions?: string[];
}

/** A seven-day week. Defaults to Monday-Friday 09:00-17:00 in Seminyak. */
export function week(overrides: DaySpec[] = []): Array<Record<string, unknown>> {
    const byDay = new Map(overrides.map((d) => [d.isoDay, d]));
    return [1, 2, 3, 4, 5, 6, 7].map((isoDay) => {
        const override = byDay.get(isoDay);
        if (override) {
            return override.available
                ? {
                      isoDay,
                      available: true,
                      startTime: override.startTime ?? "09:00",
                      endTime: override.endTime ?? "17:00",
                      regions: override.regions ?? ["Seminyak"]
                  }
                : { isoDay, available: false };
        }
        return isoDay <= 5
            ? { isoDay, available: true, startTime: "09:00", endTime: "17:00", regions: ["Seminyak"] }
            : { isoDay, available: false };
    });
}

/**
 * Drives a partner all the way to approved supply: enrol, profile, card,
 * Owner approval, availability, Owner confirmation.
 */
export async function approvedPartner(
    origin: string,
    ownerToken: string,
    options: { profile?: Record<string, unknown>; days?: Array<Record<string, unknown>>; weekStartDate?: string } = {}
): Promise<{
    token: string;
    providerId: string;
    cardId: string;
    publicId: string;
    availabilityVersionId: string;
    weekStartDate: string;
}> {
    const { token } = await enrol(origin);
    const profile = await call(origin, "POST", "/api/partner/profile", {
        token,
        body: validProfile(options.profile ?? {})
    });
    if (profile.status !== 201) {
        throw new Error(`profile failed: ${JSON.stringify(profile.body)}`);
    }
    const card = await call(origin, "POST", "/api/partner/card", { token, body: {} });
    if (card.status !== 201) {
        throw new Error(`card failed: ${JSON.stringify(card.body)}`);
    }
    const approved = await call(origin, "POST", "/api/operations/cards/approve", {
        token: ownerToken,
        body: { cardId: card.body["cardId"] }
    });
    if (approved.status !== 201) {
        throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
    }

    const weekStartDate = options.weekStartDate ?? futureMonday();
    const availability = await call(origin, "POST", "/api/partner/availability", {
        token,
        body: { weekStartDate, days: options.days ?? week() }
    });
    if (availability.status !== 201) {
        throw new Error(`availability failed: ${JSON.stringify(availability.body)}`);
    }
    const confirmed = await call(origin, "POST", "/api/operations/availability/confirm", {
        token: ownerToken,
        body: { availabilityVersionId: availability.body["availabilityVersionId"] }
    });
    if (confirmed.status !== 201) {
        throw new Error(`confirmation failed: ${JSON.stringify(confirmed.body)}`);
    }

    return {
        token,
        providerId: profile.body["providerId"] as string,
        cardId: card.body["cardId"] as string,
        publicId: approved.body["publicId"] as string,
        availabilityVersionId: availability.body["availabilityVersionId"] as string,
        weekStartDate
    };
}

/** A minimal valid PNG, for portrait proofs. */
export function tinyPng(): Buffer {
    return Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
    );
}
