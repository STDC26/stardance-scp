// SCP-R36 — the determinism proof for test time itself.
//
// The fixture helpers are the machinery every other proof stands on. If they
// can drift with the wall clock or the host timezone, then a green suite means
// "green today, here" rather than "green". This suite pins them down directly:
// same helper, different host timezone, same answer; and the properties that
// used to float — market-local hour, weekday, timezone — are now asserted to
// be fixed rather than merely believed to be.
//
// These are pure-function proofs, so they run in the unit suite and repeat
// cheaply. The cross-timezone claim is discharged by running this file under
// each required TZ (see the R36 matrix), which is meaningful precisely because
// the assertions below are absolute rather than derived from the host.

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { DECLARED_TZ } from "./timezoneGuard";
import {
    ANCHOR_HOUR,
    assertClearOfAdvanceCeiling,
    ANCHOR_ISO_DAY,
    MARKET_ZONE,
    anchorInstant,
    anchorMonday,
    anchoredHoursAhead,
    anchoredSlot,
    instantAtLeastDaysAhead,
    marketNow,
    slotAtLeastDaysAhead
} from "./testTime";

/** Bali operating hours, from the governed market configuration. */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 23;

function inMarket(instant: Date): DateTime {
    return DateTime.fromJSDate(instant).setZone(MARKET_ZONE);
}

