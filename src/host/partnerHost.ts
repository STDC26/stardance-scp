// SCP-G5-E — the bounded Freshline Partner host.
//
// A transport over the G5-C runtime spine, exactly as the customer host is. It
// has no configuration loader, no tenant identity of its own, no persistence
// layer and no lifecycle opinion. It starts by calling `startRuntime`, and if
// that refuses — unreachable database, incompatible schema, missing identity, no
// active or invalid configuration — the host never listens.
//
// R21 (provider portion): the ONLY path to a serving Partner process runs
// through `startRuntime`, so a second runtime/configuration/identity/persistence
// truth path cannot be constructed without deleting this file's first statement.
//
// Two authority planes, and the host keeps them apart at the routing layer:
//
//   /api/partner/*      requires a PROVIDER session
//   /api/operations/*   requires an OWNER session
//
// A provider session reaching an operations route is refused before any body is
// read. The operations plane is a bounded governed seam — the minimum needed to
// prove Owner authority is separate — and is deliberately NOT the G5-F Owner
// product surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { startRuntime, type RuntimeContext, type StartupFailureCode } from "../runtime/bootstrap";
import { lineageOf, type IdentityInput } from "../runtime/identity";
import { recordRuntimeEvidence } from "../runtime/evidence";
import { projectCatalogue } from "../customer/catalogueProjection";
import { projectServiceAreas } from "../provider/serviceAreas";
import {
    issueSession,
    resolveSession,
    type ResolvedSession,
    type SessionRole
} from "../provider/session";
import {
    submitProviderProfile,
    currentProfile,
    governedRoleCodes,
    type ProviderCommandContext
} from "../provider/profile";
import { submitProviderCard, approveProviderCard, rejectProviderCard, publicIdOf } from "../provider/card";
import { submitAvailability, confirmAvailability } from "../provider/availability";
import { approvedSupply } from "../provider/supply";
import { storeProviderPortrait, readProviderPortrait, MAX_MEDIA_BYTES } from "../provider/media";
import { providerHttpStatus, type ProviderReason } from "../provider/reasons";
import { buildPartnerProjection, renderPartnerPage } from "./partnerPage";

export const PARTNER_SESSION_HEADER = "x-partner-session";

const MAX_JSON_BYTES = 64 * 1024;

export interface PartnerHostInput {
    pool: Pool;
    identity: IdentityInput;
    port?: number;
    /**
     * Project the governed catalogue and coverage regions into Core at startup.
     * On by default: a Partner host that accepts capabilities and regions Core
     * cannot express would take input it must then refuse.
     */
    projectOnStart?: boolean;
}

export interface PartnerHost {
    server: Server;
    runtime: RuntimeContext;
    port: number;
    origin: string;
    close(): Promise<void>;
}

export type PartnerHostOutcome =
    | { ok: true; host: PartnerHost }
    | { ok: false; code: StartupFailureCode | "PROJECTION_FAILED"; message: string };

function json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
    });
    response.end(payload);
}

function html(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
    });
    response.end(body);
}

async function readBytes(
    request: IncomingMessage,
    limit: number
): Promise<{ ok: true; bytes: Buffer } | { ok: false; message: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > limit) {
            return { ok: false, message: "request body exceeds the accepted size" };
        }
        chunks.push(buffer);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
}

async function readJson(
    request: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
    const body = await readBytes(request, MAX_JSON_BYTES);
    if (!body.ok) {
        return body;
    }
    if (body.bytes.length === 0) {
        return { ok: true, value: {} };
    }
    try {
        return { ok: true, value: JSON.parse(body.bytes.toString("utf8")) };
    } catch {
        return { ok: false, message: "request body is not valid JSON" };
    }
}

function refusal(response: ServerResponse, reason: ProviderReason, message: string, extra: Record<string, unknown> = {}): void {
    json(response, providerHttpStatus(reason), { error: reason, message, ...extra });
}

