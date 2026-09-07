// G5-E — supply consumability, authority boundaries and durability.
//
// BP09 partner actions create no assignment or confirmation
// BP10 approved supply is consumable by the REAL G3 kernel
// BP11 restart durability
// BP14 role tamper
// BP15 cross-tenant isolation
// BP17 protected media boundary
// plus legacy non-authority and configuration tamper

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { evaluateServiceCommerce } from "../../src/kernel/evaluation";
import type { ServiceCommerceEvaluation } from "../../src/kernel/evaluation";
import { approvedSupply } from "../../src/provider/supply";
import { resolveSession, hashToken } from "../../src/provider/session";
import { activeConfiguration } from "../../src/config/tenant/store";
import { resolveFromStored } from "../../src/runtime/effectiveConfiguration";
import type { PartnerHost } from "../../src/host/partnerHost";
import {
    SCOPE,
    activate,
    approvedPartner,
    call,
    enrol,
    getProviderPool,
    ownerSession,
    resetProvider,
    startPartner,
    startPartnerOrThrow,
    tinyPng,
    validProfile,
    week
} from "./providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * Runs the REAL G3 kernel and unwraps its governed outcome. A refusal from the
 * kernel is a value, not an exception, so a failure to evaluate at all would
 * surface here rather than as a silently undefined field.
 */
async function evaluate(
    pool: Pool,
    request: Parameters<typeof evaluateServiceCommerce>[1]
): Promise<ServiceCommerceEvaluation> {
    const outcome = await withTransaction(pool, (client) =>
        evaluateServiceCommerce(client, request)
    );
    if (!outcome.ok) {
        throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    return outcome.value;
}

async function count(pool: Pool, table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params
    );
    return Number(rows[0]!.n);
}

