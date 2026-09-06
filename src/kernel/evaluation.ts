// SCP Service-Commerce Kernel — ServiceCommerceEvaluation.
//
// "Can this service be sold, here, for this customer, at this time, under these
// operating rules?"
//
// CONFIGURATION PRECEDENCE is an INTERSECTION of authoritative constraints,
// evaluated in a fixed order. A broader layer can never authorize what an
// applicable narrower constraint forbids, so the first refusal wins and the
// evaluation short-circuits. The order below IS the precedence model:
//
//   tenant/market scope -> market enablement -> topology -> service ->
//   customer -> location/service area -> bookable window -> commercial basis ->
//   business hours -> location hours -> provider eligibility ->
//   provider availability -> required resources -> capacity
//
// Determinism is relative to `effectiveAt` and to the versioned authoritative
// inputs, not to wall clock. Two evaluations with the same inputs and the same
// effective time produce the same outcome, reason and canonical values.
//
// Nothing a client asserts about price, duration, eligibility or capacity is
// consulted. Client assertions are recorded in provenance so a reviewer can see
// what was claimed and that it did not bind.

import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { fail, succeed, type GovernedOutcome } from "../core/types";
import { requireUuid, isUuid } from "../core/identifiers";
import {
    loadMarketConfig,
    marketSupportsTopology,
    type FulfillmentTopology,
    type MarketConfig,
    type MarketId
} from "../config/marketConfig";
import { buildCommercialSnapshot, type CommercialSnapshot } from "../core/catalogue/catalogue";
import { isResourceFree } from "../core/capacity/capacity";
import {
    ALTERNATIVE_WORTHY_REASONS,
    type KernelDecisionReason
} from "./reasons";

export type EvaluationOutcome = "SELLABLE" | "NOT_SELLABLE" | "REQUIRES_ALTERNATIVE";

export interface EvaluationRequest {
    marketId: MarketId;
    topology: FulfillmentTopology;
    serviceId: string;
    customerIdentityId: string;
    requestedStart: Date;
    addonIds?: readonly string[];
    /** Required for INSTORE. */
    locationId?: string | null;
    /** Required for MOBILE. */
    serviceAreaKey?: string | null;
    /** Optional preference; never an override of eligibility. */
    preferredProviderId?: string | null;
    /** Determinism anchor. Defaults to now. */
    effectiveAt?: Date;
    /**
     * Recorded, never consulted. Present so that "a client cannot assert
     * authoritative price or duration" is provable rather than assumed.
     */
    clientAsserted?: {
        priceMinorUnits?: number;
        durationMinutes?: number;
    };
}

export interface SellableTerms {
    providerId: string;
    locationId: string | null;
    serviceAreaKey: string | null;
    startTime: Date;
    endTime: Date;
    durationMinutes: number;
    priceMinorUnits: number;
    currencyCode: string;
    priceVersionId: string;
    addons: CommercialSnapshot["addons"];
    durationBasis: {
        baseDurationMinutes: number;
        addonDurationMinutes: number;
        bufferMinutes: number;
        totalMinutes: number;
    };
    /** Every exclusive resource this sale would consume. */
    resourceKeys: string[];
}

export interface EvaluationAlternative {
    providerId: string;
    startTime: string;
    endTime: string;
    reason: "NEXT_AVAILABLE_TIME" | "ALTERNATE_PROVIDER";
}

export interface ServiceCommerceEvaluation {
    evaluationId: string;
    tenantId: string;
    marketId: string;
    topology: FulfillmentTopology;
    outcome: EvaluationOutcome;
    reasonCode: KernelDecisionReason | null;
    effectiveAt: Date;
    terms: SellableTerms | null;
    alternatives: EvaluationAlternative[];
}

interface Refusal {
    reason: KernelDecisionReason;
    detail: string;
}

function refuse(reason: KernelDecisionReason, detail: string): Refusal {
    return { reason, detail };
}

// --- operating policy helpers ------------------------------------------------