/**
 * Issues an OWNER session.
 *
 * Deliberately NOT an HTTP route. Minting Owner authority is a governed
 * operations act, not a self-service one, and building a login for it would be
 * the start of the G5-F Owner surface. It verifies the identity actually holds
 * the OWNER role in this market before issuing anything.
 */
export async function issueOwnerSession(
    pool: Pool,
    runtime: RuntimeContext,
    ownerIdentityId: string
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
    const lineage = lineageOf(runtime.identity);
    return withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ role: string }>(
            `SELECT role FROM core_identity_role
              WHERE identity_id = $1 AND market_id = $2 AND role = 'OWNER'`,
            [ownerIdentityId, lineage.marketId]
        );
        if (rows.length === 0) {
            return {
                ok: false as const,
                message: `identity ${ownerIdentityId} does not hold the OWNER role in ${lineage.marketId}`
            };
        }
        const issued = await issueSession(client, {
            identityId: ownerIdentityId,
            role: "OWNER",
            lineage
        });
        await recordRuntimeEvidence(client, {
            kind: "PROVIDER_SESSION_ISSUED",
            lineage,
            outcome: "OK",
            configurationVersion: runtime.configuration.provenance.configurationVersion,
            configurationChecksum: runtime.configuration.provenance.checksum,
            detail: { role: "OWNER", identityId: ownerIdentityId, sessionId: issued.sessionId }
        });
        return { ok: true as const, token: issued.token };
    });
}

/**
 * Issues a PROVIDER session for an EXISTING provider, under Owner authority.
 *
 * This is the governed re-access path. A returning partner cannot mint a
 * session from a contact handle alone — that handle is unverified in this gate,
 * and honouring it would let anyone impersonate an approved partner.
 */
export async function issueProviderAccessSession(
    client: PoolClient,
    runtime: RuntimeContext,
    providerId: string
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
    const lineage = lineageOf(runtime.identity);
    const { rows } = await client.query<{ identity_id: string; market_id: string }>(
        `SELECT identity_id, market_id FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );
    const provider = rows[0];
    if (!provider || provider.market_id !== lineage.marketId) {
        return { ok: false, message: "no such provider in this market" };
    }
    const issued = await issueSession(client, {
        identityId: provider.identity_id,
        providerId,
        role: "PROVIDER",
        lineage
    });
    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_SESSION_ISSUED",
        lineage,
        outcome: "OK",
        configurationVersion: runtime.configuration.provenance.configurationVersion,
        configurationChecksum: runtime.configuration.provenance.checksum,
        detail: { role: "PROVIDER", providerId, sessionId: issued.sessionId, grantedBy: "OWNER" }
    });
    return { ok: true, token: issued.token };
}

export async function startPartnerHost(input: PartnerHostInput): Promise<PartnerHostOutcome> {
    const started = await startRuntime({ pool: input.pool, identity: input.identity });
    if (!started.ok) {
        return { ok: false, code: started.code, message: started.message };
    }
    const runtime = started.runtime;
    const lineage = lineageOf(runtime.identity);

    if (input.projectOnStart !== false) {
        const projected = await withTransaction(input.pool, async (client) => {
            const catalogue = await projectCatalogue(client, runtime.configuration);
            if (!catalogue.ok) {
                return { ok: false as const, message: catalogue.message };
            }
            const areas = await projectServiceAreas(client, runtime.configuration);
            await recordRuntimeEvidence(client, {
                kind: "SERVICE_AREA_PROJECTED",
                lineage,
                outcome: "OK",
                configurationVersion: runtime.configuration.provenance.configurationVersion,
                configurationChecksum: runtime.configuration.provenance.checksum,
                detail: {
                    areas: areas.areas.length,
                    created: areas.created,
                    reactivated: areas.reactivated,
                    deactivated: areas.deactivated
                }
            });
            return { ok: true as const };
        });
        if (!projected.ok) {
            return { ok: false, code: "PROJECTION_FAILED", message: projected.message };
        }
    }

    const server = createServer((request, response) => {
        handle(input.pool, runtime, request, response).catch(() => {
            json(response, 500, { error: "INTERNAL", message: "the request could not be completed" });
        });
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port ?? 0, "127.0.0.1", () => {
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
    });

    return {
        ok: true,
        host: {
            server,
            runtime,
            port,
            origin: `http://127.0.0.1:${port}`,
            close: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                })
        }
    };
}

