// C2/C4/C5/C6/C7 — the Experience Lab router.
//
// This is a switchboard and nothing else. It decides which tenant and perspective
// a URL refers to, acquires the matching projection provider, and hands off. It
// resolves no price, no availability, no eligibility and no state, and it has no
// database access of its own — there is no Shell→DB path here, only Shell→provider
// and provider→existing SCP code.
//
// Freshline is served by its own extracted handlers, so the Experience Lab shows
// the real proven surface rather than a reconstruction of it: REAL WHERE PROVEN.
// Athena has no live capability behind it, so it is Shell-rendered from a fixture
// provider that says FIXTURE on every envelope it emits.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { handleCustomerRequest } from "../host/customerHost";
import { handleOwnerRequest } from "../host/ownerHost";
import { handlePartnerRequest } from "../host/partnerHost";
import { brandProfileFor, ATHENA_PROFILE } from "../host/brandProfile";
import { renderAthenaPage } from "./athenaPage";
import {
    createFixtureProjectionProvider,
    fixtureLocales,
    FixtureNotFoundError
} from "./fixtureProvider";
import { resolveLocale } from "../localization/translate";
import { createLiveProjectionProvider } from "./liveProvider";
import { inspect, renderInspector, type InspectionReport } from "./inspector";
import { labsRuntime } from "./labsRuntime";
import { resolveMount, stripMountPrefix } from "./mount";
import type { Actor, DemandPayload, ProjectionEnvelope, ProjectionProvider } from "./contract";

export const LABS_INSPECTOR_PATH = "/labs/_inspect";
export const ATHENA_DEMAND_PATH = "/labs/athena";

const ANONYMOUS_VISITOR: Actor = { actorId: null, role: "VISITOR" };
const INTERNAL_REVIEWER: Actor = { actorId: null, role: "UAT_REVIEWER" };

function sendHtml(response: ServerResponse, status: number, html: string): void {
    const body = Buffer.from(html, "utf8");
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.byteLength,
        "cache-control": "no-store",
        // The Lab is UAT instrumentation and must never be indexed.
        "x-robots-tag": "noindex, nofollow"
    });
    response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.byteLength,
        "cache-control": "no-store"
    });
    response.end(body);
}

/**
 * Runtime unavailability is reported, never papered over. If the governed runtime
 * refuses, the Lab says so with the refusal code — a demand surface that renders
 * a catalogue it cannot persist against would be worse than one that is down.
 */
function sendRuntimeRefusal(response: ServerResponse, code: string, message: string): void {
    sendJson(response, 503, {
        error: "EXPERIENCE_LAB_RUNTIME_UNAVAILABLE",
        code,
        message,
        note: "There is no fallback source for LIVE tenants. This surface refuses rather than simulating."
    });
}

/** Fixture provider is stateless; one instance per module is enough. */
const fixtureProvider = createFixtureProjectionProvider();

async function providerForTenant(
    tenant: string
): Promise<
    | { ok: true; provider: ProjectionProvider }
    | { ok: false; code: string; message: string }
> {
    if (tenant === "athena-uat") {
        return { ok: true, provider: fixtureProvider };
    }

    const outcome = await labsRuntime();
    if (!outcome.ok) {
        return { ok: false, code: outcome.code, message: outcome.message };
    }
    return {
        ok: true,
        provider: createLiveProjectionProvider({
            pool: outcome.value.pool,
            runtime: outcome.value.runtime
        })
    };
}

/**
 * The inspector gathers every primary projection it can reach. A tenant whose
 * runtime is unavailable is reported as unreachable rather than omitted, because a
 * silently missing card reads as "nothing to see".
 */