d("G5-E / approved supply is consumable by the real G3 kernel", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    /** G3 catalogue configuration that predates G5-E and is not its to write. */
    async function enableMobileTopologyAndCustomer(): Promise<string> {
        return withTransaction(pool, async (client) => {
            await client.query(
                `INSERT INTO core_service_topology (service_id, topology)
                 SELECT service_id, 'MOBILE' FROM core_service
                 ON CONFLICT DO NOTHING`
            );
            const { rows } = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ('bali', 'Customer')
                 RETURNING identity_id`
            );
            const identityId = rows[0]!.identity_id;
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role)
                 VALUES ($1, 'bali', 'CUSTOMER')`,
                [identityId]
            );
            return identityId;
        });
    }

    async function serviceIdFor(code: string): Promise<string> {
        const { rows } = await pool.query<{ service_id: string }>(
            `SELECT service_id FROM core_catalogue_binding
              WHERE kind = 'SERVICE' AND service_code = $1`,
            [code]
        );
        return rows[0]!.service_id;
    }

    it("BP10 — G3 finds the approved partner and returns SELLABLE naming them", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        const customerIdentityId = await enableMobileTopologyAndCustomer();
        const serviceId = await serviceIdFor("FRESH_CUT");

        // Wednesday of the confirmed week, 10:00 local — inside 09:00-17:00.
        const start = DateTime.fromISO(partner.weekStartDate, { zone: "Asia/Makassar" })
            .plus({ days: 2 })
            .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });

        const evaluation = await evaluate(pool, {
                marketId: "bali",
                topology: "MOBILE",
                serviceId,
                customerIdentityId,
                serviceAreaKey: "Seminyak",
            requestedStart: start.toJSDate()
        });

        expect(evaluation.outcome).toBe("SELLABLE");
        expect(evaluation.reasonCode).toBeNull();
        expect(evaluation.terms?.providerId).toBe(partner.providerId);
        expect(evaluation.terms?.serviceAreaKey).toBe("Seminyak");
    });

    it("BP10 / S03 — a provider with a profile but no approved card is invisible to G3", async () => {
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() });
        const customerIdentityId = await enableMobileTopologyAndCustomer();
        const serviceId = await serviceIdFor("FRESH_CUT");

        const evaluation = await evaluate(pool, {
                marketId: "bali",
                topology: "MOBILE",
                serviceId,
                customerIdentityId,
                serviceAreaKey: "Seminyak",
            requestedStart: DateTime.now()
                .setZone("Asia/Makassar")
                .plus({ weeks: 2 })
                .startOf("week")
                .plus({ days: 2, hours: 10 })
                .toJSDate()
        });
        expect(evaluation.outcome).not.toBe("SELLABLE");
        expect(evaluation.reasonCode).toBe("NO_ELIGIBLE_PROVIDER");
    });

    it("BP10 / S04 — an approved card without a confirmed week yields no supply", async () => {
        const { token } = await enrol(host.origin);
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const card = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: card.body["cardId"] }
        });
        const weekStartDate = DateTime.now()
            .setZone("Asia/Makassar")
            .plus({ weeks: 2 })
            .startOf("week")
            .toFormat("yyyy-MM-dd");
        await call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: { weekStartDate, days: week() }
        });

        const supply = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate })
        );
        expect(supply).toEqual([]);
        expect(await count(pool, "core_capacity_window")).toBe(0);

        const customerIdentityId = await enableMobileTopologyAndCustomer();
        const serviceId = await serviceIdFor("FRESH_CUT");
        const evaluation = await evaluate(pool, {
                marketId: "bali",
                topology: "MOBILE",
                serviceId,
                customerIdentityId,
                serviceAreaKey: "Seminyak",
            requestedStart: DateTime.fromISO(weekStartDate, { zone: "Asia/Makassar" })
                .plus({ days: 2, hours: 10 })
                .toJSDate()
        });
        // The provider is eligible on paper, but has declared no bookable time.
        expect(evaluation.outcome).not.toBe("SELLABLE");
        expect(evaluation.reasonCode).toBe("PROVIDER_UNAVAILABLE");
        expect(profile.body["providerId"]).toBeTruthy();
    });

    it("BP10 / S05 — a stale confirmed week stops being consumable the moment it is superseded", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        const customerIdentityId = await enableMobileTopologyAndCustomer();
        const serviceId = await serviceIdFor("FRESH_CUT");
        const start = DateTime.fromISO(partner.weekStartDate, { zone: "Asia/Makassar" })
            .plus({ days: 2 })
            .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
            .toJSDate();

        const before = await evaluate(pool, {
            marketId: "bali",
            topology: "MOBILE",
            serviceId,
            customerIdentityId,
            serviceAreaKey: "Seminyak",
            requestedStart: start
        });
        expect(before.outcome).toBe("SELLABLE");

        // The partner edits: Wednesday is now a day off.
        await call(host.origin, "POST", "/api/partner/availability", {
            token: partner.token,
            body: {
                weekStartDate: partner.weekStartDate,
                days: week([{ isoDay: 3, available: false }])
            }
        });

        const after = await evaluate(pool, {
            marketId: "bali",
            topology: "MOBILE",
            serviceId,
            customerIdentityId,
            serviceAreaKey: "Seminyak",
            requestedStart: start
        });
        expect(after.outcome).not.toBe("SELLABLE");
        expect(after.reasonCode).toBe("PROVIDER_UNAVAILABLE");
    });

    it("S02 — supply is exposed through the constructs G3 already reads, not a second engine", async () => {
        const partner = await approvedPartner(host.origin, owner.token);

        // Capability, coverage and time all land in canonical Core tables.
        expect(await count(pool, "core_provider_service", "provider_id = $1", [partner.providerId])).toBe(2);
        expect(await count(pool, "core_provider_service_area", "provider_id = $1", [partner.providerId])).toBe(1);
        expect(await count(pool, "core_capacity_window", "provider_id = $1 AND active = TRUE", [partner.providerId])).toBe(5);
        // Every window is attributable to the version that granted it.
        expect(
            await count(
                pool,
                "core_supply_window_link",
                "availability_version_id = $1",
                [partner.availabilityVersionId]
            )
        ).toBe(5);
    });

    it("BP11 — provider, card, Partner ID and confirmed week survive a full restart", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        const beforeSupply = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate: partner.weekStartDate })
        );

        await host.close();
        await pool.end();

        pool = getProviderPool();
        host = await startPartnerOrThrow(pool);

        const afterSupply = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate: partner.weekStartDate })
        );
        expect(afterSupply).toEqual(beforeSupply);
        expect(afterSupply[0]!.publicId).toBe(partner.publicId);

        // The partner's own view is rebuilt from persistence, not from anything
        // a browser remembered.
        const me = await call(host.origin, "GET", "/api/partner/me", { token: partner.token });
        expect(me.status).toBe(200);
        expect(me.body["providerId"]).toBe(partner.providerId);
        expect(me.body["publicId"]).toBe(partner.publicId);
        expect(me.body["supplyStatus"]).toBe("APPROVED");
        expect(me.body["stage"]).toBe("APPROVED_SUPPLY");
    });
});

