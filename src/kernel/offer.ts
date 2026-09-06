// SCP Service-Commerce Kernel — SellableOffer.
//
// The canonical pre-commit commercial aggregate. An offer is what the customer
// was actually shown, frozen: price, duration, provider, window, and the
// configuration that produced them. Its commercial content is immutable at the
// database level (migration 005 trigger); a material change is expressed by
// SUPERSEDING the offer with a new version under the same offer_key, never by
// editing it.
//
// An offer carries its own capacity. Creating an offer places first-class
// ACTIVE holds for every exclusive resource the sale would consume, so a
// customer holding an offer is holding the slot, and a hold can never outlive
// the offer that governs it.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type GovernedOutcome } from "../core/types";
import { requireUuid } from "../core/identifiers";
import { recordEvent } from "../core/events/eventLog";
import {
    invalidateHoldsForOffer,
    placeKernelHold,
    releaseKernelHold,
    holdsForOffer
} from "../core/capacity/capacity";
import { loadMarketConfig, type MarketId } from "../config/marketConfig";
import { evaluateServiceCommerce, type EvaluationRequest, type ServiceCommerceEvaluation } from "./evaluation";
import type { KernelDecisionReason } from "./reasons";

export type SellableOfferState = "ACTIVE" | "COMMITTED" | "EXPIRED" | "INVALIDATED" | "SUPERSEDED";

export interface SellableOffer {
    offerId: string;
    offerKey: string;
    version: number;
    tenantId: string;
    marketId: string;
    topology: string;
    state: SellableOfferState;
    evaluationId: string;
    customerIdentityId: string;
    serviceId: string;
    providerId: string;
    locationId: string | null;
    startTime: Date;
    endTime: Date;
    durationMinutes: number;
    priceMinorUnits: number;
    currencyCode: string;
    priceVersionId: string;
    expiresAt: Date;
    requestFingerprint: string;
    committedRequestId: string | null;
}

export interface KernelRefusal {
    reasonCode: KernelDecisionReason;
    message: string;
    evaluation?: ServiceCommerceEvaluation;
}

export type OfferOutcome =
    | { ok: true; offer: SellableOffer; evaluation: ServiceCommerceEvaluation; replayed: boolean }
    | { ok: false; refusal: KernelRefusal };

/**
 * Materially-identifying fingerprint of an offer request. Two calls with the
 * same idempotency key are the same call only if this matches; otherwise the
 * key was reused for different work and that is an IDEMPOTENCY_CONFLICT rather
 * than a silent second offer.
 */