async function handleInspector(response: ServerResponse, correlationId: string): Promise<void> {
    const reports: InspectionReport[] = [];
    const unreachable: Array<{ tenant: string; code: string; message: string }> = [];

    for (const tenant of ["freshline-uat", "athena-uat"]) {
        const selected = await providerForTenant(tenant);
        if (!selected.ok) {
            unreachable.push({ tenant, code: selected.code, message: selected.message });
            continue;
        }
        const actor = tenant === "athena-uat" ? ANONYMOUS_VISITOR : ANONYMOUS_VISITOR;
        try {
            const demand = await selected.provider.demand({ tenant, actor, correlationId });
            reports.push(inspect(demand));
            const operate = await selected.provider.operate({
                tenant,
                actor: INTERNAL_REVIEWER,
                correlationId
            });
            reports.push(inspect(operate));
        } catch (error) {
            unreachable.push({
                tenant,
                code: error instanceof FixtureNotFoundError ? "FIXTURE_NOT_FOUND" : "PROJECTION_FAILED",
                message: error instanceof Error ? error.message : "projection failed"
            });
        }
    }

    let html = renderInspector(reports);
    if (unreachable.length > 0) {
        const notes = unreachable
            .map((u) => `<li><strong>${u.tenant}</strong> — ${u.code}: ${u.message}</li>`)
            .join("");
        html = html.replace("</body>", `<h1>unreachable</h1><ul>${notes}</ul></body>`);
    }
    sendHtml(response, 200, html);
}

async function handleAthena(
    pathname: string,
    params: URLSearchParams,
    response: ServerResponse,
    correlationId: string
): Promise<void> {
    const tenant = "athena-uat";
    const perspective = pathname.startsWith("/labs/athena/operate") ? "OPERATE" : "DEMAND";

    try {
        if (perspective === "OPERATE") {
            const envelope = await fixtureProvider.operate({
                tenant,
                actor: INTERNAL_REVIEWER,
                correlationId
            });
            // Athena's operate view is instrumentation-grade in this gate: the
            // inspector rendering is the honest surface for a fixture queue.
            sendHtml(response, 200, renderInspector([inspect(envelope)]));
            return;
        }

        // UAT-R1: the locale and the bounded interaction state both ride in the
        // query string, so the projection is fetched in the requested language and
        // the renderer derives the journey from the same URL.
        const locales = fixtureLocales(tenant);
        const locale = resolveLocale(params.get("lang"), locales);
        const envelope: ProjectionEnvelope<DemandPayload> = await fixtureProvider.demand({
            tenant,
            actor: ANONYMOUS_VISITOR,
            correlationId,
            locale
        });

        sendHtml(
            response,
            200,
            renderAthenaPage({
                envelope,
                profile: brandProfileFor(tenant) ?? ATHENA_PROFILE,
                inspectorPath: LABS_INSPECTOR_PATH,
                basePath: ATHENA_DEMAND_PATH,
                params,
                locales
            })
        );
    } catch (error) {
        if (error instanceof FixtureNotFoundError) {
            sendJson(response, 404, { error: "FIXTURE_NOT_FOUND", message: error.message });
            return;
        }
        throw error;
    }
}

/**
 * Routes one Experience Lab request.
 *
 * Returns `true` when it handled the request, `false` when the path is not a Lab
 * route, so the caller keeps ownership of `/labs/health` and 404s.
 */
export async function routeLabsRequest(
    request: IncomingMessage,
    response: ServerResponse
): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const correlationId = randomUUID();

    if (pathname === LABS_INSPECTOR_PATH) {
        await handleInspector(response, correlationId);
        return true;
    }

    const mount = resolveMount(pathname);
    if (mount === undefined) {
        return false;
    }

    if (mount.handler === "SHELL") {
        await handleAthena(pathname, url.searchParams, response, correlationId);
        return true;
    }

    // Freshline: delegate to the very handlers its own hosts bind.
    const outcome = await labsRuntime();
    if (!outcome.ok) {
        sendRuntimeRefusal(response, outcome.code, outcome.message);
        return true;
    }

    const { pool, runtime } = outcome.value;
    // Transport translation only: the handler sees the path space it owns.
    request.url = stripMountPrefix(request.url ?? "/", mount.prefix);

    switch (mount.handler) {
        case "CUSTOMER":
            await handleCustomerRequest(pool, runtime, request, response);
            return true;
        case "OWNER":
            await handleOwnerRequest(pool, runtime, request, response);
            return true;
        case "PARTNER":
            await handlePartnerRequest(pool, runtime, request, response);
            return true;
        default:
            return false;
    }
}