function sessionToken(request: IncomingMessage): string | undefined {
    const value = request.headers[PARTNER_SESSION_HEADER];
    if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
    }
    const auth = request.headers["authorization"];
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }
    return undefined;
}

/** Resolves a session and enforces the role a route plane requires. */
async function requireSession(
    client: PoolClient,
    runtime: RuntimeContext,
    request: IncomingMessage,
    required: SessionRole
): Promise<{ ok: true; session: ResolvedSession } | { ok: false; reason: ProviderReason; message: string }> {
    const resolved = await resolveSession(client, sessionToken(request), lineageOf(runtime.identity));
    if (!resolved.ok) {
        return { ok: false, reason: resolved.code, message: resolved.message };
    }
    if (resolved.session.role !== required) {
        return {
            ok: false,
            reason: required === "OWNER" ? "OWNER_AUTHORITY_REQUIRED" : "NOT_PROVIDER_OWNER_OF_RECORD",
            message: `this command requires a ${required} session`
        };
    }
    return { ok: true, session: resolved.session };
}

function contextFor(
    runtime: RuntimeContext,
    session: ResolvedSession,
    correlationId: string
): ProviderCommandContext {
    return { configuration: runtime.configuration, session, correlationId };
}

async function handle(
    pool: Pool,
    runtime: RuntimeContext,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const correlationId = randomUUID();
    const lineage = lineageOf(runtime.identity);

    if (method === "GET" && path === "/healthz") {
        json(response, 200, {
            status: "SERVING",
            surface: "PARTNER",
            configuration: runtime.describe(),
            requiredRelations: runtime.schema.present.length
        });
        return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
        const projection = buildPartnerProjection(runtime.configuration);
        html(
            response,
            200,
            renderPartnerPage({
                projection,
                locale: url.searchParams.get("lang") ?? projection.market.localeDefault
            })
        );
        return;
    }

    if (method === "GET" && path === "/api/partner/configuration") {
        json(response, 200, buildPartnerProjection(runtime.configuration));
        return;
    }

    // ---- session enrolment ------------------------------------------------
    if (path === "/api/partner/session") {
        if (method !== "POST") {
            json(response, 405, { error: "METHOD_NOT_ALLOWED", message: "use POST" });
            return;
        }
        const body = await readJson(request);
        if (!body.ok) {
            json(response, 400, { error: "MALFORMED_BODY", message: body.message });
            return;
        }
        const record = (body.value ?? {}) as Record<string, unknown>;
        const contactHandle = typeof record["contactHandle"] === "string" ? record["contactHandle"].trim() : "";
        const displayName = typeof record["displayName"] === "string" ? record["displayName"].trim() : "";
        for (const key of Object.keys(record)) {
            if (key !== "contactHandle" && key !== "displayName") {
                refusal(response, "UNDECLARED_FIELD", `${key} is not accepted here`);
                return;
            }
        }
        if (contactHandle === "" || displayName === "") {
            refusal(response, "FIELD_INVALID", "contactHandle and displayName are required");
            return;
        }

        const outcome = await withTransaction(pool, async (client) => {
            // A handle already bound to a Provider cannot mint a session. The
            // handle is unverified in this gate, so honouring it would let
            // anyone claim an approved partner's portal. Re-access is an Owner
            // act (see issueProviderAccessSession).
            const existing = await client.query<{ provider_id: string }>(
                `SELECT p.provider_id
                   FROM core_provider p
                   JOIN core_identity i ON i.identity_id = p.identity_id
                  WHERE i.market_id = $1 AND i.channel_handle = $2`,
                [lineage.marketId, contactHandle]
            );
            if (existing.rows.length > 0) {
                await recordRuntimeEvidence(client, {
                    kind: "PROVIDER_SESSION_REFUSED",
                    lineage,
                    outcome: "REFUSED",
                    reasonCode: "SESSION_INVALID",
                    configurationVersion: runtime.configuration.provenance.configurationVersion,
                    configurationChecksum: runtime.configuration.provenance.checksum,
                    detail: { correlationId, reason: "CONTACT_ALREADY_REGISTERED" }
                });
                return { ok: false as const };
            }
            await client.query(
                `INSERT INTO core_identity (market_id, display_name, channel_handle)
                 VALUES ($1, $2, $3) ON CONFLICT (market_id, channel_handle) DO NOTHING`,
                [lineage.marketId, displayName, contactHandle]
            );
            const identity = await client.query<{ identity_id: string }>(
                `SELECT identity_id FROM core_identity WHERE market_id = $1 AND channel_handle = $2`,
                [lineage.marketId, contactHandle]
            );
            const issued = await issueSession(client, {
                identityId: identity.rows[0]!.identity_id,
                role: "PROVIDER",
                lineage
            });
            await recordRuntimeEvidence(client, {
                kind: "PROVIDER_SESSION_ISSUED",
                lineage,
                outcome: "OK",
                configurationVersion: runtime.configuration.provenance.configurationVersion,
                configurationChecksum: runtime.configuration.provenance.checksum,
                detail: {
                    correlationId,
                    role: "PROVIDER",
                    sessionId: issued.sessionId,
                    applicant: true
                }
            });
            return { ok: true as const, issued };
        });

        if (!outcome.ok) {
            refusal(
                response,
                "SESSION_INVALID",
                "this contact is already registered; ask the Freshline team for an access link"
            );
            return;
        }
        json(response, 201, {
            sessionToken: outcome.issued.token,
            expiresAt: outcome.issued.expiresAt.toISOString(),
            role: "PROVIDER",
            providerId: null,
            correlationId
        });
        return;
    }

    // ---- provider plane ---------------------------------------------------
    if (path.startsWith("/api/partner/")) {
        const portraitRead = path.match(/^\/api\/partner\/portrait\/([0-9a-fA-F-]{36})$/);

        const result = await withTransaction(pool, async (client) => {
            const auth = await requireSession(client, runtime, request, "PROVIDER");
            if (!auth.ok) {
                return { kind: "REFUSED" as const, reason: auth.reason, message: auth.message };
            }
            const session = auth.session;
            const context = contextFor(runtime, session, correlationId);

            if (method === "GET" && path === "/api/partner/me") {
                return { kind: "ME" as const, session };
            }
            if (method === "GET" && portraitRead) {
                if (!session.providerId) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "MEDIA_NOT_FOUND" as ProviderReason,
                        message: "no portrait for this session"
                    };
                }
                const media = await readProviderPortrait(
                    client,
                    lineage,
                    session.providerId,
                    portraitRead[1]!
                );
                if (!media) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "MEDIA_NOT_FOUND" as ProviderReason,
                        message: "no such portrait for this provider"
                    };
                }
                return { kind: "MEDIA" as const, media };
            }
            if (method === "POST" && path === "/api/partner/portrait") {
                if (!session.providerId) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "PROFILE_NOT_SUBMITTED" as ProviderReason,
                        message: "submit a provider profile before uploading a portrait"
                    };
                }
                const body = await readBytes(request, MAX_MEDIA_BYTES + 1);
                if (!body.ok) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "MEDIA_TOO_LARGE" as ProviderReason,
                        message: body.message
                    };
                }
                const stored = await storeProviderPortrait(client, {
                    providerId: session.providerId,
                    lineage,
                    uploadedByIdentityId: session.identityId,
                    bytes: body.bytes,
                    configurationVersion: runtime.configuration.provenance.configurationVersion,
                    configurationChecksum: runtime.configuration.provenance.checksum,
                    correlationId
                });
                if (!stored.ok) {
                    return {
                        kind: "REFUSED" as const,
                        reason: stored.code as ProviderReason,
                        message: stored.message
                    };
                }
                return { kind: "MEDIA_STORED" as const, media: stored.media };
            }

            if (method !== "POST") {
                return { kind: "NOT_FOUND" as const };
            }
            const body = await readJson(request);
            if (!body.ok) {
                return { kind: "MALFORMED" as const, message: body.message };
            }

            if (path === "/api/partner/profile") {
                return { kind: "COMMAND" as const, outcome: await submitProviderProfile(client, context, body.value) };
            }
            if (path === "/api/partner/card") {
                return { kind: "COMMAND" as const, outcome: await submitProviderCard(client, context, body.value) };
            }
            if (path === "/api/partner/availability") {
                return { kind: "COMMAND" as const, outcome: await submitAvailability(client, context, body.value) };
            }
            return { kind: "NOT_FOUND" as const };
        });

        if (result.kind === "REFUSED") {
            refusal(response, result.reason, result.message, { correlationId });
            return;
        }
        if (result.kind === "MALFORMED") {
            json(response, 400, { error: "MALFORMED_BODY", message: result.message });
            return;
        }
        if (result.kind === "NOT_FOUND") {
            json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
            return;
        }
        if (result.kind === "MEDIA") {
            response.writeHead(200, {
                "content-type": result.media.contentType,
                "content-length": result.media.bytes.length,
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
            });
            response.end(result.media.bytes);
            return;
        }
        if (result.kind === "MEDIA_STORED") {
            json(response, 201, { ...result.media, correlationId });
            return;
        }
        if (result.kind === "ME") {
            json(response, 200, await providerState(pool, runtime, result.session));
            return;
        }
        if (result.outcome.ok) {
            json(response, result.outcome.replay ? 200 : 201, {
                ...result.outcome.value,
                replay: result.outcome.replay,
                correlationId
            });
        } else {
            refusal(response, result.outcome.reason, result.outcome.message, {
                findings: result.outcome.findings ?? [],
                correlationId
            });
        }
        return;
    }

    // ---- operations plane (Owner authority) -------------------------------
    if (path.startsWith("/api/operations/")) {
        const result = await withTransaction(pool, async (client) => {
            const auth = await requireSession(client, runtime, request, "OWNER");
            if (!auth.ok) {
                return { kind: "REFUSED" as const, reason: auth.reason, message: auth.message };
            }
            const context = contextFor(runtime, auth.session, correlationId);

            if (method === "GET" && path === "/api/operations/supply") {
                const week = url.searchParams.get("week");
                if (!week) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "FIELD_INVALID" as ProviderReason,
                        message: "week is required, as YYYY-MM-DD"
                    };
                }
                return {
                    kind: "SUPPLY" as const,
                    supply: await approvedSupply(client, runtime.configuration, { weekStartDate: week })
                };
            }

            if (method !== "POST") {
                return { kind: "NOT_FOUND" as const };
            }
            const body = await readJson(request);
            if (!body.ok) {
                return { kind: "MALFORMED" as const, message: body.message };
            }

            if (path === "/api/operations/cards/approve") {
                return { kind: "COMMAND" as const, outcome: await approveProviderCard(client, context, body.value) };
            }
            if (path === "/api/operations/cards/reject") {
                return { kind: "COMMAND" as const, outcome: await rejectProviderCard(client, context, body.value) };
            }
            if (path === "/api/operations/availability/confirm") {
                return { kind: "COMMAND" as const, outcome: await confirmAvailability(client, context, body.value) };
            }
            if (path === "/api/operations/provider-access") {
                const record = (body.value ?? {}) as Record<string, unknown>;
                const providerId = typeof record["providerId"] === "string" ? record["providerId"] : "";
                const issued = await issueProviderAccessSession(client, runtime, providerId);
                if (!issued.ok) {
                    return {
                        kind: "REFUSED" as const,
                        reason: "CROSS_TENANT_REFUSED" as ProviderReason,
                        message: issued.message
                    };
                }
                return { kind: "ACCESS" as const, token: issued.token };
            }
            return { kind: "NOT_FOUND" as const };
        });

        if (result.kind === "REFUSED") {
            refusal(response, result.reason, result.message, { correlationId });
            return;
        }
        if (result.kind === "MALFORMED") {
            json(response, 400, { error: "MALFORMED_BODY", message: result.message });
            return;
        }
        if (result.kind === "NOT_FOUND") {
            json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
            return;
        }
        if (result.kind === "SUPPLY") {
            json(response, 200, { supply: result.supply, correlationId });
            return;
        }
        if (result.kind === "ACCESS") {
            json(response, 201, { sessionToken: result.token, role: "PROVIDER", correlationId });
            return;
        }
        if (result.outcome.ok) {
            json(response, result.outcome.replay ? 200 : 201, {
                ...result.outcome.value,
                replay: result.outcome.replay,
                correlationId
            });
        } else {
            refusal(response, result.outcome.reason, result.outcome.message, {
                findings: result.outcome.findings ?? [],
                correlationId
            });
        }
        return;
    }

    json(response, 404, { error: "NOT_FOUND", message: `no route for ${method} ${path}` });
}

