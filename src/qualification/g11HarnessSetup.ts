// SCP-RUNTIME-Q01B-QCP2A-R02 — G11 harness error containment.
//
// Qualification proof harness only. Loaded via `--setupFiles` by the IRF bridge
// when it runs the pinned battery. It is NOT imported by product code, NOT part
// of the candidate, and it does NOT modify the pinned battery, which remains
// bit-for-bit d0a3f718…1de51fbd at 18,091 bytes.
//
// WHY THIS FILE EXISTS. G11-T11 runs
//     SELECT pg_terminate_backend(pid) FROM pg_stat_activity
//      WHERE datname = current_database() AND pid <> pg_backend_pid()
// — every other backend on the database. The battery's own pool holds up to ten
// connections (src/db/pool.ts, max: 10), so "every other backend" includes about
// nine of its own idle pooled clients. Each terminated idle client emits an
// 'error' on the pool. `src/db/pool.ts` installs no pool error handler and is
// shared product code that R02 §5 forbids touching, so those errors escaped as
// uncaught exceptions: six of them, Vitest exit 1, and a deep-serialized pg
// Client that carried the password (QCP2A-D03).
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO. It gives those pools an error
// listener, which is exactly what R02 §11 requires. It does not weaken T11:
// the same backends are still terminated, and the battery still has to prove it
// reconnects (T11 asserts recovered === true). It does not touch assertions, so
// a genuine failure still fails. And it is not a blanket 57P01 suppressor —
// R02 §9 forbids that. A connection loss is only "expected" once the battery has
// actually entered T11; the identical error before that point is classified
// UNEXPECTED and rethrown so the run fails loudly.
//
// The containment also removes the D03 leak at its root: a handled error is
// never handed to Vitest's reporter, so the secret-bearing object graph is never
// serialized in the first place. Redaction remains as defence in depth.

import { afterAll, beforeEach } from "vitest";
import { Client, Pool } from "pg";
import { describeError } from "./secretSafe";

/** SQLSTATEs produced by deliberate backend termination / connection teardown. */
const CONNECTION_LOSS_SQLSTATES = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006"]);
const CONNECTION_LOSS_PATTERN =
    /terminating connection due to administrator command|connection terminated|server closed the connection|ECONNRESET|EPIPE|Connection terminated unexpectedly/i;

function isConnectionLoss(e: unknown): boolean {
    const err = e as { code?: string; message?: string } | null;
    if (!err) return false;
    if (err.code && CONNECTION_LOSS_SQLSTATES.has(err.code)) return true;
    return typeof err.message === "string" && CONNECTION_LOSS_PATTERN.test(err.message);
}

interface HarnessEvent {
    classification: "EXPECTED_CONNECTION_LOSS" | "UNEXPECTED_ERROR";
    testContext: string;
    t11Reached: boolean;
    error: Record<string, unknown>;
}

const events: HarnessEvent[] = [];
let currentTest = "<outside any test>";
/**
 * The governed expected window. Flipped when the battery enters T11, the only
 * test that deliberately terminates backends. Before this, a 57P01 is a real
 * finding about the topology and must not be swallowed.
 */
let t11Reached = false;

/** One structured line per event, emitted immediately so evidence survives a crash. */
function emit(event: HarnessEvent): void {
    events.push(event);
    // eslint-disable-next-line no-console
    console.log("G11_HARNESS_EVENT " + JSON.stringify(event));
}

function handle(source: string, e: unknown): void {
    const expected = isConnectionLoss(e) && t11Reached;
    const event: HarnessEvent = {
        classification: expected ? "EXPECTED_CONNECTION_LOSS" : "UNEXPECTED_ERROR",
        testContext: currentTest,
        t11Reached,
        // Allowlisted. The raw error is never serialized — that is what leaked.
        error: describeError(e, { source })
    };
    emit(event);

    if (!expected) {
        // R02 §9 / §11: unexpected failures must still fail the run. Rethrowing
        // outside the emitter's call stack restores exactly the behaviour that
        // would have occurred without this handler.
        process.nextTick(() => {
            throw e;
        });
    }
}

const ATTACHED = Symbol.for("qcp2a.r02.errorHandlerAttached");

function ensureHandler(target: unknown, source: string): void {
    const t = target as Record<symbol, unknown> & { on?: (ev: string, cb: (e: unknown) => void) => void };
    if (!t || t[ATTACHED] || typeof t.on !== "function") return;
    t[ATTACHED] = true;
    t.on("error", (e: unknown) => handle(source, e));
}

/**
 * Patch the prototypes rather than the constructors.
 *
 * The battery reaches pg through `createPool()` in shared product code, whose
 * import binding is resolved by Vite before we could swap a constructor.
 * Mutating the prototype sidesteps that entirely: any pool or client that is
 * actually *used* gets a handler attached at the moment of use, regardless of
 * when or how it was constructed.
 */
function patch(proto: Record<string, unknown>, methods: string[], source: string): void {
    for (const m of methods) {
        const original = proto[m];
        if (typeof original !== "function") continue;
        proto[m] = function patched(this: unknown, ...args: unknown[]): unknown {
            ensureHandler(this, source);
            return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
    }
}

patch(Pool.prototype as unknown as Record<string, unknown>, ["connect", "query"], "pg.Pool");
patch(Client.prototype as unknown as Record<string, unknown>, ["connect", "query"], "pg.Client");

beforeEach((ctx: { task?: { name?: string } }) => {
    currentTest = ctx?.task?.name ?? "<unknown test>";
    // T11 is the only test that deliberately terminates backends. From the
    // moment it starts, connection loss is an expected consequence of the
    // battery's own behaviour rather than a topology finding.
    if (/G11-T11/.test(currentTest)) t11Reached = true;
});

afterAll(() => {
    const expectedCount = events.filter((e) => e.classification === "EXPECTED_CONNECTION_LOSS").length;
    const unexpectedCount = events.filter((e) => e.classification === "UNEXPECTED_ERROR").length;
    // eslint-disable-next-line no-console
    console.log(
        "G11_HARNESS_SUMMARY " +
            JSON.stringify({
                expectedConnectionLossEvents: expectedCount,
                unexpectedErrors: unexpectedCount,
                t11Reached,
                events
            })
    );
});
