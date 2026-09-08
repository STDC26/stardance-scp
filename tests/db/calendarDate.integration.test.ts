// SCP-R42 — a calendar date is not an instant.
//
// A PostgreSQL DATE carries no timezone and no time of day. Before R42,
// `node-pg` materialised it as a JavaScript Date at *host-local* midnight, and
// the runtime then read a calendar date back off that instant. On a host with
// a positive UTC offset — including Asia/Makassar, this market's own timezone —
// the date moved back one day, which shifted the Provider week start and
// materialised capacity windows on the wrong service day.
//
// These are the direct round-trip proofs: INSERT DATE -> SELECT DATE ->
// application read -> business use, asserted to be invariant. They are written
// to be run under several host timezones (see the R42 matrix); the assertions
// themselves are absolute, so a shift in any zone fails the suite rather than
// quietly agreeing with whatever the host happens to believe.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../../src/db/pool";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** 2026-09-28 is a Monday. 2026-09-27 is the Sunday the defect produced. */
const MONDAY = "2026-09-28";

d("SCP-R42 / PostgreSQL calendar-date semantics", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = createPool();
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("a DATE literal reads back as the same calendar date, whatever the host believes", async () => {
        const { rows } = await pool.query<{ d: string; isodow: number }>(
            `SELECT DATE '${MONDAY}' AS d, EXTRACT(ISODOW FROM DATE '${MONDAY}')::int AS isodow`
        );
        // Postgres is the authority on what day this is.
        expect(rows[0]!.isodow).toBe(1);
        // And the application must agree with it, exactly.
        expect(rows[0]!.d).toBe(MONDAY);
        expect(typeof rows[0]!.d).toBe("string");
    });

    it("survives a real round trip through a DATE column", async () => {
        await pool.query(`CREATE TEMP TABLE r42_round_trip (label text primary key, d date not null)`);
        try {
            // Written as a string, the way the governed availability path writes it.
            await pool.query(`INSERT INTO r42_round_trip (label, d) VALUES ('monday', $1::date)`, [
                MONDAY
            ]);
            const { rows } = await pool.query<{ d: string; isodow: number }>(
                `SELECT d, EXTRACT(ISODOW FROM d)::int AS isodow FROM r42_round_trip WHERE label = 'monday'`
            );
            expect(rows[0]!.d).toBe(MONDAY);
            expect(rows[0]!.isodow).toBe(1);
            // The defect's signature: never the day before.
            expect(rows[0]!.d).not.toBe("2026-09-27");
        } finally {
            await pool.query(`DROP TABLE r42_round_trip`);
        }
    });

    it("holds across a year of Mondays, not just one lucky date", async () => {
        const { rows } = await pool.query<{ d: string; isodow: number }>(
            `SELECT (DATE '${MONDAY}' + (n * 7))::date AS d,
                    EXTRACT(ISODOW FROM DATE '${MONDAY}' + (n * 7))::int AS isodow
               FROM generate_series(0, 51) AS n`
        );
        expect(rows).toHaveLength(52);
        for (const row of rows) {
            // Every row is a Monday to Postgres and a Monday to the application.
            expect(row.isodow).toBe(1);
            expect(row.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            const [y, m, day] = row.d.split("-").map(Number) as [number, number, number];
            expect(new Date(Date.UTC(y, m - 1, day)).getUTCDay()).toBe(1);
        }
    });

    it("a DATE crossing a month and a year boundary does not slip a day", async () => {
        for (const boundary of ["2026-01-01", "2026-12-31", "2027-03-01", "2028-02-29"]) {
            const { rows } = await pool.query<{ d: string }>(`SELECT DATE '${boundary}' AS d`);
            expect(rows[0]!.d).toBe(boundary);
        }
    });

    it("a timestamptz is still an instant — the correction did not flatten it", async () => {
        // R42 normalises DATE only. An absolute instant must keep behaving like
        // one, or the correction would have traded one time defect for another.
        const { rows } = await pool.query<{ t: Date }>(
            `SELECT TIMESTAMPTZ '2026-09-28T04:00:00Z' AS t`
        );
        expect(rows[0]!.t).toBeInstanceOf(Date);
        expect(rows[0]!.t.toISOString()).toBe("2026-09-28T04:00:00.000Z");
    });
});