function withinBusinessHours(config: MarketConfig, start: Date, end: Date): boolean {
    const local = DateTime.fromJSDate(start).setZone(config.timezone);
    const localEnd = DateTime.fromJSDate(end).setZone(config.timezone);
    if (!local.isValid || !localEnd.isValid) {
        return false;
    }
    const open = local.set({
        hour: config.operatingHours.openingHour,
        minute: 0,
        second: 0,
        millisecond: 0
    });
    const close = local.set({
        hour: config.operatingHours.closingHour,
        minute: config.operatingHours.closingMinute,
        second: 0,
        millisecond: 0
    });
    // The whole service, including its buffer, must fit inside one local day's
    // operating window — a booking may not straddle the closing ceiling.
    return local >= open && localEnd <= close;
}

function minutesOfDay(dt: DateTime): number {
    return dt.hour * 60 + dt.minute;
}

// --- the evaluation ----------------------------------------------------------

/**
 * Runs the kernel and persists the decision record. Returns a governed outcome
 * whose value is the evaluation; a refusal is a SELLABLE=false evaluation, not
 * an error — only malformed input or missing configuration produce a failure.
 */
export async function evaluateServiceCommerce(
    client: PoolClient,
    request: EvaluationRequest
): Promise<GovernedOutcome<ServiceCommerceEvaluation>> {
    for (const [label, value] of Object.entries({
        serviceId: request.serviceId,
        customerIdentityId: request.customerIdentityId
    })) {
        const check = requireUuid(label, value);
        if (!check.ok) {
            return check;
        }
    }
    if (request.locationId != null && !isUuid(request.locationId)) {
        return fail("INVALID_IDENTIFIER", `locationId ${JSON.stringify(request.locationId)} is not a valid UUID`);
    }
    if (request.preferredProviderId != null && !isUuid(request.preferredProviderId)) {
        return fail(
            "INVALID_IDENTIFIER",
            `preferredProviderId ${JSON.stringify(request.preferredProviderId)} is not a valid UUID`
        );
    }

    let config: MarketConfig;
    try {
        config = loadMarketConfig(request.marketId);
    } catch (err) {
        return fail("MARKET_UNKNOWN", err instanceof Error ? err.message : String(err));
    }

    const effectiveAt = request.effectiveAt ?? new Date();
    const tenantId = config.tenantId;

    // No market-wide expiry sweep here. Capacity reads are already
    // expiry-aware (isResourceFree ignores elapsed ACTIVE holds), and
    // materialization happens narrowly, per resource, at the moment a hold is
    // actually taken. A blanket UPDATE at evaluation time made every concurrent
    // evaluation contend on the same rows for no correctness benefit.
    const decision = await composeDecision(client, request, config, effectiveAt);

    let outcome: EvaluationOutcome;
    let alternatives: EvaluationAlternative[] = [];
    if (decision.kind === "SELLABLE") {
        outcome = "SELLABLE";
    } else if (ALTERNATIVE_WORTHY_REASONS.has(decision.refusal.reason)) {
        alternatives = await findBoundedAlternatives(client, request, config, effectiveAt);
        outcome = alternatives.length > 0 ? "REQUIRES_ALTERNATIVE" : "NOT_SELLABLE";
    } else {
        outcome = "NOT_SELLABLE";
    }

    const terms = decision.kind === "SELLABLE" ? decision.terms : null;

    const inputsSnapshot = {
        marketId: request.marketId,
        tenantId,
        topology: request.topology,
        serviceId: request.serviceId,
        customerIdentityId: request.customerIdentityId,
        requestedStart: request.requestedStart.toISOString(),
        addonIds: [...(request.addonIds ?? [])].sort(),
        locationId: request.locationId ?? null,
        serviceAreaKey: request.serviceAreaKey ?? null,
        preferredProviderId: request.preferredProviderId ?? null,
        // Recorded and explicitly ignored.
        clientAsserted: request.clientAsserted ?? null,
        clientAssertionsHonoured: false
    };

    const configSnapshot = {
        marketId: config.marketId,
        tenantId: config.tenantId,
        status: config.status,
        timezone: config.timezone,
        currency: config.currency,
        operatingHours: config.operatingHours,
        bookingWindow: config.bookingWindow,
        topology: config.topology,
        offer: config.offer,
        billingCodePrefix: config.billing.codePrefix,
        killSwitch: config.featureFlags.killSwitch
    };

    const decisionSnapshot =
        decision.kind === "SELLABLE"
            ? {
                  outcome: "SELLABLE",
                  providerId: decision.terms.providerId,
                  locationId: decision.terms.locationId,
                  startTime: decision.terms.startTime.toISOString(),
                  endTime: decision.terms.endTime.toISOString(),
                  durationMinutes: decision.terms.durationMinutes,
                  durationBasis: decision.terms.durationBasis,
                  priceMinorUnits: decision.terms.priceMinorUnits,
                  currencyCode: decision.terms.currencyCode,
                  priceVersionId: decision.terms.priceVersionId,
                  resourceKeys: decision.terms.resourceKeys
              }
            : { outcome, reasonCode: decision.refusal.reason, detail: decision.refusal.detail };

    const inserted = await client.query<{ evaluation_id: string }>(
        `INSERT INTO core_commerce_evaluation
            (tenant_id, market_id, topology, outcome, reason_code, service_id,
             customer_identity_id, requested_start, effective_at,
             inputs_snapshot, config_snapshot, decision_snapshot, alternatives)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
         RETURNING evaluation_id`,
        [
            tenantId,
            request.marketId,
            request.topology,
            outcome,
            decision.kind === "SELLABLE" ? null : decision.refusal.reason,
            request.serviceId,
            request.customerIdentityId,
            request.requestedStart,
            effectiveAt,
            JSON.stringify(inputsSnapshot),
            JSON.stringify(configSnapshot),
            JSON.stringify(decisionSnapshot),
            JSON.stringify(alternatives)
        ]
    );

    return succeed({
        evaluationId: inserted.rows[0]!.evaluation_id,
        tenantId,
        marketId: request.marketId,
        topology: request.topology,
        outcome,
        reasonCode: decision.kind === "SELLABLE" ? null : decision.refusal.reason,
        effectiveAt,
        terms,
        alternatives
    });
}

