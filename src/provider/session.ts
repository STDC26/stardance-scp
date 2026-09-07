// SCP-G5-E — server-issued, server-verified provider and owner sessions.
//
// SEC01: a client-supplied provider identifier is not authority. Authority comes
// from a token this server minted, stored only as a SHA-256 digest, bound at
// issue to one identity, one tenant, one market, one environment and ONE ROLE.
//
// The role is fixed at issue and read from the database on every request. There
// is no field a holder can send that widens it, which is what makes "a Provider
// cannot approve its own card" structural rather than a check someone might
// forget to write.
//
// What this is NOT: a general IAM, a password system, or a credential-recovery
// flow. It is the smallest server-verified session boundary the provider
// workflow needs. Out-of-band identity verification (the channel that would let
// a returning partner prove who they are without an existing token) is
// deliberately absent and recorded as a residual rather than faked.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { IdentityLineage } from "../runtime/identity";

export type SessionRole = "PROVIDER" | "OWNER";

export interface IssuedSession {
    /** Returned to the caller exactly once. Never stored in this form. */
    token: string;
    sessionId: string;
    identityId: string;
    providerId: string | null;
    role: SessionRole;
    expiresAt: Date;
}

export interface ResolvedSession {
    sessionId: string;
    identityId: string;
    providerId: string | null;
    role: SessionRole;
    lineage: IdentityLineage;
    expiresAt: Date;
}

/** Eight hours. A partner portal session should outlive a shift, not a month. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two digests. Session lookup is by digest and
 * therefore already indexed, but comparing the recomputed digest to the stored
 * one this way keeps the verification path free of a timing signal.
 */
function digestsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
}

export interface IssueInput {
    identityId: string;
    providerId?: string | null;
    role: SessionRole;
    lineage: IdentityLineage;
    now?: Date;
    ttlMs?: number;
}

/**
 * Mints a session. 256 bits of entropy from the OS CSPRNG; the plaintext is
 * returned to the caller and never written anywhere.
 */
export async function issueSession(
    client: PoolClient,
    input: IssueInput
): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? SESSION_TTL_MS));

    const { rows } = await client.query<{ session_id: string }>(
        `INSERT INTO core_provider_session
            (token_sha256, identity_id, provider_id, tenant_id, market_id, environment,
             session_role, issued_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING session_id`,
        [
            hashToken(token),
            input.identityId,
            input.providerId ?? null,
            input.lineage.tenantId,
            input.lineage.marketId,
            input.lineage.environment,
            input.role,
            now,
            expiresAt
        ]
    );

    return {
        token,
        sessionId: rows[0]!.session_id,
        identityId: input.identityId,
        providerId: input.providerId ?? null,
        role: input.role,
        expiresAt
    };
}

/**
 * Binds an applicant session to the Provider record it just created. This is
 * the ONLY widening a session ever undergoes, it is performed by the server
 * inside the same transaction that creates the Provider, and it cannot change
 * the session's role.
 */
export async function attachProviderToSession(
    client: PoolClient,
    sessionId: string,
    providerId: string
): Promise<void> {
    await client.query(
        `UPDATE core_provider_session
            SET provider_id = $2
          WHERE session_id = $1 AND provider_id IS NULL AND session_role = 'PROVIDER'`,
        [sessionId, providerId]
    );
}

export type SessionFailure = "SESSION_INVALID" | "SESSION_SCOPE_MISMATCH";

export type SessionOutcome =
    | { ok: true; session: ResolvedSession }
    | { ok: false; code: SessionFailure; message: string };

/**
 * Resolves a bearer token to a session, or refuses.
 *
 * Every refusal returns the same shape and says nothing about whether the token
 * was unknown, expired or revoked — a caller learns only that it has no
 * authority here.
 */
export async function resolveSession(
    client: PoolClient,
    token: string | undefined,
    lineage: IdentityLineage,
    now: Date = new Date()
): Promise<SessionOutcome> {
    if (!token || token.trim() === "") {
        return { ok: false, code: "SESSION_INVALID", message: "no session token was presented" };
    }

    const digest = hashToken(token.trim());
    const { rows } = await client.query<{
        session_id: string;
        token_sha256: string;
        identity_id: string;
        provider_id: string | null;
        tenant_id: string;
        market_id: string;
        environment: string;
        session_role: SessionRole;
        expires_at: Date;
        revoked_at: Date | null;
    }>(
        `SELECT session_id, token_sha256, identity_id, provider_id, tenant_id, market_id,
                environment, session_role, expires_at, revoked_at
           FROM core_provider_session
          WHERE token_sha256 = $1`,
        [digest]
    );
    const row = rows[0];
    if (!row || !digestsMatch(row.token_sha256, digest)) {
        return { ok: false, code: "SESSION_INVALID", message: "the session is not valid" };
    }
    if (row.revoked_at !== null || row.expires_at.getTime() <= now.getTime()) {
        return { ok: false, code: "SESSION_INVALID", message: "the session is not valid" };
    }

    // A session minted for another tenant, market or environment is a real
    // session — and still has no authority in this runtime.
    if (
        row.tenant_id !== lineage.tenantId ||
        row.market_id !== lineage.marketId ||
        row.environment !== lineage.environment
    ) {
        return {
            ok: false,
            code: "SESSION_SCOPE_MISMATCH",
            message: "the session belongs to a different tenant, market or environment"
        };
    }

    return {
        ok: true,
        session: {
            sessionId: row.session_id,
            identityId: row.identity_id,
            providerId: row.provider_id,
            role: row.session_role,
            lineage: {
                tenantId: row.tenant_id,
                marketId: row.market_id,
                environment: row.environment
            },
            expiresAt: row.expires_at
        }
    };
}

export async function revokeSession(client: PoolClient, sessionId: string): Promise<void> {
    await client.query(
        `UPDATE core_provider_session SET revoked_at = now()
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId]
    );
}