d("G5-E / authority — a partner cannot approve itself, or reach another tenant", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("BP14 — a provider session is refused on every Owner-only command", async () => {
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() });
        const card = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });

        for (const path of [
            "/api/operations/cards/approve",
            "/api/operations/cards/reject",
            "/api/operations/availability/confirm",
            "/api/operations/provider-access"
        ]) {
            const attempt = await call(host.origin, "POST", path, {
                token,
                body: { cardId: card.body["cardId"], availabilityVersionId: card.body["cardId"] }
            });
            expect(attempt.status, path).toBe(403);
            expect(attempt.body["error"], path).toBe("OWNER_AUTHORITY_REQUIRED");
        }
        const supplyRead = await call(host.origin, "GET", "/api/operations/supply?week=2026-11-16", {
            token
        });
        expect(supplyRead.status).toBe(403);

        const { rows } = await pool.query<{ supply_status: string }>(
            `SELECT supply_status FROM core_provider`
        );
        expect(rows[0]!.supply_status).toBe("SUBMITTED");
    });

    it("BP14 — a role cannot be widened by anything the holder sends", async () => {
        const { token } = await enrol(host.origin);
        for (const headers of [
            { "x-scp-role": "OWNER" },
            { "x-partner-role": "OWNER" },
            { authorization: `Bearer ${token}`, "x-role": "OWNER" }
        ]) {
            const attempt = await call(host.origin, "POST", "/api/operations/cards/approve", {
                token,
                headers,
                body: { cardId: "00000000-0000-0000-0000-000000000001" }
            });
            expect(attempt.status).toBe(403);
        }
        // The session's role is read from the database, not from the request.
        const resolved = await withTransaction(pool, (client) =>
            resolveSession(client, token, {
                tenantId: SCOPE.tenantId,
                marketId: SCOPE.marketId,
                environment: SCOPE.environment
            })
        );
        expect(resolved.ok && resolved.session.role).toBe("PROVIDER");
    });

    it("SEC01 — a provider identifier without a session is not authority", async () => {
        const { token } = await enrol(host.origin);
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const providerId = profile.body["providerId"];

        // No token at all.
        expect((await call(host.origin, "POST", "/api/partner/card", { body: {} })).status).toBe(401);
        // A forged token.
        expect(
            (await call(host.origin, "POST", "/api/partner/card", { token: "not-a-real-token", body: {} }))
                .status
        ).toBe(401);
        // The provider id itself, offered as a token.
        expect(
            (await call(host.origin, "POST", "/api/partner/card", { token: String(providerId), body: {} }))
                .status
        ).toBe(401);
    });

    it("a revoked or expired session stops working, and only a digest is stored", async () => {
        const { token } = await enrol(host.origin);
        const { rows } = await pool.query<{ token_sha256: string }>(
            `SELECT token_sha256 FROM core_provider_session WHERE token_sha256 = $1`,
            [hashToken(token)]
        );
        expect(rows).toHaveLength(1);
        // The plaintext appears nowhere.
        const anyPlaintext = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM core_provider_session WHERE token_sha256 = $1`,
            [token]
        );
        expect(Number(anyPlaintext.rows[0]!.n)).toBe(0);

        await pool.query(`UPDATE core_provider_session SET revoked_at = now() WHERE token_sha256 = $1`, [
            hashToken(token)
        ]);
        expect(
            (await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() }))
                .status
        ).toBe(401);

        // The row must stay coherent: a session cannot expire before it was
        // issued, and the schema refuses to let a test pretend otherwise.
        await pool.query(
            `UPDATE core_provider_session
                SET revoked_at = NULL,
                    issued_at = now() - interval '2 hours',
                    expires_at = now() - interval '1 hour'
              WHERE token_sha256 = $1`,
            [hashToken(token)]
        );
        expect(
            (await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() }))
                .status
        ).toBe(401);
    });

    it("BP15 — a session minted for another tenant, market or environment has no authority here", async () => {
        const { token } = await enrol(host.origin);
        for (const change of [
            "tenant_id = 'another-tenant'",
            "market_id = 'bangkok'",
            "environment = 'production'"
        ]) {
            await pool.query(`UPDATE core_provider_session SET ${change} WHERE token_sha256 = $1`, [
                hashToken(token)
            ]);
            const attempt = await call(host.origin, "POST", "/api/partner/profile", {
                token,
                body: validProfile()
            });
            expect(attempt.status, change).toBe(403);
            expect(attempt.body["error"], change).toBe("SESSION_SCOPE_MISMATCH");
            await pool.query(
                `UPDATE core_provider_session SET tenant_id = $1, market_id = $2, environment = $3
                  WHERE token_sha256 = $4`,
                [SCOPE.tenantId, SCOPE.marketId, SCOPE.environment, hashToken(token)]
            );
        }
    });

    it("BP15 — an Owner cannot decide a card belonging to another tenant scope", async () => {
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() });
        const card = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });

        await pool.query(`UPDATE core_provider_card SET tenant_id = 'another-tenant'`);
        const attempt = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: card.body["cardId"] }
        });
        expect(attempt.status).toBe(403);
        expect(attempt.body["error"]).toBe("CROSS_TENANT_REFUSED");
        expect(await count(pool, "core_provider_public_id")).toBe(0);
    });

    it("BP15 — an existing contact cannot mint a fresh session for itself", async () => {
        const enrolled = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", {
            token: enrolled.token,
            body: validProfile()
        });
        // The same contact, coming back without a token. Re-access is an Owner
        // act, because the handle is unverified in this gate.
        const attempt = await call(host.origin, "POST", "/api/partner/session", {
            body: { contactHandle: enrolled.contactHandle, displayName: "Wayan" }
        });
        expect(attempt.status).toBe(401);
        expect(attempt.body["error"]).toBe("SESSION_INVALID");
    });

    it("an Owner can issue governed re-access, and it carries no Owner authority", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        const issued = await call(host.origin, "POST", "/api/operations/provider-access", {
            token: owner.token,
            body: { providerId: partner.providerId }
        });
        expect(issued.status).toBe(201);
        const reissued = issued.body["sessionToken"] as string;

        const me = await call(host.origin, "GET", "/api/partner/me", { token: reissued });
        expect(me.body["providerId"]).toBe(partner.providerId);

        const escalation = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: reissued,
            body: { cardId: partner.cardId }
        });
        expect(escalation.status).toBe(403);
    });
});

d("G5-E / BP09 — partner actions never create assignment, confirmation or fulfillment", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("the full partner journey produces no customer-side state whatsoever", async () => {
        await approvedPartner(host.origin, owner.token);

        expect(await count(pool, "core_service_request")).toBe(0);
        expect(await count(pool, "core_dispatch_offer")).toBe(0);
        expect(await count(pool, "core_assignment")).toBe(0);
        expect(await count(pool, "core_customer_confirmation")).toBe(0);
        expect(await count(pool, "core_fulfillment")).toBe(0);
        expect(await count(pool, "core_capacity_hold")).toBe(0);
        expect(await count(pool, "core_operational_action")).toBe(0);
        expect(await count(pool, "core_sellable_offer")).toBe(0);

        // The only canonical events are the provider activation.
        const { rows } = await pool.query<{ object_type: string; to_state: string }>(
            `SELECT object_type, to_state FROM core_event ORDER BY event_id`
        );
        expect(rows).toEqual([{ object_type: "PROVIDER", to_state: "APPROVED" }]);
    });

    it("there is no partner route through which an assignment could be requested", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        for (const path of [
            "/api/partner/assign",
            "/api/partner/accept",
            "/api/partner/offers",
            "/api/partner/confirm",
            "/api/partner/fulfillment"
        ]) {
            const attempt = await call(host.origin, "POST", path, {
                token: partner.token,
                body: {}
            });
            expect(attempt.status, path).toBe(404);
        }
        expect(await count(pool, "core_assignment")).toBe(0);
    });
});

d("G5-E / legacy non-authority and configuration integrity", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("hostile legacy contractor data cannot outrank canonical provider truth", async () => {
        const { token } = await enrol(host.origin);
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const providerId = profile.body["providerId"] as string;

        // A legacy alias claiming this provider is approved changes nothing:
        // the alias register translates vocabulary, it does not confer status.
        await pool.query(
            `INSERT INTO core_provider_alias (provider_id, alias_kind, alias_value, note)
             VALUES ($1, 'LEGACY_CONTRACTOR_ID', 'legacy-approved-999', 'hostile fixture')`,
            [providerId]
        );
        const { rows } = await pool.query<{ supply_status: string }>(
            `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
            [providerId]
        );
        expect(rows[0]!.supply_status).toBe("SUBMITTED");

        // And a second Provider cannot be constructed from the same legacy id.
        await expect(
            pool.query(
                `INSERT INTO core_provider_alias (provider_id, alias_kind, alias_value)
                 VALUES ($1, 'LEGACY_CONTRACTOR_ID', 'legacy-approved-999')`,
                [providerId]
            )
        ).rejects.toThrow();
    });

    it("legacy appointment rows cannot create or alter approved supply", async () => {
        const partner = await approvedPartner(host.origin, owner.token);
        const before = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate: partner.weekStartDate })
        );

        const legacyService = await pool.query<{ service_id: string }>(
            `INSERT INTO service_catalogue (name, duration_minutes) VALUES ('Legacy', 60)
             RETURNING service_id`
        );
        const legacyCustomer = await pool.query<{ identity_id: string }>(
            `INSERT INTO core_identity (market_id, display_name) VALUES ('bali', 'Legacy')
             RETURNING identity_id`
        );
        await pool.query(
            `INSERT INTO appointments (billing_code, customer_id, service_id, start_time, end_time, status)
             VALUES ($3, $1, $2, now() + interval '2 days', now() + interval '2 days 1 hour',
                     'CONTRACTOR_ACCEPTED')`,
            [
                legacyCustomer.rows[0]!.identity_id,
                legacyService.rows[0]!.service_id,
                `FL-${String(Date.now() % 1_000_000).padStart(6, "0")}-G5E0`
            ]
        );

        const after = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate: partner.weekStartDate })
        );
        expect(after).toEqual(before);
    });

    it("no provider or supply table references the legacy surface", async () => {
        const { rows } = await pool.query<{ table_name: string; column_name: string }>(
            `SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name LIKE 'core_provider%'
                AND (column_name LIKE '%appointment%' OR column_name LIKE '%contractor%')`
        );
        expect(rows).toEqual([]);
    });

    it("a tampered configuration checksum is refused by the database and by the resolver", async () => {
        const stored = await withTransaction(pool, (client) => activeConfiguration(client, SCOPE));
        expect(stored).not.toBeNull();

        await expect(
            pool.query(`UPDATE core_tenant_configuration SET checksum = $1 WHERE configuration_id = $2`, [
                "0".repeat(64),
                stored!.configurationId
            ])
        ).rejects.toThrow(/immutable/);

        const resolved = resolveFromStored({ ...stored!, checksum: "0".repeat(64) }, SCOPE);
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe("CONFIGURATION_CHECKSUM_MISMATCH");
    });

    it("the Partner host will not start without a resolvable governed runtime", async () => {
        await pool.query(`UPDATE core_tenant_configuration SET state = 'SUPERSEDED' WHERE state = 'ACTIVE'`);
        const outcome = await startPartner(pool);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NO_ACTIVE_CONFIGURATION");

        for (const missing of [{ tenantId: "" }, { marketId: "" }, { environment: "" }]) {
            const attempt = await startPartner(pool, missing);
            expect(attempt.ok).toBe(false);
            if (attempt.ok) continue;
            expect(attempt.code).toBe("IDENTITY_NOT_CONFIGURED");
        }
    });
});