type Decision =
    | { kind: "SELLABLE"; terms: SellableTerms }
    | { kind: "REFUSED"; refusal: Refusal };

async function composeDecision(
    client: PoolClient,
    request: EvaluationRequest,
    config: MarketConfig,
    effectiveAt: Date
): Promise<Decision> {
    const tenantId = config.tenantId;

    // 1 — MARKET ENABLEMENT
    if (config.status !== "ACTIVE") {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "SERVICE_NOT_AVAILABLE_IN_MARKET",
                `market ${config.marketId} status is ${config.status}`
            )
        };
    }
    if (config.featureFlags.killSwitch) {
        return {
            kind: "REFUSED",
            refusal: refuse("BUSINESS_CLOSED", `market ${config.marketId} kill switch is engaged`)
        };
    }

    // 2 — TOPOLOGY
    if (!marketSupportsTopology(config, request.topology)) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "TOPOLOGY_NOT_SUPPORTED",
                `market ${config.marketId} supports [${config.topology.supported.join(", ")}], not ${request.topology}`
            )
        };
    }

    // 3 — SERVICE
    const serviceRows = await client.query<{
        market_id: string;
        active: boolean;
    }>(`SELECT market_id, active FROM core_service WHERE service_id = $1`, [request.serviceId]);
    const service = serviceRows.rows[0];
    if (!service) {
        return { kind: "REFUSED", refusal: refuse("SERVICE_NOT_ACTIVE", "service not found") };
    }
    if (service.market_id !== request.marketId) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "SERVICE_NOT_AVAILABLE_IN_MARKET",
                `service belongs to market ${service.market_id}`
            )
        };
    }
    if (!service.active) {
        return { kind: "REFUSED", refusal: refuse("SERVICE_NOT_ACTIVE", "service is inactive") };
    }

    const topologyRows = await client.query<{ topology: string }>(
        `SELECT topology FROM core_service_topology WHERE service_id = $1 AND topology = $2`,
        [request.serviceId, request.topology]
    );
    if (topologyRows.rows.length === 0) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "TOPOLOGY_NOT_SUPPORTED",
                `service is not configured for ${request.topology}`
            )
        };
    }

    // 4 — CUSTOMER
    const customerRows = await client.query<{ market_id: string; role: string | null }>(
        `SELECT i.market_id, r.role
           FROM core_identity i
           LEFT JOIN core_identity_role r
             ON r.identity_id = i.identity_id AND r.market_id = i.market_id AND r.role = 'CUSTOMER'
          WHERE i.identity_id = $1`,
        [request.customerIdentityId]
    );
    const customer = customerRows.rows[0];
    if (!customer || customer.role !== "CUSTOMER") {
        return {
            kind: "REFUSED",
            refusal: refuse("CUSTOMER_NOT_ELIGIBLE", "customer identity lacks the CUSTOMER role")
        };
    }
    if (customer.market_id !== request.marketId) {
        return {
            kind: "REFUSED",
            refusal: refuse("MARKET_MISMATCH", `customer belongs to market ${customer.market_id}`)
        };
    }

    // 5 — LOCATION / SERVICE AREA
    let locationId: string | null = null;
    let locationTimezone: string | null = null;
    if (request.topology === "INSTORE") {
        if (!request.locationId) {
            return {
                kind: "REFUSED",
                refusal: refuse("LOCATION_NOT_SERVICEABLE", "INSTORE requires a locationId")
            };
        }
        const locRows = await client.query<{
            tenant_id: string;
            market_id: string;
            timezone: string;
            active: boolean;
        }>(
            `SELECT tenant_id, market_id, timezone, active FROM core_location WHERE location_id = $1`,
            [request.locationId]
        );
        const location = locRows.rows[0];
        if (!location || !location.active) {
            return {
                kind: "REFUSED",
                refusal: refuse("LOCATION_NOT_SERVICEABLE", "location not found or inactive")
            };
        }
        if (location.tenant_id !== tenantId) {
            return {
                kind: "REFUSED",
                refusal: refuse("TENANT_MISMATCH", `location belongs to tenant ${location.tenant_id}`)
            };
        }
        if (location.market_id !== request.marketId) {
            return {
                kind: "REFUSED",
                refusal: refuse("MARKET_MISMATCH", `location belongs to market ${location.market_id}`)
            };
        }
        locationId = request.locationId;
        locationTimezone = location.timezone;
    } else {
        if (!request.serviceAreaKey) {
            return {
                kind: "REFUSED",
                refusal: refuse("LOCATION_NOT_SERVICEABLE", "MOBILE requires a serviceAreaKey")
            };
        }
        const areaRows = await client.query<{ service_area_id: string }>(
            `SELECT service_area_id FROM core_service_area
              WHERE tenant_id = $1 AND market_id = $2 AND area_key = $3 AND active = TRUE`,
            [tenantId, request.marketId, request.serviceAreaKey]
        );
        if (areaRows.rows.length === 0) {
            return {
                kind: "REFUSED",
                refusal: refuse(
                    "LOCATION_NOT_SERVICEABLE",
                    `service area ${request.serviceAreaKey} is not serviceable`
                )
            };
        }
    }

    // 6 — BOOKABLE WINDOW
    const leadMs = request.requestedStart.getTime() - effectiveAt.getTime();
    if (leadMs < config.bookingWindow.minLeadMinutes * 60_000) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "OUTSIDE_BOOKABLE_WINDOW",
                `requires at least ${config.bookingWindow.minLeadMinutes} minutes lead time`
            )
        };
    }
    if (leadMs > config.bookingWindow.maxAdvanceDays * 24 * 3_600_000) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "OUTSIDE_BOOKABLE_WINDOW",
                `beyond ${config.bookingWindow.maxAdvanceDays} days of advance booking`
            )
        };
    }

    // 7 — COMMERCIAL BASIS (canonical price and duration; never client-supplied)
    const snapshot = await buildCommercialSnapshot(
        client,
        request.serviceId,
        request.addonIds ?? []
    );
    if (!snapshot.ok) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                snapshot.code === "NOT_FOUND" ? "PRICE_UNAVAILABLE" : "COMMERCIAL_RULE_NOT_SATISFIED",
                snapshot.message
            )
        };
    }
    const terms = snapshot.value;
    const startTime = request.requestedStart;
    const endTime = new Date(startTime.getTime() + terms.durationMinutes * 60_000);

    // 8 — BUSINESS OPERATING POLICY
    if (!withinBusinessHours(config, startTime, endTime)) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "BUSINESS_CLOSED",
                `outside ${config.operatingHours.openingHour}:00-${config.operatingHours.closingHour}:${String(config.operatingHours.closingMinute).padStart(2, "0")} ${config.timezone}`
            )
        };
    }

    // 9 — LOCATION OPERATING POLICY (narrower than business policy)
    if (locationId && locationTimezone) {
        const open = await locationIsOpen(client, locationId, locationTimezone, startTime, endTime);
        if (!open) {
            return {
                kind: "REFUSED",
                refusal: refuse("LOCATION_CLOSED", `location is closed for the requested window`)
            };
        }
    }

    // 10 — PROVIDER ELIGIBILITY
    const eligible = await eligibleProviders(client, request, locationId);
    if (eligible.length === 0) {
        return {
            kind: "REFUSED",
            refusal: refuse("NO_ELIGIBLE_PROVIDER", "no approved provider is eligible for this service")
        };
    }

    const candidates = request.preferredProviderId
        ? eligible.filter((p) => p === request.preferredProviderId)
        : eligible;
    if (candidates.length === 0) {
        return {
            kind: "REFUSED",
            refusal: refuse(
                "NO_ELIGIBLE_PROVIDER",
                `preferred provider ${request.preferredProviderId} is not eligible`
            )
        };
    }

    // 11..13 — availability, resources, capacity, per candidate in a stable order
    let sawAvailability = false;
    let sawResources = false;
    for (const providerId of candidates) {
        const available = await providerIsAvailable(client, providerId, startTime, endTime);
        if (!available) {
            continue;
        }
        sawAvailability = true;

        const resources = await resolveRequiredResources(
            client,
            request,
            tenantId,
            locationId,
            startTime,
            endTime,
            effectiveAt
        );
        if (!resources.ok) {
            continue;
        }
        sawResources = true;

        const providerKey = `PROVIDER:${providerId}`;
        // Sorted so every transaction acquires exclusive resources in the same
        // order — two multi-resource bookings cannot deadlock against each other.
        const resourceKeys = [providerKey, ...resources.keys].sort();

        let allFree = true;
        for (const key of resourceKeys) {
            if (!(await isResourceFree(client, request.marketId, key, startTime, endTime, effectiveAt))) {
                allFree = false;
                break;
            }
        }
        if (!allFree) {
            continue;
        }

        return {
            kind: "SELLABLE",
            terms: {
                providerId,
                locationId,
                serviceAreaKey: request.serviceAreaKey ?? null,
                startTime,
                endTime,
                durationMinutes: terms.durationMinutes,
                priceMinorUnits: terms.priceMinorUnits,
                currencyCode: terms.currencyCode,
                priceVersionId: terms.priceVersionId,
                addons: terms.addons,
                durationBasis: {
                    baseDurationMinutes: terms.baseDurationMinutes,
                    addonDurationMinutes: terms.addonDurationMinutes,
                    bufferMinutes: terms.bufferMinutes,
                    totalMinutes: terms.durationMinutes
                },
                resourceKeys
            }
        };
    }

    if (!sawAvailability) {
        return {
            kind: "REFUSED",
            refusal: refuse("PROVIDER_UNAVAILABLE", "no eligible provider has declared availability")
        };
    }
    if (!sawResources) {
        return {
            kind: "REFUSED",
            refusal: refuse("REQUIRED_RESOURCE_UNAVAILABLE", "a required resource is unavailable")
        };
    }
    return {
        kind: "REFUSED",
        refusal: refuse("CAPACITY_UNAVAILABLE", "exclusive capacity is already taken for this window")
    };
}

