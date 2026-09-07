// G5-E — weekly availability: versioning, Owner confirmation, invalidation.
//
// BP04 submission is not confirmation
// BP05 editing a confirmed week invalidates that confirmation
// BP06 only the current confirmed version projects as approved supply
// BP07 apply-to-all normalizes to the same canonical week
// BP08 region coverage is governed authority
// BP13 concurrency

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { approvedSupply } from "../../src/provider/supply";
import type { PartnerHost } from "../../src/host/partnerHost";
import {
    activate,
    call,
    enrol,
    futureMonday,
    getProviderPool,
    ownerSession,
    resetProvider,
    startPartnerOrThrow,
    validProfile,
    week,
    type DaySpec
} from "./providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G5-E / availability — submission, confirmation and the space between them", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };
    let token: string;
    let providerId: string;
    let weekStartDate: string;

    /** A partner with an APPROVED card, so only the schedule is in question. */
    async function approvedProvider(): Promise<void> {
        const enrolled = await enrol(host.origin);
        token = enrolled.token;
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        providerId = profile.body["providerId"] as string;
        const card = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: card.body["cardId"] }
        });
    }

    async function submit(days: Array<Record<string, unknown>>, key?: string) {
        return call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: { weekStartDate, days, ...(key ? { idempotencyKey: key } : {}) }
        });
    }

    async function confirm(availabilityVersionId: unknown, key?: string) {
        return call(host.origin, "POST", "/api/operations/availability/confirm", {
            token: owner.token,
            body: { availabilityVersionId, ...(key ? { idempotencyKey: key } : {}) }
        });
    }

    async function supply() {
        return withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate })
        );
    }

    async function versionStates(): Promise<Array<{ version: number; state: string }>> {
        const { rows } = await pool.query<{ version: number; state: string }>(
            `SELECT version, state FROM core_provider_availability_version
              WHERE provider_id = $1 ORDER BY version`,
            [providerId]
        );
        return rows;
    }

    async function activeWindows(): Promise<number> {
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_capacity_window WHERE provider_id = $1 AND active = TRUE`,
            [providerId]
        );
        return Number(rows[0]!.n);
    }

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
        weekStartDate = futureMonday();
        await approvedProvider();
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("BP04 — a submitted week is not approved supply until an Owner confirms it", async () => {
        const submitted = await submit(week());

        expect(submitted.status).toBe(201);
        expect(submitted.body["state"]).toBe("SUBMITTED");
        expect(submitted.body["version"]).toBe(1);
        expect(await supply()).toEqual([]);
        expect(await activeWindows()).toBe(0);

        const confirmed = await confirm(submitted.body["availabilityVersionId"]);
        expect(confirmed.status).toBe(201);
        expect(confirmed.body["state"]).toBe("CONFIRMED");
        expect(confirmed.body["confirmedByIdentityId"]).toBe(owner.identityId);
        expect(confirmed.body["capacityWindows"]).toBe(5);

        const projected = await supply();
        expect(projected).toHaveLength(1);
        expect(projected[0]!.providerId).toBe(providerId);
        expect(projected[0]!.days.map((day) => day.isoDay)).toEqual([1, 2, 3, 4, 5]);
        expect(await activeWindows()).toBe(5);
    });

    it("normalizes the week server-side and stores a Monday", async () => {
        const submitted = await submit(week());
        const { rows } = await pool.query<{ week_start_date: Date; content_digest: string }>(
            `SELECT week_start_date, content_digest FROM core_provider_availability_version
              WHERE availability_version_id = $1`,
            [submitted.body["availabilityVersionId"]]
        );
        const stored = DateTime.fromJSDate(rows[0]!.week_start_date, { zone: "utc" });
        expect(stored.weekday).toBe(1);
        expect(rows[0]!.content_digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a week that does not start on a Monday", async () => {
        const tuesday = DateTime.fromISO(weekStartDate).plus({ days: 1 }).toFormat("yyyy-MM-dd");
        const response = await call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: { weekStartDate: tuesday, days: week() }
        });
        expect(response.status).toBe(422);
        expect(response.body["error"]).toBe("WEEK_START_INVALID");
    });

    it("BP08 — governed regions persist and an invented one is refused", async () => {
        const covered = await submit(
            week([{ isoDay: 1, available: true, regions: ["Seminyak", "Uluwatu"] }])
        );
        expect(covered.status).toBe(201);
        const { rows } = await pool.query<{ regions: string[] }>(
            `SELECT regions FROM core_provider_availability_day
              WHERE availability_version_id = $1 AND iso_day = 1`,
            [covered.body["availabilityVersionId"]]
        );
        expect(rows[0]!.regions).toEqual(["Seminyak", "Uluwatu"]);

        const invented = await submit(
            week([{ isoDay: 1, available: true, regions: ["Jakarta"] }]),
            "av-region-0001"
        );
        expect(invented.status).toBe(422);
        expect(invented.body["error"]).toBe("REGION_UNSUPPORTED");
    });

    it("refuses hours outside the governed operating window and an inverted day", async () => {
        const early = await submit(
            week([{ isoDay: 1, available: true, startTime: "06:00", endTime: "12:00" }]),
            "av-hours-0001"
        );
        expect(early.body["error"]).toBe("DAY_OUTSIDE_OPERATING_HOURS");

        const late = await submit(
            week([{ isoDay: 1, available: true, startTime: "20:00", endTime: "23:30" }]),
            "av-hours-0002"
        );
        expect(late.body["error"]).toBe("DAY_OUTSIDE_OPERATING_HOURS");

        const inverted = await call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: {
                weekStartDate,
                days: week([{ isoDay: 1, available: true, startTime: "17:00", endTime: "09:00" }])
            }
        });
        expect(inverted.body["error"]).toBe("DAY_TIME_ORDER_INVALID");
    });

    it("BP07 — apply-to-all and per-day entry produce the same canonical week", async () => {
        const everyDay: DaySpec[] = [1, 2, 3, 4, 5, 6, 7].map((isoDay) => ({
            isoDay,
            available: true,
            startTime: "09:00",
            endTime: "17:00",
            regions: ["Seminyak", "Canggu"]
        }));
        const applied = await submit(week(everyDay), "av-apply-0001");
        const appliedDigest = applied.body["contentDigest"];

        // The same week typed by hand, days out of order, regions reversed.
        const manual = [...everyDay]
            .reverse()
            .map((day) => ({ ...day, regions: ["Canggu", "Seminyak"] }));
        const typed = await call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: { weekStartDate, days: week(manual) }
        });

        // Identical content is not an edit: the same version is returned, and
        // the digest proves the two entry paths are the same schedule.
        expect(typed.body["contentDigest"]).toBe(appliedDigest);
        expect(typed.body["availabilityVersionId"]).toBe(applied.body["availabilityVersionId"]);
        expect((await versionStates()).length).toBe(1);
    });

    it("BP05 — editing a confirmed week invalidates that confirmation and its capacity", async () => {
        const first = await submit(week());
        await confirm(first.body["availabilityVersionId"]);
        expect(await activeWindows()).toBe(5);
        expect(await supply()).toHaveLength(1);

        // A material edit: Saturday added.
        const edited = await submit(week([{ isoDay: 6, available: true }]));
        expect(edited.status).toBe(201);
        expect(edited.body["version"]).toBe(2);
        expect(edited.body["state"]).toBe("SUBMITTED");
        expect(edited.body["invalidatedConfirmation"]).toBe(true);
        expect(edited.body["supersededVersionIds"]).toEqual([first.body["availabilityVersionId"]]);

        expect(await versionStates()).toEqual([
            { version: 1, state: "SUPERSEDED" },
            { version: 2, state: "SUBMITTED" }
        ]);
        // The confirmation is gone, and so is the capacity it granted.
        expect(await activeWindows()).toBe(0);
        expect(await supply()).toEqual([]);

        const evidence = await pool.query<{ reason_code: string; detail: Record<string, unknown> }>(
            `SELECT reason_code, detail FROM core_runtime_evidence
              WHERE kind = 'AVAILABILITY_INVALIDATED'`
        );
        expect(evidence.rows).toHaveLength(1);
        expect(evidence.rows[0]!.detail["reason"]).toBe("PROVIDER_EDITED_CONFIRMED_SCHEDULE");
    });

    it("BP05 — the superseded version cannot be confirmed after the edit", async () => {
        const first = await submit(week());
        await confirm(first.body["availabilityVersionId"]);
        await submit(week([{ isoDay: 6, available: true }]));

        const stale = await confirm(first.body["availabilityVersionId"], "ac-stale-0001");
        expect(stale.status).toBe(409);
        expect(stale.body["error"]).toBe("AVAILABILITY_SUPERSEDED");
        expect(await supply()).toEqual([]);
    });

    it("BP06 — only the current confirmed version projects as approved supply", async () => {
        const first = await submit(week());
        await confirm(first.body["availabilityVersionId"]);
        const second = await submit(week([{ isoDay: 6, available: true }]));
        await confirm(second.body["availabilityVersionId"]);
        const third = await submit(
            week([
                { isoDay: 6, available: true },
                { isoDay: 7, available: true }
            ])
        );
        await confirm(third.body["availabilityVersionId"]);

        expect(await versionStates()).toEqual([
            { version: 1, state: "SUPERSEDED" },
            { version: 2, state: "SUPERSEDED" },
            { version: 3, state: "CONFIRMED" }
        ]);

        const projected = await supply();
        expect(projected).toHaveLength(1);
        expect(projected[0]!.availabilityVersion).toBe(3);
        expect(projected[0]!.days.map((day) => day.isoDay)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        // Only the current version's windows are live.
        expect(await activeWindows()).toBe(7);
    });

    it("re-confirming identical content does not churn versions", async () => {
        const first = await submit(week());
        await confirm(first.body["availabilityVersionId"]);
        const resubmitted = await submit(week());

        expect(resubmitted.body["availabilityVersionId"]).toBe(first.body["availabilityVersionId"]);
        expect(resubmitted.body["state"]).toBe("CONFIRMED");
        expect(resubmitted.body["invalidatedConfirmation"]).toBe(false);
        expect(await supply()).toHaveLength(1);
        expect(await activeWindows()).toBe(5);
    });

    it("BP12 — replaying a submission or a confirmation changes nothing", async () => {
        const body = { weekStartDate, days: week(), idempotencyKey: "av-replay-0001" };
        const first = await call(host.origin, "POST", "/api/partner/availability", { token, body });
        const second = await call(host.origin, "POST", "/api/partner/availability", { token, body });
        expect(second.status).toBe(200);
        expect(second.body["replay"]).toBe(true);
        expect(second.body["availabilityVersionId"]).toBe(first.body["availabilityVersionId"]);
        expect((await versionStates()).length).toBe(1);

        const confirmFirst = await confirm(first.body["availabilityVersionId"], "ac-replay-0001");
        const confirmAgain = await confirm(first.body["availabilityVersionId"], "ac-replay-0001");
        expect(confirmFirst.status).toBe(201);
        expect(confirmAgain.status).toBe(200);
        expect(confirmAgain.body["replay"]).toBe(true);
        // One confirmation, one set of windows.
        expect(await activeWindows()).toBe(5);
    });

    it("BP13 — concurrent edits to the same week resolve to one ordered outcome", async () => {
        const first = await submit(week());
        await confirm(first.body["availabilityVersionId"]);

        // Six materially different edits, fired at once.
        const responses = await Promise.all(
            [1, 2, 3, 4, 5, 6].map((n) =>
                call(host.origin, "POST", "/api/partner/availability", {
                    token,
                    body: {
                        weekStartDate,
                        days: week([
                            { isoDay: 1, available: true, startTime: `${9 + n}:00`.padStart(5, "0"), endTime: "17:00" }
                        ])
                    }
                })
            )
        );

        for (const response of responses) {
            expect([200, 201]).toContain(response.status);
        }
        const states = await versionStates();
        // Exactly one open version, every earlier one superseded, no gaps.
        expect(states.filter((s) => s.state === "SUBMITTED")).toHaveLength(1);
        expect(states.filter((s) => s.state === "CONFIRMED")).toHaveLength(0);
        expect(states.map((s) => s.version)).toEqual(
            Array.from({ length: states.length }, (_, i) => i + 1)
        );
        // The confirmation, and its capacity, went with the first edit.
        expect(await activeWindows()).toBe(0);
        expect(await supply()).toEqual([]);
    });

    it("BP13 — an Owner confirming while the partner edits never confirms unreviewed content", async () => {
        const first = await submit(week());
        const versionId = first.body["availabilityVersionId"];

        const [edit, confirmation] = await Promise.all([
            call(host.origin, "POST", "/api/partner/availability", {
                token,
                body: { weekStartDate, days: week([{ isoDay: 7, available: true }]) }
            }),
            confirm(versionId, "ac-race-0001")
        ]);

        expect(edit.status).toBe(201);
        // Either the Owner won the race and confirmed exactly what they read, or
        // the edit landed first and the confirmation was refused. What cannot
        // happen is a confirmation landing on content nobody reviewed.
        if (confirmation.status === 201) {
            expect(confirmation.body["availabilityVersionId"]).toBe(versionId);
        } else {
            expect(confirmation.status).toBe(409);
            expect(confirmation.body["error"]).toBe("AVAILABILITY_SUPERSEDED");
        }
        const confirmed = (await versionStates()).filter((s) => s.state === "CONFIRMED");
        expect(confirmed.length).toBeLessThanOrEqual(1);
    });

    it("a partner's own week and another partner's week never mix", async () => {
        const mine = await submit(week());
        await confirm(mine.body["availabilityVersionId"]);

        const otherEnrol = await enrol(host.origin, "Ketut");
        await call(host.origin, "POST", "/api/partner/profile", {
            token: otherEnrol.token,
            body: validProfile({ contactHandle: "+628139998888", displayName: "Ketut" })
        });
        const otherCard = await call(host.origin, "POST", "/api/partner/card", {
            token: otherEnrol.token,
            body: {}
        });
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: otherCard.body["cardId"] }
        });
        const otherWeek = await call(host.origin, "POST", "/api/partner/availability", {
            token: otherEnrol.token,
            body: { weekStartDate, days: week([{ isoDay: 3, available: true, regions: ["Canggu"] }]) }
        });
        await call(host.origin, "POST", "/api/operations/availability/confirm", {
            token: owner.token,
            body: { availabilityVersionId: otherWeek.body["availabilityVersionId"] }
        });

        const projected = await supply();
        expect(projected).toHaveLength(2);
        const mineEntry = projected.find((e) => e.providerId === providerId)!;
        expect(mineEntry.coverageRegions).toEqual(["Seminyak"]);
        const theirs = projected.find((e) => e.providerId !== providerId)!;
        expect(theirs.coverageRegions.sort()).toEqual(["Canggu", "Seminyak"]);
    });
});