export function offerRequestFingerprint(request: EvaluationRequest, tenantId: string): string {
    const canonical = JSON.stringify({
        tenantId,
        marketId: request.marketId,
        topology: request.topology,
        serviceId: request.serviceId,
        customerIdentityId: request.customerIdentityId,
        requestedStart: request.requestedStart.toISOString(),
        addonIds: [...(request.addonIds ?? [])].map((a) => a.toLowerCase()).sort(),
        locationId: request.locationId ?? null,
        serviceAreaKey: request.serviceAreaKey ?? null,
        preferredProviderId: request.preferredProviderId ?? null
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function rowToOffer(row: Record<string, unknown>): SellableOffer {
    return {
        offerId: row["offer_id"] as string,
        offerKey: row["offer_key"] as string,
        version: row["version"] as number,
        tenantId: row["tenant_id"] as string,
        marketId: row["market_id"] as string,
        topology: row["topology"] as string,
        state: row["state"] as SellableOfferState,
        evaluationId: row["evaluation_id"] as string,
        customerIdentityId: row["customer_identity_id"] as string,
        serviceId: row["service_id"] as string,
        providerId: row["provider_id"] as string,
        locationId: (row["location_id"] as string | null) ?? null,
        startTime: row["start_time"] as Date,
        endTime: row["end_time"] as Date,
        durationMinutes: row["duration_minutes"] as number,
        priceMinorUnits: Number(row["price_minor_units"]),
        currencyCode: row["currency_code"] as string,
        priceVersionId: row["price_version_id"] as string,
        expiresAt: row["expires_at"] as Date,
        requestFingerprint: row["request_fingerprint"] as string,
        committedRequestId: (row["committed_request_id"] as string | null) ?? null
    };
}

const OFFER_COLUMNS = `offer_id, offer_key, version, tenant_id, market_id, topology, state,
                       evaluation_id, customer_identity_id, service_id, provider_id, location_id,
                       start_time, end_time, duration_minutes, price_minor_units, currency_code,
                       price_version_id, expires_at, request_fingerprint, committed_request_id`;

export async function loadOffer(
    client: PoolClient,
    offerId: string,
    forUpdate = false
): Promise<SellableOffer | null> {
    const { rows } = await client.query(
        `SELECT ${OFFER_COLUMNS} FROM core_sellable_offer
          WHERE offer_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
        [offerId]
    );
    return rows[0] ? rowToOffer(rows[0]) : null;
}

export interface CreateOfferInput extends EvaluationRequest {
    idempotencyKey: string;
    actor: Actor;
    /** Supersede this offer, keeping its offer_key and bumping the version. */
    supersedes?: string | null;
}

/**
 * Evaluates and, if sellable, persists an offer plus its capacity holds in the
 * caller's transaction. Either the offer exists with every hold it needs, or
 * nothing was written.
 */
export async function createSellableOffer(
    client: PoolClient,
    input: CreateOfferInput
): Promise<OfferOutcome> {
    let config;
    try {
        config = loadMarketConfig(input.marketId as MarketId);
    } catch (err) {
        return {
            ok: false,
            refusal: {
                reasonCode: "MARKET_MISMATCH",
                message: err instanceof Error ? err.message : String(err)
            }
        };
    }
    const tenantId = config.tenantId;
    const fingerprint = offerRequestFingerprint(input, tenantId);

    // Idempotent replay check before doing any work.
    const existing = await client.query(
        `SELECT ${OFFER_COLUMNS} FROM core_sellable_offer
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, input.idempotencyKey]
    );
    if (existing.rows[0]) {
        const prior = rowToOffer(existing.rows[0]);
        if (prior.requestFingerprint !== fingerprint) {
            return {
                ok: false,
                refusal: {
                    reasonCode: "IDEMPOTENCY_CONFLICT",
                    message: `idempotency key ${input.idempotencyKey} was already used for a materially different offer request`
                }
            };
        }
        const evaluationRow = await client.query<{ evaluation_id: string }>(
            `SELECT evaluation_id FROM core_commerce_evaluation WHERE evaluation_id = $1`,
            [prior.evaluationId]
        );
        return {
            ok: true,
            offer: prior,
            replayed: true,
            evaluation: {
                evaluationId: evaluationRow.rows[0]!.evaluation_id,
                tenantId: prior.tenantId,
                marketId: prior.marketId,
                topology: prior.topology as never,
                outcome: "SELLABLE",
                reasonCode: null,
                effectiveAt: prior.startTime,
                terms: null,
                alternatives: []
            }
        };
    }

    const evaluated = await evaluateServiceCommerce(client, input);
    if (!evaluated.ok) {
        return {
            ok: false,
            refusal: { reasonCode: "INVALID_IDENTIFIER", message: evaluated.message }
        };
    }
    const evaluation = evaluated.value;
    if (evaluation.outcome !== "SELLABLE" || !evaluation.terms) {
        return {
            ok: false,
            refusal: {
                reasonCode: evaluation.reasonCode ?? "COMMERCIAL_RULE_NOT_SATISFIED",
                message: `not sellable: ${evaluation.reasonCode}`,
                evaluation
            }
        };
    }

    const terms = evaluation.terms;
    const effectiveAt = evaluation.effectiveAt;
    const expiresAt = new Date(effectiveAt.getTime() + config.offer.validityMinutes * 60_000);
    const holdExpiresAt = new Date(
        effectiveAt.getTime() + config.offer.capacityHoldTtlMinutes * 60_000
    );

    // Supersession keeps lineage under one offer_key.
    let offerKey: string | null = null;
    let version = 1;
    if (input.supersedes) {
        const priorOffer = await loadOffer(client, input.supersedes, true);
        if (!priorOffer) {
            return {
                ok: false,
                refusal: { reasonCode: "OFFER_NO_LONGER_VALID", message: "offer to supersede not found" }
            };
        }
        await closeOffer(client, priorOffer, "SUPERSEDED", input.actor, `${input.idempotencyKey}:supersede`);
        offerKey = priorOffer.offerKey;
        version = priorOffer.version + 1;
    }

    const inserted = await client.query(
        `INSERT INTO core_sellable_offer
            (tenant_id, market_id, topology, offer_key, version, state, evaluation_id,
             customer_identity_id, service_id, provider_id, location_id, service_area_key,
             start_time, end_time, duration_minutes, price_minor_units, currency_code,
             price_version_id, addons_snapshot, duration_basis, config_provenance,
             request_fingerprint, idempotency_key, expires_at)
         VALUES ($1, $2, $3, COALESCE($4::uuid, gen_random_uuid()), $5, 'ACTIVE', $6,
                 $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16,
                 $17, $18::jsonb, $19::jsonb, $20::jsonb,
                 $21, $22, $23)
         RETURNING ${OFFER_COLUMNS}`,
        [
            tenantId,
            input.marketId,
            input.topology,
            offerKey,
            version,
            evaluation.evaluationId,
            input.customerIdentityId,
            input.serviceId,
            terms.providerId,
            terms.locationId,
            terms.serviceAreaKey,
            terms.startTime,
            terms.endTime,
            terms.durationMinutes,
            terms.priceMinorUnits,
            terms.currencyCode,
            terms.priceVersionId,
            JSON.stringify(terms.addons),
            JSON.stringify(terms.durationBasis),
            JSON.stringify({
                marketId: config.marketId,
                tenantId: config.tenantId,
                timezone: config.timezone,
                currency: config.currency,
                operatingHours: config.operatingHours,
                bookingWindow: config.bookingWindow,
                offer: config.offer,
                topology: config.topology
            }),
            fingerprint,
            input.idempotencyKey,
            expiresAt
        ]
    );
    const offer = rowToOffer(inserted.rows[0]!);

    // Capacity: every exclusive resource this sale consumes, or nothing.
    for (const resourceKey of terms.resourceKeys) {
        const held = await placeKernelHold(
            client,
            {
                tenantId,
                marketId: input.marketId,
                providerId: terms.providerId,
                locationId: terms.locationId ?? "MOBILE",
                resourceKey,
                offerId: offer.offerId,
                startTime: terms.startTime,
                endTime: terms.endTime,
                expiresAt: holdExpiresAt
            },
            input.actor,
            `${input.idempotencyKey}:hold:${resourceKey}`
        );
        if (!held.ok) {
            return {
                ok: false,
                refusal: {
                    reasonCode: "CAPACITY_CONFLICT",
                    message: held.message,
                    evaluation
                }
            };
        }
    }

    await recordEvent(client, {
        marketId: input.marketId,
        objectType: "CAPACITY_HOLD",
        objectId: offer.offerId,
        fromState: null,
        toState: "OFFER_ACTIVE",
        actor: input.actor,
        governingRef: `evaluation:${evaluation.evaluationId}`,
        idempotencyKey: `${input.idempotencyKey}:offer`,
        payload: {
            offerKey: offer.offerKey,
            version: offer.version,
            priceMinorUnits: offer.priceMinorUnits,
            currencyCode: offer.currencyCode,
            durationMinutes: offer.durationMinutes,
            expiresAt: offer.expiresAt.toISOString(),
            resourceKeys: terms.resourceKeys
        }
    });

    return { ok: true, offer, evaluation, replayed: false };
}

/** Moves an offer to a terminal state and releases the capacity it governed. */
async function closeOffer(
    client: PoolClient,
    offer: SellableOffer,
    terminal: "EXPIRED" | "INVALIDATED" | "SUPERSEDED",
    actor: Actor,
    idempotencyKey: string
): Promise<void> {
    await client.query(`UPDATE core_sellable_offer SET state = $2 WHERE offer_id = $1`, [
        offer.offerId,
        terminal
    ]);
    await invalidateHoldsForOffer(client, offer.offerId, offer.marketId, actor, idempotencyKey);
    await recordEvent(client, {
        marketId: offer.marketId,
        objectType: "CAPACITY_HOLD",
        objectId: offer.offerId,
        fromState: offer.state,
        toState: `OFFER_${terminal}`,
        actor,
        idempotencyKey: `${idempotencyKey}:${terminal}`
    });
}

export async function invalidateOffer(
    client: PoolClient,
    offerId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<GovernedOutcome<{ offerId: string; state: SellableOfferState }>> {
    const ids = requireUuid("offerId", offerId);
    if (!ids.ok) {
        return ids;
    }
    const offer = await loadOffer(client, offerId, true);
    if (!offer) {
        return fail("NOT_FOUND", `offer ${offerId} not found`);
    }
    if (offer.state !== "ACTIVE") {
        return succeed({ offerId, state: offer.state });
    }
    await closeOffer(client, offer, "INVALIDATED", actor, idempotencyKey);
    return succeed({ offerId, state: "INVALIDATED" });
}

/**
 * Materializes offer expiry and releases the capacity those offers were
 * holding, so an abandoned offer cannot keep a slot indefinitely.
 */
export async function expireSellableOffers(
    client: PoolClient,
    marketId: string,
    now: Date,
    actor: Actor
): Promise<string[]> {
    const { rows } = await client.query<{ offer_id: string }>(
        `SELECT offer_id FROM core_sellable_offer
          WHERE market_id = $1 AND state = 'ACTIVE' AND expires_at <= $2
          ORDER BY expires_at`,
        [marketId, now]
    );
    const expired: string[] = [];
    for (const row of rows) {
        const offer = await loadOffer(client, row.offer_id, true);
        if (!offer || offer.state !== "ACTIVE") {
            continue;
        }
        await closeOffer(client, offer, "EXPIRED", actor, `expiry:${offer.offerId}`);
        expired.push(offer.offerId);
    }
    return expired;
}

export interface RevalidationResult {
    valid: boolean;
    reasonCode: KernelDecisionReason | null;
    detail: string;
}

/**
 * Pre-commit revalidation. Confirms the offer is still the current authoritative
 * proposition: not expired, not superseded, holds intact, and the commercial
 * terms still equal to what the offer froze. A drift in canonical price or
 * duration means the customer is looking at a stale proposition and must be
 * given a new offer rather than silently charged today's number.
 */
export async function revalidateOffer(
    client: PoolClient,
    offer: SellableOffer,
    effectiveAt: Date
): Promise<RevalidationResult> {
    if (offer.state === "COMMITTED") {
        return { valid: false, reasonCode: "OFFER_NO_LONGER_VALID", detail: "offer already committed" };
    }
    if (offer.state === "SUPERSEDED") {
        return { valid: false, reasonCode: "OFFER_SUPERSEDED", detail: "offer was superseded" };
    }
    if (offer.state !== "ACTIVE") {
        return { valid: false, reasonCode: "OFFER_NO_LONGER_VALID", detail: `offer is ${offer.state}` };
    }
    if (effectiveAt >= offer.expiresAt) {
        return { valid: false, reasonCode: "OFFER_EXPIRED", detail: "offer validity window elapsed" };
    }

    const holds = await holdsForOffer(client, offer.offerId);
    if (holds.length === 0) {
        return {
            valid: false,
            reasonCode: "OFFER_NO_LONGER_VALID",
            detail: "offer has no capacity holds"
        };
    }
    for (const hold of holds) {
        if (hold.state !== "ACTIVE") {
            return {
                valid: false,
                reasonCode:
                    hold.state === "EXPIRED" ? "CAPACITY_HOLD_EXPIRED" : "OFFER_NO_LONGER_VALID",
                detail: `capacity hold ${hold.holdId} is ${hold.state}`
            };
        }
        if (hold.expiresAt && effectiveAt >= hold.expiresAt) {
            return {
                valid: false,
                reasonCode: "CAPACITY_HOLD_EXPIRED",
                detail: `capacity hold ${hold.holdId} TTL elapsed`
            };
        }
    }

    // Commercial drift check against live authoritative truth.
    const priceRows = await client.query<{
        price_minor_units: string;
        currency_code: string;
        active: boolean;
    }>(
        `SELECT price_minor_units, currency_code, active
           FROM core_service_price_version WHERE price_version_id = $1`,
        [offer.priceVersionId]
    );
    const price = priceRows.rows[0];
    if (!price || !price.active) {
        return {
            valid: false,
            reasonCode: "OFFER_REVALIDATION_REQUIRED",
            detail: "the price version this offer was built on is no longer active"
        };
    }

    const serviceRows = await client.query<{ active: boolean }>(
        `SELECT active FROM core_service WHERE service_id = $1`,
        [offer.serviceId]
    );
    if (!serviceRows.rows[0]?.active) {
        return {
            valid: false,
            reasonCode: "SERVICE_NOT_ACTIVE",
            detail: "service is no longer active"
        };
    }

    const providerRows = await client.query<{ supply_status: string }>(
        `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
        [offer.providerId]
    );
    if (providerRows.rows[0]?.supply_status !== "APPROVED") {
        return {
            valid: false,
            reasonCode: "PROVIDER_UNAVAILABLE",
            detail: "provider supply is no longer approved"
        };
    }

    return { valid: true, reasonCode: null, detail: "offer remains authoritative" };
}

export { releaseKernelHold };