async function locationIsOpen(
    client: PoolClient,
    locationId: string,
    timezone: string,
    start: Date,
    end: Date
): Promise<boolean> {
    const localStart = DateTime.fromJSDate(start).setZone(timezone);
    const localEnd = DateTime.fromJSDate(end).setZone(timezone);
    if (!localStart.isValid || !localEnd.isValid) {
        return false;
    }
    // Luxon weekday is 1=Mon..7=Sun; the schema stores 0=Sun..6=Sat.
    const weekday = localStart.weekday % 7;
    const { rows } = await client.query<{ open_minute: number; close_minute: number }>(
        `SELECT open_minute, close_minute FROM core_location_hours
          WHERE location_id = $1 AND weekday = $2`,
        [locationId, weekday]
    );
    const hours = rows[0];
    if (!hours) {
        return false; // no declared hours for that day = closed, fail closed
    }
    if (!localStart.hasSame(localEnd, "day")) {
        return false;
    }
    return (
        minutesOfDay(localStart) >= hours.open_minute &&
        minutesOfDay(localEnd) <= hours.close_minute
    );
}

async function eligibleProviders(
    client: PoolClient,
    request: EvaluationRequest,
    locationId: string | null
): Promise<string[]> {
    const params: unknown[] = [request.serviceId, request.marketId];
    let locationJoin = "";
    if (locationId) {
        locationJoin = `JOIN core_provider_location pl
                          ON pl.provider_id = p.provider_id AND pl.location_id = $3`;
        params.push(locationId);
    }
    const { rows } = await client.query<{ provider_id: string }>(
        `SELECT p.provider_id
           FROM core_provider p
           JOIN core_provider_service ps ON ps.provider_id = p.provider_id AND ps.service_id = $1
           ${locationJoin}
          WHERE p.market_id = $2
            AND p.supply_status = 'APPROVED'
          ORDER BY p.provider_id`,
        params
    );
    return rows.map((r) => r.provider_id);
}

