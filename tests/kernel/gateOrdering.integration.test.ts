// SCP-R36-CLOSE-03 — the lead-time gate is reached before any operating-hours
// or calendar rule.
//
// IRF found that demand ingress checks operating hours BEFORE the booking
// window, so a fixture built as "now + 10 minutes" silently became an
// operating-hours proof whenever it ran near 23:00 WITA. The kernel orders
// those two gates the other way round (evaluation.ts:469 before :509), which is
// why the equivalent kernel fixture never flipped.
//
// That ordering is now load-bearing for the determinism of the kernel
// lead-time proof, so it is asserted rather than assumed. If someone later
// reorders the gates, this fails here — where the reason is written down —
// instead of surfacing as an intermittent failure in an unrelated suite.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import { getKernelPool, resetKernel, seedMobileWorld } from "./kernelTestDb";
import { anchorMonday } from "../support/testTime";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;
const ZONE = "Asia/Makassar";

d("SCP-R36-CLOSE-03 / kernel gate ordering", () => {
    let pool: Pool;
    beforeEach(async () => { pool = getKernelPool(); await resetKernel(pool); });
    afterAll(async () => { await pool?.end(); });

    it("the lead-time refusal is reached before any operating-hours or calendar rule", async () => {
        await withTransaction(pool, async (client) => {
            const w = await seedMobileWorld(client);
            const monday = anchorMonday();
            const results: Record<string, string> = {};
            // Every boundary §6 names: close, past close, before open, open edge,
            // midnight (calendar-day rollover) and a mid-day control.
            for (const hhmm of ["12:00", "22:55", "23:30", "23:58", "00:01", "02:00", "08:55"]) {
                const at = DateTime.fromISO(`${monday}T${hhmm}`, { zone: ZONE });
                const outcome = await evaluateServiceCommerce(client, {
                    marketId: w.marketId,
                    topology: "MOBILE",
                    serviceId: w.serviceId,
                    customerIdentityId: w.customerIdentityId,
                    serviceAreaKey: w.serviceAreaKey,
                    effectiveAt: at.toJSDate(),
                    requestedStart: at.plus({ minutes: 5 }).toJSDate()
                });
                results[hhmm] = outcome.ok ? outcome.value.reasonCode ?? "SELLABLE" : `ERR:${outcome.code}`;
            }
            // One answer at every boundary — close, past close, one minute to
            // midnight, just after midnight, before open, and a mid-day control.
            expect([...new Set(Object.values(results))]).toEqual(["OUTSIDE_BOOKABLE_WINDOW"]);
        });
    }, 120_000);
});