d("G5-E / BP17 — the protected media boundary", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    async function partnerWithPortrait() {
        const { token } = await enrol(host.origin);
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const upload = await fetch(`${host.origin}/api/partner/portrait`, {
            method: "POST",
            headers: { "content-type": "image/png", "x-partner-session": token },
            body: tinyPng()
        });
        const media = (await upload.json()) as Record<string, unknown>;
        return {
            token,
            providerId: profile.body["providerId"] as string,
            mediaId: media["mediaId"] as string,
            status: upload.status,
            media
        };
    }

    it("stores portrait bytes behind the server, with a content type it verified itself", async () => {
        const partner = await partnerWithPortrait();
        expect(partner.status).toBe(201);
        expect(partner.media["contentType"]).toBe("image/png");
        expect(String(partner.media["sha256"])).toMatch(/^[0-9a-f]{64}$/);

        const read = await fetch(`${host.origin}/api/partner/portrait/${partner.mediaId}`, {
            headers: { "x-partner-session": partner.token }
        });
        expect(read.status).toBe(200);
        expect(read.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await read.arrayBuffer()).equals(tinyPng())).toBe(true);
    });

    it("refuses an unauthenticated read and another partner's portrait", async () => {
        const mine = await partnerWithPortrait();

        const anonymous = await fetch(`${host.origin}/api/partner/portrait/${mine.mediaId}`);
        expect(anonymous.status).toBe(401);

        const other = await enrol(host.origin, "Ketut");
        await call(host.origin, "POST", "/api/partner/profile", {
            token: other.token,
            body: validProfile({ displayName: "Ketut", contactHandle: "+628137776666" })
        });
        const stolen = await fetch(`${host.origin}/api/partner/portrait/${mine.mediaId}`, {
            headers: { "x-partner-session": other.token }
        });
        expect(stolen.status).toBe(422);
    });

    it("refuses a file that is not really an image, whatever it claims to be", async () => {
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() });
        const upload = await fetch(`${host.origin}/api/partner/portrait`, {
            method: "POST",
            // A declared content type is a claim; the magic bytes are the file.
            headers: { "content-type": "image/png", "x-partner-session": token },
            body: Buffer.from("<?php system($_GET['c']); ?>", "utf8")
        });
        expect(upload.status).toBe(422);
        expect(((await upload.json()) as Record<string, unknown>)["error"]).toBe(
            "MEDIA_TYPE_UNSUPPORTED"
        );
        expect(await count(pool, "core_provider_media")).toBe(0);
    });

    it("M02 — replacing or deleting the bytes cannot move Provider approval", async () => {
        const partner = await partnerWithPortrait();
        await call(host.origin, "POST", "/api/partner/profile", {
            token: partner.token,
            body: validProfile({ portraitMediaId: partner.mediaId })
        });
        const card = await call(host.origin, "POST", "/api/partner/card", {
            token: partner.token,
            body: {}
        });
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: card.body["cardId"] }
        });

        const approved = await pool.query<{ supply_status: string }>(
            `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
            [partner.providerId]
        );
        expect(approved.rows[0]!.supply_status).toBe("APPROVED");

        // Corrupt the bytes outright. Approval is not stored here and does not move.
        await pool.query(`UPDATE core_provider_media SET bytes = $1, sha256 = $2 WHERE media_id = $3`, [
            Buffer.from([0xff, 0xd8, 0xff, 0x00]),
            "f".repeat(64),
            partner.mediaId
        ]);
        const after = await pool.query<{ supply_status: string }>(
            `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
            [partner.providerId]
        );
        expect(after.rows[0]!.supply_status).toBe("APPROVED");
    });

    it("refuses a portrait reference belonging to another provider", async () => {
        const mine = await partnerWithPortrait();
        const other = await enrol(host.origin, "Ketut");
        const attempt = await call(host.origin, "POST", "/api/partner/profile", {
            token: other.token,
            body: validProfile({
                displayName: "Ketut",
                contactHandle: "+628135554444",
                portraitMediaId: mine.mediaId
            })
        });
        expect(attempt.status).toBe(422);
        expect(attempt.body["error"]).toBe("MEDIA_NOT_FOUND");
    });

    it("the browser never receives a storage credential", async () => {
        const page = await (await fetch(`${host.origin}/`)).text();
        for (const marker of [
            "service_role",
            "serviceRole",
            "SUPABASE",
            "AWS_",
            "accessKeyId",
            "secretAccessKey",
            "signedUrl",
            "presigned"
        ]) {
            expect(page, `the partner page must not contain ${marker}`).not.toContain(marker);
        }
        // Uploads go to this host's own route, carrying only the session token.
        expect(page).toContain("/api/partner/portrait");
    });
});