async function providerIsAvailable(
    client: PoolClient,
    providerId: string,
    start: Date,
    end: Date
): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM core_capacity_window
             WHERE provider_id = $1 AND active = TRUE
               AND during @> tstzrange($2, $3, '[)')
         ) AS ok`,
        [providerId, start, end]
    );
    return rows[0]?.ok === true;
}

async function resolveRequiredResources(
    client: PoolClient,
    request: EvaluationRequest,
    tenantId: string,
    locationId: string | null,
    start: Date,
    end: Date,
    asOf: Date
): Promise<{ ok: true; keys: string[] } | { ok: false }> {
    const { rows: required } = await client.query<{ resource_kind: string }>(
        `SELECT resource_kind FROM core_service_resource_requirement
          WHERE service_id = $1 ORDER BY resource_kind`,
        [request.serviceId]
    );
    const keys: string[] = [];
    for (const requirement of required) {
        const params: unknown[] = [tenantId, request.marketId, requirement.resource_kind];
        let locationFilter = "";
        if (locationId) {
            locationFilter = "AND location_id = $4";
            params.push(locationId);
        }
        const { rows: candidates } = await client.query<{ resource_id: string }>(
            `SELECT resource_id FROM core_resource
              WHERE tenant_id = $1 AND market_id = $2 AND resource_kind = $3 AND active = TRUE
                ${locationFilter}
              ORDER BY resource_id`,
            params
        );
        let chosen: string | null = null;
        for (const candidate of candidates) {
            const key = `RESOURCE:${candidate.resource_id}`;
            if (await isResourceFree(client, request.marketId, key, start, end, asOf)) {
                chosen = key;
                break;
            }
        }
        if (!chosen) {
            return { ok: false };
        }
        keys.push(chosen);
    }
    return { ok: true, keys };
}

/**
 * Bounded, deterministic, rule-respecting alternatives.
 *
 * Bounded: a fixed offset ladder and a hard cap. Deterministic: providers in
 * id order, offsets in a fixed order, no randomness and no ranking. Every
 * alternative is a proposal only — it must be independently evaluated and
 * become its own offer before anything can be committed against it.
 */
const ALTERNATIVE_OFFSET_MINUTES = [30, 60, 90, 120, 180] as const;
const MAX_ALTERNATIVES = 3;

async function findBoundedAlternatives(
    client: PoolClient,
    request: EvaluationRequest,
    config: MarketConfig,
    effectiveAt: Date
): Promise<EvaluationAlternative[]> {
    const found: EvaluationAlternative[] = [];
    for (const offset of ALTERNATIVE_OFFSET_MINUTES) {
        if (found.length >= MAX_ALTERNATIVES) {
            break;
        }
        const candidateStart = new Date(request.requestedStart.getTime() + offset * 60_000);
        const probe = await composeDecision(
            client,
            { ...request, requestedStart: candidateStart, preferredProviderId: null },
            config,
            effectiveAt
        );
        if (probe.kind === "SELLABLE") {
            found.push({
                providerId: probe.terms.providerId,
                startTime: probe.terms.startTime.toISOString(),
                endTime: probe.terms.endTime.toISOString(),
                reason:
                    request.preferredProviderId &&
                    probe.terms.providerId !== request.preferredProviderId
                        ? "ALTERNATE_PROVIDER"
                        : "NEXT_AVAILABLE_TIME"
            });
        }
    }
    return found;
}
