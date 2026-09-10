// C2 — the Experience Lab's single runtime acquisition point.
//
// The Lab runs behind a platform that invokes a handler per request, so the
// runtime cannot be a process-lifetime constant the way it is for a long-lived
// host. It is memoised per module instance instead: the first request pays for
// `startRuntime`, later requests on the same warm instance reuse it.
//
// What is deliberately NOT here: any fallback. If `startRuntime` refuses —
// unreachable database, incompatible schema, missing identity, no ACTIVE governed
// configuration — the Lab surfaces that refusal. A demand surface that renders a
// catalogue it cannot persist against is worse than one that is honestly down,
// and an in-memory substitute would make the Lab's LIVE claims meaningless.
//
// The failed promise is not cached: a database that was down at cold start may be
// up on the next request, and permanently remembering the first failure would
// turn a transient outage into an outage for the life of the instance.

import type { Pool } from "pg";

import { createPool, withTransaction } from "../db/pool";
import { startRuntime, type RuntimeContext, type StartupFailureCode } from "../runtime/bootstrap";
import { resolveDeploymentIdentity } from "../runtime/deploymentIdentity";
import { projectCatalogue } from "../customer/catalogueProjection";

export interface LabsRuntime {
    pool: Pool;
    runtime: RuntimeContext;
}

export type LabsRuntimeOutcome =
    | { ok: true; value: LabsRuntime }
    | {
          ok: false;
          code: StartupFailureCode | "DEPLOYMENT_IDENTITY_REFUSED" | "CATALOGUE_PROJECTION_REFUSED";
          message: string;
      };

let pool: Pool | undefined;
let pending: Promise<LabsRuntimeOutcome> | undefined;

function getPool(): Pool {
    // One pool per instance. `createPool` reads the PG* contract, including
    // PGSSLMODE, which is what carries TLS to a managed provider unchanged.
    pool ??= createPool();
    return pool;
}

async function start(): Promise<LabsRuntimeOutcome> {
    const activePool = getPool();

    let identity;
    try {
        identity = resolveDeploymentIdentity();
    } catch (error) {
        return {
            ok: false,
            code: "DEPLOYMENT_IDENTITY_REFUSED",
            message: error instanceof Error ? error.message : "deployment identity could not be resolved"
        };
    }

    const outcome = await startRuntime({ pool: activePool, identity });
    if (!outcome.ok) {
        return { ok: false, code: outcome.code, message: outcome.message };
    }

    // C2 — the half of host startup that is not the server.
    //
    // `startCustomerHost` does two things: project the governed catalogue, then
    // bind a server. Mounting only the request handler gets the second half, which
    // is why the first request to submit demand was refused with
    // CATALOGUE_NOT_PROJECTED: Core could not price a catalogue nobody had bound.
    //
    // So the Lab performs the same startup step by calling the same governed
    // function — not a reimplementation of it — and adopts the host's own posture
    // on failure: a surface serving a catalogue Core cannot price would accept
    // intent it must then refuse, so it does not serve at all.
    const projected = await withTransaction(activePool, async (client) =>
        projectCatalogue(client, outcome.runtime.configuration)
    );
    if (!projected.ok) {
        return {
            ok: false,
            code: "CATALOGUE_PROJECTION_REFUSED",
            message: projected.message
        };
    }

    return { ok: true, value: { pool: activePool, runtime: outcome.runtime } };
}

/** Resolves the Lab runtime, starting it at most once per warm instance. */
export async function labsRuntime(): Promise<LabsRuntimeOutcome> {
    pending ??= start();
    const outcome = await pending;
    if (!outcome.ok) {
        // Allow a later request to retry rather than inheriting a cold-start failure.
        pending = undefined;
    }
    return outcome;
}

/** Test seam: forget the memoised runtime. Does not close the pool. */
export function resetLabsRuntimeForTests(): void {
    pending = undefined;
}
