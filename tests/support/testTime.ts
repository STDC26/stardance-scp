// SCP-R36 — deterministic test time.
//
// Test truth must not depend on when, or on which host, the suite runs.
//
// Two different things used to leak into fixtures, and only one of them was
// ever legitimate:
//
//   accidental — the Bali-local HOUR and WEEKDAY of a fixture instant drifted
//                with the execution clock, because fixtures were built as
//                `Date.now() + N`. Nothing about a scenario intends that. A
//                proof that runs at 22:00 was asking a different question from
//                the same proof at 10:00.
//
//   intentional — the DISTANCE from now. The governed booking window is
//                 relative (min lead 60 minutes, max advance 60 days), and the
//                 Core fixtures seed capacity as `now() ± interval`. A scenario
//                 that must be "bookable" is genuinely defined relative to the
//                 present, and a hard-coded literal date would silently rot
//                 past the 60-day ceiling and turn every one of these proofs
//                 red on a future Tuesday.
//
// So the anchor here pins what should never have floated — weekday, hour, and
// market timezone — and keeps only the relative distance that the business
// rules actually define. Everything is computed in the market timezone
// explicitly, so the host timezone is not an input.
//
// Where a rule permits a literal calendar date (Provider availability has no
// max-advance ceiling), tests state one outright — see the R42 suites. This
// module exists for the paths where a literal is not available.

import { DateTime } from "luxon";

/** The governed market timezone. Stated, never inherited from the host. */
export const MARKET_ZONE = "Asia/Makassar";

/**
 * ISO weekday every anchored fixture is pinned to. Monday, because provider
 * availability weeks start on Monday and because pinning it means a proof
 * cannot quietly become a weekend proof depending on the day it runs.
 */
export const ANCHOR_ISO_DAY = 1;

/** Market-local hour anchored fixtures open at. Inside operating hours (09:00-23:00). */
export const ANCHOR_HOUR = 9;

/**
 * Two horizons, deliberately different.
 *
 * Relative offsets (`anchoredHoursAhead`) measure from one week out, because
 * Core fixtures seed capacity as `now() + 30 days` and the largest offset in
 * use is 200 hours — one week plus 200 hours stays comfortably inside it.
 * Weekly availability fixtures use two weeks out, which is where they already
 * sat and which keeps a confirmed week clear of the current one.
 */
export const ANCHOR_WEEKS_OFFSETS = 1;
export const ANCHOR_WEEKS_AVAILABILITY = 2;

/** The present, in the market timezone. The one place the clock is read. */
export function marketNow(): DateTime {
    return DateTime.now().setZone(MARKET_ZONE);
}

/**
 * The Monday of a week `weeksAhead` in the future, market-local.
 *
 * `startOf("week")` is Monday-based in Luxon, so the weekday is pinned by
 * construction rather than by an after-the-fact patch.
 */
export function anchorMonday(weeksAhead = ANCHOR_WEEKS_AVAILABILITY): string {
    return marketNow().plus({ weeks: weeksAhead }).startOf("week").toFormat("yyyy-MM-dd");
}

/** A market-local instant on a chosen weekday of an anchored week. */
export function anchoredSlot(
    monday: string,
    isoDay: number = ANCHOR_ISO_DAY,
    hour: number = 11
): { date: string; time: string; instant: DateTime } {
    const local = DateTime.fromISO(monday, { zone: MARKET_ZONE })
        .plus({ days: isoDay - 1 })
        .set({ hour, minute: 0, second: 0, millisecond: 0 });
    return { date: local.toFormat("yyyy-MM-dd"), time: local.toFormat("HH:mm"), instant: local };
}

/**
 * The base instant relative offsets are measured from: the anchored Monday at
 * the anchored hour, at least a week out.
 *
 * Being a fixed weekday at a fixed market-local hour is the whole point — an
 * offset applied to it lands on a determined weekday and hour every run.
 */
export function anchorInstant(weeksAhead = ANCHOR_WEEKS_OFFSETS): DateTime {
    return DateTime.fromISO(anchorMonday(weeksAhead), { zone: MARKET_ZONE }).set({
        hour: ANCHOR_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0
    });
}

/**
 * `hours` after the anchor. Replaces `Date.now() + hours`: the distance is
 * preserved, the accidental hour-of-day and weekday are not.
 */
export function anchoredHoursAhead(hours: number, weeksAhead = ANCHOR_WEEKS_OFFSETS): Date {
    return anchorInstant(weeksAhead).plus({ hours }).toJSDate();
}

/**
 * The first anchored weekday at least `daysAhead` days out, at `hour`
 * market-local.
 *
 * "At least" matters: the booking-window proofs depend on a slot being beyond
 * the 60-day ceiling (`daysAhead = 120`) or comfortably inside it. Rounding up
 * to the pinned weekday preserves that relation while fixing the weekday.
 */
export function slotAtLeastDaysAhead(
    daysAhead: number,
    hour: number,
    isoDay: number = ANCHOR_ISO_DAY
): { date: string; time: string } {
    let local = marketNow()
        .plus({ days: daysAhead })
        .set({ hour, minute: 0, second: 0, millisecond: 0 });
    while (local.weekday !== isoDay) {
        local = local.plus({ days: 1 });
    }
    return { date: local.toFormat("yyyy-MM-dd"), time: local.toFormat("HH:mm") };
}

/** The same, as an instant. */
export function instantAtLeastDaysAhead(
    daysAhead: number,
    hour: number,
    isoDay: number = ANCHOR_ISO_DAY
): Date {
    const slot = slotAtLeastDaysAhead(daysAhead, hour, isoDay);
    return DateTime.fromISO(`${slot.date}T${slot.time}`, { zone: MARKET_ZONE }).toJSDate();
}
