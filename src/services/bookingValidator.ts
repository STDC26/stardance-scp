// Freshline Studio Bali — MSOS Phase 0/1
// REQ-INTK-VALID-05: canonical time & service-duration boundary validator.
//
// The studio's operating window is defined in local wall-clock time in
// Asia/Makassar (UTC+8, no DST — WITA). A booking is only valid if its
// computed end time (start + catalogue duration) falls at-or-before the
// closing ceiling on the *local calendar day the booking starts on*. The
// boundary is inclusive: an appointment that ends at exactly 23:00:00.000
// local is valid; one that ends at 23:00:00.001 is not.
//
// ASSUMPTION FLAGGED FOR HUMAN REVIEW (see Part D): the opening-hour floor
// (09:00 local) was not specified in the requirement and is a reasonable
// default invented for completeness, not a value ChatGPT or ops confirmed.
// It is isolated in OPENING_HOUR below so it can be corrected in one place.

import { DateTime } from "luxon";
import type { Pool } from "pg";
import type { BookingValidationResult } from "../types";

export const STUDIO_TIMEZONE = "Asia/Makassar";
export const CLOSING_HOUR = 23;
export const CLOSING_MINUTE = 0;
/** UNCONFIRMED ASSUMPTION — see module header. */
export const OPENING_HOUR = 9;

/**
 * Pure boundary check: given a start instant and a duration in minutes,
 * determines whether the booking fits within the studio's local operating
 * window. Contains no I/O so it can be exhaustively unit-tested at
 * millisecond precision without a database.
 */
export function validateBookingWindow(
    startTime: Date | string,
    durationMinutes: number
): BookingValidationResult {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
        return {
            valid: false,
            reasonCode: "INVALID_DURATION",
            message: `durationMinutes must be a positive integer, got ${durationMinutes}`
        };
    }

    const startUtc =
        typeof startTime === "string"
            ? DateTime.fromISO(startTime, { setZone: true })
            : DateTime.fromJSDate(startTime);

    if (!startUtc.isValid) {
        return {
            valid: false,
            reasonCode: "INVALID_START_TIME",
            message: startUtc.invalidReason ?? "Unparseable start time"
        };
    }

    const startLocal = startUtc.setZone(STUDIO_TIMEZONE);
    const endLocal = startLocal.plus({ minutes: durationMinutes });

    const openingLocal = startLocal.set({
        hour: OPENING_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0
    });
    const closingCeilingLocal = startLocal.set({
        hour: CLOSING_HOUR,
        minute: CLOSING_MINUTE,
        second: 0,
        millisecond: 0
    });

    if (startLocal.toMillis() < openingLocal.toMillis()) {
        return {
            valid: false,
            reasonCode: "BEFORE_OPENING",
            message: `Start time ${startLocal.toISO()} is before opening (${OPENING_HOUR}:00 ${STUDIO_TIMEZONE})`,
            computedStartLocal: startLocal.toISO() ?? undefined
        };
    }

    if (endLocal.toMillis() > closingCeilingLocal.toMillis()) {
        return {
            valid: false,
            reasonCode: "CLOSING_CEILING_EXCEEDED",
            message: `Booking would end at ${endLocal.toISO()}, which is after the ${CLOSING_HOUR}:00 closing ceiling (${closingCeilingLocal.toISO()}) in ${STUDIO_TIMEZONE}`,
            computedStartLocal: startLocal.toISO() ?? undefined,
            computedEndLocal: endLocal.toISO() ?? undefined,
            computedEndUtc: endLocal.toUTC().toISO() ?? undefined,
            closingCeilingLocal: closingCeilingLocal.toISO() ?? undefined
        };
    }

    return {
        valid: true,
        computedStartLocal: startLocal.toISO() ?? undefined,
        computedEndLocal: endLocal.toISO() ?? undefined,
        computedEndUtc: endLocal.toUTC().toISO() ?? undefined,
        closingCeilingLocal: closingCeilingLocal.toISO() ?? undefined
    };
}

export interface BookingRequestPayload {
    serviceId: string;
    startTime: Date | string;
}

/**
 * Orchestrator: resolves the requested service against the live catalogue,
 * then applies validateBookingWindow using the catalogue's authoritative
 * duration_minutes (never a client-supplied duration).
 */
export async function validateBookingRequest(
    pool: Pool,
    payload: BookingRequestPayload
): Promise<BookingValidationResult> {
    const { rows } = await pool.query<{ duration_minutes: number; active: boolean }>(
        `SELECT duration_minutes, active FROM service_catalogue WHERE service_id = $1`,
        [payload.serviceId]
    );

    const service = rows[0];
    if (!service) {
        return {
            valid: false,
            reasonCode: "SERVICE_NOT_FOUND",
            message: `No service_catalogue entry for service_id=${payload.serviceId}`
        };
    }

    if (!service.active) {
        return {
            valid: false,
            reasonCode: "SERVICE_INACTIVE",
            message: `service_id=${payload.serviceId} is not currently active`
        };
    }

    return validateBookingWindow(payload.startTime, service.duration_minutes);
}