/**
 * The partner's own view of where they stand. Every field is read from
 * authoritative persistence at request time; nothing is reconstructed from
 * anything the browser remembered.
 */
async function providerState(
    pool: Pool,
    runtime: RuntimeContext,
    session: ResolvedSession
): Promise<Record<string, unknown>> {
    return withTransaction(pool, async (client) => {
        if (!session.providerId) {
            return {
                providerId: null,
                supplyStatus: null,
                stage: "PROFILE_NOT_SUBMITTED",
                governedRoleCodes: governedRoleCodes(runtime.configuration)
            };
        }
        const provider = await client.query<{ supply_status: string; display_name: string }>(
            `SELECT supply_status, display_name FROM core_provider WHERE provider_id = $1`,
            [session.providerId]
        );
        const profile = await currentProfile(client, session.providerId);
        const card = await client.query<{ card_id: string; state: string; decided_at: Date | null }>(
            `SELECT card_id, state, decided_at FROM core_provider_card
              WHERE provider_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
            [session.providerId]
        );
        const availability = await client.query<{
            availability_version_id: string;
            week_start_date: Date;
            version: number;
            state: string;
        }>(
            `SELECT availability_version_id, week_start_date, version, state
               FROM core_provider_availability_version
              WHERE provider_id = $1 AND state IN ('SUBMITTED', 'CONFIRMED')
              ORDER BY week_start_date, version`,
            [session.providerId]
        );

        const supplyStatus = provider.rows[0]?.supply_status ?? null;
        const cardState = card.rows[0]?.state ?? null;
        const stage =
            supplyStatus === "APPROVED"
                ? availability.rows.some((a) => a.state === "CONFIRMED")
                    ? "APPROVED_SUPPLY"
                    : "AWAITING_SCHEDULE_CONFIRMATION"
                : cardState === "SUBMITTED"
                  ? "OWNER_REVIEW_REQUIRED"
                  : profile
                    ? "PROFILE_SUBMITTED"
                    : "PROFILE_NOT_SUBMITTED";

        return {
            providerId: session.providerId,
            publicId: await publicIdOf(client, session.providerId),
            supplyStatus,
            stage,
            profile: profile
                ? {
                      profileId: profile.profileId,
                      version: profile.version,
                      legalName: profile.legalName,
                      displayName: profile.displayName,
                      contactHandle: profile.contactHandle,
                      roleCode: profile.roleCode,
                      serviceCodes: profile.serviceCodes,
                      howYouWork: profile.howYouWork,
                      aboutMe: profile.aboutMe,
                      profileChips: profile.profileChips,
                      portraitMediaId: profile.portraitMediaId
                  }
                : null,
            card: card.rows[0]
                ? {
                      cardId: card.rows[0].card_id,
                      state: card.rows[0].state,
                      decidedAt: card.rows[0].decided_at
                  }
                : null,
            availability: availability.rows.map((a) => ({
                availabilityVersionId: a.availability_version_id,
                weekStartDate: a.week_start_date.toISOString().slice(0, 10),
                version: a.version,
                state: a.state
            })),
            governedRoleCodes: governedRoleCodes(runtime.configuration)
        };
    });
}