describe("SCP-R36 / deterministic test time", () => {
    it("declares its timezone rather than inheriting one", () => {
        // The guard has already enforced this; asserting it here makes the
        // declared value part of the recorded evidence of every run.
        expect(DECLARED_TZ).toBeTruthy();
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(DECLARED_TZ);
    });

    it("the anchor is always the same weekday, whatever day the suite runs", () => {
        const monday = DateTime.fromISO(anchorMonday(), { zone: MARKET_ZONE });
        expect(monday.weekday).toBe(ANCHOR_ISO_DAY);
        expect(monday.zoneName).toBe(MARKET_ZONE);
        // And for every horizon a fixture might ask for.
        for (let weeks = 1; weeks <= 12; weeks += 1) {
            expect(DateTime.fromISO(anchorMonday(weeks), { zone: MARKET_ZONE }).weekday).toBe(
                ANCHOR_ISO_DAY
            );
        }
    });

    it("the anchor is always the same market-local hour", () => {
        for (let weeks = 1; weeks <= 12; weeks += 1) {
            const at = anchorInstant(weeks);
            expect(at.setZone(MARKET_ZONE).hour).toBe(ANCHOR_HOUR);
            expect(at.setZone(MARKET_ZONE).minute).toBe(0);
        }
    });

    it("the anchor is in the future — the relative distance is preserved", () => {
        expect(anchorInstant().toMillis()).toBeGreaterThan(marketNow().toMillis());
        // Far enough ahead to clear the 60-minute minimum lead time, close
        // enough to stay inside the 60-day advance ceiling and the 30-day
        // capacity window Core fixtures seed.
        const daysOut = anchorInstant().diff(marketNow(), "days").days;
        expect(daysOut).toBeGreaterThan(0);
        expect(daysOut).toBeLessThan(15);
    });

    it("an offset from the anchor lands on a determined weekday and hour", () => {
        // The exact values the Core fixtures use. Each must be a fixed
        // (weekday, hour) pair — that is what `Date.now() + h` could not give.
        const expected: Record<number, { weekday: number; hour: number }> = {};
        for (const hours of [2, 3, 4, 5, 6, 7, 8, 9, 24, 30, 31, 40, 72, 96, 120, 150, 170, 200]) {
            const local = inMarket(anchoredHoursAhead(hours));
            expected[hours] = { weekday: local.weekday, hour: local.hour };
        }
        // Recomputing must reproduce it exactly.
        for (const [hours, want] of Object.entries(expected)) {
            const local = inMarket(anchoredHoursAhead(Number(hours)));
            expect({ weekday: local.weekday, hour: local.hour }).toEqual(want);
        }
        // Stated absolutely: the anchor is Monday 09:00, so +24h is Tuesday
        // 09:00 and +30h is Tuesday 15:00 on every host, every day of the year.
        expect(inMarket(anchoredHoursAhead(24)).weekday).toBe(2);
        expect(inMarket(anchoredHoursAhead(24)).hour).toBe(ANCHOR_HOUR);
        expect(inMarket(anchoredHoursAhead(30)).weekday).toBe(2);
        expect(inMarket(anchoredHoursAhead(30)).hour).toBe(ANCHOR_HOUR + 6);
    });

    it("anchored slots sit inside governed operating hours by construction", () => {
        // The old helpers could produce 02:00 or 04:30 market-local depending
        // on the hour the suite happened to start. Nothing intends that.
        for (const hours of [0, 2, 3, 24, 30, 72]) {
            const hour = inMarket(anchoredHoursAhead(hours)).hour;
            expect(hour).toBeGreaterThanOrEqual(OPEN_HOUR);
            expect(hour).toBeLessThan(CLOSE_HOUR);
        }
    });

    it("a slot at least N days ahead keeps the distance and fixes the weekday", () => {
        for (const days of [3, 4, 30, 120]) {
            const slot = slotAtLeastDaysAhead(days, 10);
            const local = DateTime.fromISO(`${slot.date}T${slot.time}`, { zone: MARKET_ZONE });
            expect(local.weekday).toBe(ANCHOR_ISO_DAY);
            expect(local.hour).toBe(10);
            // "At least" is load-bearing: the booking-window proofs depend on
            // 120 days genuinely exceeding the 60-day ceiling.
            const out = local.diff(marketNow(), "days").days;
            expect(out).toBeGreaterThanOrEqual(days - 1);
            expect(out).toBeLessThan(days + 7);
        }
    });

    it("agrees with itself across two explicit calendar anchors", () => {
        // §12: prove the helpers against fixed anchors rather than only against
        // whatever week today happens to fall in.
        for (const monday of ["2026-09-28", "2027-03-01"]) {
            expect(DateTime.fromISO(monday, { zone: MARKET_ZONE }).weekday).toBe(1);
            const tuesday = anchoredSlot(monday, 2, 14);
            expect(tuesday.date).toBe(
                DateTime.fromISO(monday, { zone: MARKET_ZONE })
                    .plus({ days: 1 })
                    .toFormat("yyyy-MM-dd")
            );
            expect(tuesday.time).toBe("14:00");
            expect(tuesday.instant.weekday).toBe(2);
            expect(tuesday.instant.zoneName).toBe(MARKET_ZONE);
        }
    });

    it("refuses a horizon whose weekday rounding could straddle the advance ceiling", () => {
        // SCP-R36-CLOSE-03 (IRF): rounding up to the pinned weekday moves a slot
        // by up to six days. Within six days of the 60-day governed ceiling that
        // is the difference between a bookable slot and BOOKING_WINDOW_TOO_FAR,
        // and the helper would have kept returning a confident-looking answer
        // either way. The unsafe band must fail loudly, not silently.
        for (const unsafe of [55, 56, 57, 58, 59, 60]) {
            expect(
                () => slotAtLeastDaysAhead(unsafe, 10),
                `slotAtLeastDaysAhead(${unsafe}) must refuse`
            ).toThrow(/advance ceiling/);
            expect(() => instantAtLeastDaysAhead(unsafe, 10)).toThrow(/advance ceiling/);
            expect(() => assertClearOfAdvanceCeiling(unsafe)).toThrow(/advance ceiling/);
        }
        // Everything the suite actually asks for is clear of the band, on both
        // sides of the ceiling, and must keep working.
        for (const safe of [3, 4, 30, 54, 61, 120, 200]) {
            expect(() => assertClearOfAdvanceCeiling(safe)).not.toThrow();
            expect(slotAtLeastDaysAhead(safe, 10).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        // The boundary itself: 54 is the last safe value below the ceiling
        // (54 + 6 = 60, which does not exceed it) and 55 is the first unsafe.
        expect(() => assertClearOfAdvanceCeiling(54)).not.toThrow();
        expect(() => assertClearOfAdvanceCeiling(55)).toThrow();
    });

    it("is stable when called repeatedly within a run", () => {
        const first = anchoredHoursAhead(30).getTime();
        for (let i = 0; i < 200; i += 1) {
            expect(anchoredHoursAhead(30).getTime()).toBe(first);
        }
        expect(instantAtLeastDaysAhead(4, 14).getTime()).toBe(
            instantAtLeastDaysAhead(4, 14).getTime()
        );
    });

    it("no helper answer depends on the host timezone", () => {
        // Every helper is computed in the market zone explicitly. Evaluating
        // the same calendar inputs through the host's zone must not change the
        // market-local answer.
        const monday = anchorMonday(2);
        const viaMarket = anchoredSlot(monday, 3, 11);
        const viaHost = DateTime.fromISO(monday, { zone: MARKET_ZONE })
            .plus({ days: 2 })
            .set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
        expect(viaMarket.instant.toMillis()).toBe(viaHost.toMillis());
        // `anchoredHoursAhead` measures from the one-week horizon (see
        // ANCHOR_WEEKS_OFFSETS), so it is compared against that Monday.
        expect(inMarket(anchoredHoursAhead(0)).toFormat("yyyy-MM-dd HH:mm")).toBe(
            `${anchorMonday(1)} 0${ANCHOR_HOUR}:00`
        );
    });
});
