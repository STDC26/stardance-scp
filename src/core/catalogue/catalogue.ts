// SCP Core Foundation — Catalogue and commercial truth.
//
// COMMERCIAL_TRUTH:
//   DURATION = BASE SERVICE DURATION + ACTIVE ADD-ON DURATIONS + CONFIGURED
//              BUFFER THAT CONSUMES EXCLUSIVE CAPACITY
//   PRICE    = snapshot locked on the accepted/persisted Service Request
//              version. Catalogue movement never reprices a persisted request.
//
// The buffer is included in the duration because it consumes exclusive
// capacity: if it did not participate, two bookings could be held back-to-back
// with no turnaround and the capacity module would consider that legal.

import type { PoolClient } from "pg";
import { fail, succeed, type GovernedOutcome } from "../types";

export interface AddonSnapshot {
    addonId: string;
    name: string;
    extraDurationMinutes: number;
    priceMinorUnits: number;
}

export interface CommercialSnapshot {
    serviceId: string;
    priceVersionId: string;
    /** Service price + add-on prices, in the currency's minor units. */
    priceMinorUnits: number;
    currencyCode: string;
    /** Base + add-ons + buffer. */
    durationMinutes: number;
    baseDurationMinutes: number;
    addonDurationMinutes: number;
    bufferMinutes: number;
    addons: AddonSnapshot[];
}

/**
 * Pure duration composition, separated from persistence so the arithmetic is
 * unit-testable without a database.
 */
export function composeDuration(
    baseDurationMinutes: number,
    addonDurationMinutes: number,
    bufferMinutes: number
): number {
    return baseDurationMinutes + addonDurationMinutes + bufferMinutes;
}

/**
 * Builds the commercial snapshot for a service at its currently active price
 * version. The returned object is what gets frozen onto a request version — it
 * is deliberately a value, not a live reference into the catalogue.
 */
export async function buildCommercialSnapshot(
    client: PoolClient,
    serviceId: string,
    addonIds: readonly string[] = []
): Promise<GovernedOutcome<CommercialSnapshot>> {
    const serviceRows = await client.query<{
        service_id: string;
        base_duration_minutes: number;
        active: boolean;
    }>(
        `SELECT service_id, base_duration_minutes, active FROM core_service WHERE service_id = $1`,
        [serviceId]
    );
    const service = serviceRows.rows[0];
    if (!service) {
        return fail("NOT_FOUND", `service ${serviceId} not found`);
    }
    if (!service.active) {
        return fail("INVALID_TRANSITION", `service ${serviceId} is inactive`);
    }

    const priceRows = await client.query<{
        price_version_id: string;
        price_minor_units: string;
        currency_code: string;
        buffer_minutes: number;
    }>(
        `SELECT price_version_id, price_minor_units, currency_code, buffer_minutes
           FROM core_service_price_version
          WHERE service_id = $1 AND active = TRUE
          ORDER BY effective_from DESC
          LIMIT 1`,
        [serviceId]
    );
    const price = priceRows.rows[0];
    if (!price) {
        return fail("NOT_FOUND", `service ${serviceId} has no active price version`);
    }

    let addons: AddonSnapshot[] = [];
    if (addonIds.length > 0) {
        const addonRows = await client.query<{
            addon_id: string;
            name: string;
            extra_duration_minutes: number;
            price_minor_units: string;
        }>(
            `SELECT addon_id, name, extra_duration_minutes, price_minor_units
               FROM core_service_addon
              WHERE service_id = $1 AND active = TRUE AND addon_id = ANY($2::uuid[])`,
            [serviceId, addonIds]
        );
        if (addonRows.rows.length !== addonIds.length) {
            return fail(
                "NOT_FOUND",
                `one or more add-ons are unknown or inactive for service ${serviceId}`
            );
        }
        addons = addonRows.rows.map((r) => ({
            addonId: r.addon_id,
            name: r.name,
            extraDurationMinutes: r.extra_duration_minutes,
            priceMinorUnits: Number(r.price_minor_units)
        }));
    }

    const addonDurationMinutes = addons.reduce((sum, a) => sum + a.extraDurationMinutes, 0);
    const addonPrice = addons.reduce((sum, a) => sum + a.priceMinorUnits, 0);

    return succeed({
        serviceId,
        priceVersionId: price.price_version_id,
        priceMinorUnits: Number(price.price_minor_units) + addonPrice,
        currencyCode: price.currency_code,
        durationMinutes: composeDuration(
            service.base_duration_minutes,
            addonDurationMinutes,
            price.buffer_minutes
        ),
        baseDurationMinutes: service.base_duration_minutes,
        addonDurationMinutes,
        bufferMinutes: price.buffer_minutes,
        addons
    });
}
