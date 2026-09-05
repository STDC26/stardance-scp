// Part C — REQ-INTK-VALID-05 stress check: T-1ms / T / T+1ms around the
// 23:00:00 Asia/Makassar closing ceiling, plus the literal 21:45 + 90min
// example from the requirement.

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
    STUDIO_TIMEZONE,
    validateBookingWindow
} from "../src/services/bookingValidator";

// Fixed reference local calendar day, well clear of any historical tz-rule
// edge cases for Asia/Makassar (which has been fixed UTC+8 since 1988).
const REF_DATE = { year: 2026, month: 6, day: 15 } as const;

function localMakassar(hour: number, minute: number, second = 0, millisecond = 0): DateTime {
    return DateTime.fromObject(
        { ...REF_DATE, hour, minute, second, millisecond },
        { zone: STUDIO_TIMEZONE }
    );
}

describe("validateBookingWindow — happy path", () => {
    it("accepts a 60-minute booking well inside the operating window", () => {
        const start = localMakassar(14, 0);
        const result = validateBookingWindow(start.toJSDate(), 60);
        expect(result.valid).toBe(true);
        expect(result.computedEndLocal).toContain("15:00:00");
    });

    it("computes the correct UTC end time for a Makassar-local booking", () => {
        // Asia/Makassar is UTC+8 year-round.
        const start = localMakassar(10, 0);
        const result = validateBookingWindow(start.toJSDate(), 30);
        expect(result.valid).toBe(true);
        // 10:30 local == 02:30 UTC
        expect(result.computedEndUtc).toContain("02:30:00");
    });
});

describe("validateBookingWindow — REQ-INTK-VALID-05 literal example", () => {
    it("rejects a 90-minute service starting at 21:45:00 (spills to 23:15)", () => {
        const start = localMakassar(21, 45, 0, 0);
        const result = validateBookingWindow(start.toJSDate(), 90);

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("CLOSING_CEILING_EXCEEDED");
        expect(result.computedEndLocal).toContain("23:15:00");
        expect(result.closingCeilingLocal).toContain("23:00:00");
    });
});

describe("validateBookingWindow — T-1ms / T / T+1ms closing-ceiling boundary", () => {
    // Anchor: a start time whose end (start + 90min) lands at EXACTLY
    // 23:00:00.000 local — this is "T", the canonical ceiling instant.
    const durationMinutes = 90;
    const closingCeiling = localMakassar(23, 0, 0, 0);
    const startAtBoundary = closingCeiling.minus({ minutes: durationMinutes }); // 21:30:00.000

    it("T-1ms: end time one millisecond before the ceiling is VALID", () => {
        const start = startAtBoundary.minus({ milliseconds: 1 }); // end = 22:59:59.999
        const result = validateBookingWindow(start.toJSDate(), durationMinutes);
        expect(result.valid).toBe(true);
        expect(result.computedEndLocal).toContain("22:59:59.999");
    });

    it("T: end time landing exactly on the ceiling (23:00:00.000) is VALID (inclusive boundary)", () => {
        const result = validateBookingWindow(startAtBoundary.toJSDate(), durationMinutes);
        expect(result.valid).toBe(true);
        expect(result.computedEndLocal).toContain("23:00:00.000");
    });

    it("T+1ms: end time one millisecond past the ceiling is INVALID", () => {
        const start = startAtBoundary.plus({ milliseconds: 1 }); // end = 23:00:00.001
        const result = validateBookingWindow(start.toJSDate(), durationMinutes);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("CLOSING_CEILING_EXCEEDED");
        expect(result.computedEndLocal).toContain("23:00:00.001");
    });
});

describe("validateBookingWindow — input validation", () => {
    it("rejects a zero-minute duration", () => {
        const result = validateBookingWindow(localMakassar(10, 0).toJSDate(), 0);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("INVALID_DURATION");
    });

    it("rejects a negative duration", () => {
        const result = validateBookingWindow(localMakassar(10, 0).toJSDate(), -30);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("INVALID_DURATION");
    });

    it("rejects a non-integer duration", () => {
        const result = validateBookingWindow(localMakassar(10, 0).toJSDate(), 45.5);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("INVALID_DURATION");
    });

    it("rejects an unparseable ISO start time string", () => {
        const result = validateBookingWindow("not-a-real-timestamp", 60);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("INVALID_START_TIME");
    });

    it("rejects a start time before the (assumed) opening hour", () => {
        const start = localMakassar(6, 0);
        const result = validateBookingWindow(start.toJSDate(), 30);
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe("BEFORE_OPENING");
    });

    it("accepts an ISO string input with an explicit non-Makassar offset and converts correctly", () => {
        // 13:30 UTC == 21:30 Asia/Makassar (UTC+8)
        const result = validateBookingWindow("2026-06-15T13:30:00.000Z", 90);
        expect(result.valid).toBe(true);
        expect(result.computedEndLocal).toContain("23:00:00.000");
    });
});
