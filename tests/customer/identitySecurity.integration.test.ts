// G5-D — identity and configuration security at the customer boundary.
//
// A customer surface is the least trusted input in the platform. These proofs
// say what it cannot do: it cannot choose its tenant, its market, or its
// environment, and it cannot get a serving process at all when the governed
// configuration or the persistence behind it is not there.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V1, FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { resolveFromStored } from "../../src/runtime/effectiveConfiguration";
import { activeConfiguration } from "../../src/config/tenant/store";
import { INGRESS_PATH, type CustomerHost } from "../../src/host/customerHost";
import {
    SCOPE,
    activate,
    getCustomerPool,
    post,
    resetCustomer,
    startHost,
    startHostOrThrow,
    validIntent
} from "./customerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G5-D / identity security — a caller may assert an identity, never set one", () => {
    let pool: Pool;
    let host: CustomerHost;

    beforeEach(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startHostOrThrow(pool);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("refuses a cross-tenant assertion", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent(), {
            "x-scp-tenant": "someone-elses-tenant"
        });
        expect(response.status).toBe(403);
        expect(response.body["error"]).toBe("IDENTITY_MISMATCH");
        const { rows } = await pool.query(`SELECT count(*) AS n FROM core_service_request`);
        expect(Number(rows[0]!.n)).toBe(0);
    });

    it("refuses a wrong market and a wrong environment", async () => {
        const market = await post(host.origin, INGRESS_PATH, validIntent(), {
            "x-scp-market": "bangkok"
        });
        expect(market.status).toBe(403);
        expect(market.body["error"]).toBe("IDENTITY_MISMATCH");

        const environment = await post(host.origin, INGRESS_PATH, validIntent(), {
            "x-scp-environment": "production"
        });
        expect(environment.status).toBe(403);
        expect(environment.body["error"]).toBe("ENVIRONMENT_MISMATCH");
    });

    it("accepts an assertion that agrees, without letting it become the source", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent(), {
            "x-scp-tenant": SCOPE.tenantId,
            "x-scp-market": SCOPE.marketId,
            "x-scp-environment": SCOPE.environment
        });
        expect(response.status).toBe(201);

        const { rows } = await pool.query<{ tenant_id: string; market_id: string; environment: string }>(
            `SELECT tenant_id, market_id, environment FROM core_demand_ingress`
        );
        expect(rows[0]).toEqual({
            tenant_id: SCOPE.tenantId,
            market_id: SCOPE.marketId,
            environment: SCOPE.environment
        });
    });

    it("refuses a tenant, market or environment smuggled into the body", async () => {
        for (const field of ["tenantId", "marketId", "environment"]) {
            const response = await post(
                host.origin,
                INGRESS_PATH,
                validIntent({ [field]: "attacker-controlled" })
            );
            expect(response.status).toBe(422);
            expect(response.body["error"]).toBe("UNDECLARED_FIELD");
        }
    });

    it("refuses a malformed or oversized body before it reaches the contract", async () => {
        expect((await post(host.origin, INGRESS_PATH, "{not json")).status).toBe(400);
        expect((await post(host.origin, INGRESS_PATH, "")).status).toBe(400);

        const huge = { ...validIntent(), customerName: "x".repeat(64 * 1024) };
        expect((await post(host.origin, INGRESS_PATH, huge)).status).toBe(400);
    });

    it("exposes no route that could mutate canonical state", async () => {
        const response = await fetch(`${host.origin}${INGRESS_PATH}`, { method: "DELETE" });
        expect(response.status).toBe(405);
        const unknown = await fetch(`${host.origin}/api/admin/confirm`, { method: "POST" });
        expect(unknown.status).toBe(404);
    });
});

d("G5-D / runtime host — fails closed, and never opens a second authority path", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
    });

    afterEach(async () => {
        await pool?.end();
    });

    it("will not start without a complete runtime identity", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        for (const missing of [{ tenantId: "" }, { marketId: "" }, { environment: "" }]) {
            const outcome = await startHost(pool, missing);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) continue;
            expect(outcome.code).toBe("IDENTITY_NOT_CONFIGURED");
        }
    });

    it("will not start without an ACTIVE governed configuration", async () => {
        const outcome = await startHost(pool);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NO_ACTIVE_CONFIGURATION");
    });

    it("will not start on a v1 bundle, which restates canonical market values", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        const outcome = await startHost(pool);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("CONFIGURATION_SCHEMA_UNSUPPORTED");
    });

    it("will not start for a tenant, market or environment it has no configuration for", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        for (const scope of [
            { tenantId: "another-tenant" },
            { marketId: "bangkok" },
            { environment: "production" }
        ]) {
            const outcome = await startHost(pool, scope);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) continue;
            expect(outcome.code).toBe("NO_ACTIVE_CONFIGURATION");
        }
    });

    it("will not start when authoritative persistence is unreachable", async () => {
        const unreachable = createPool({ database: "no_such_database_g5d", max: 1 });
        try {
            const outcome = await startHost(unreachable);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.code).toBe("PERSISTENCE_UNAVAILABLE");
        } finally {
            await unreachable.end().catch(() => {});
        }
    });

    it("will not start when the schema the runtime needs is incompatible", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        await pool.query(`ALTER TABLE core_demand_ingress RENAME TO core_demand_ingress_hidden`);
        await pool.query(`ALTER TABLE core_service_request RENAME TO core_service_request_hidden`);
        try {
            const outcome = await startHost(pool);
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.code).toBe("SCHEMA_INCOMPATIBLE");
        } finally {
            await pool.query(`ALTER TABLE core_service_request_hidden RENAME TO core_service_request`);
            await pool.query(`ALTER TABLE core_demand_ingress_hidden RENAME TO core_demand_ingress`);
        }
    });

    it("refuses a configuration whose stored checksum no longer describes its content", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const stored = await withTransaction(pool, (client) => activeConfiguration(client, SCOPE));
        expect(stored).not.toBeNull();

        // The G5-B immutability trigger refuses the corruption at the database.
        await expect(
            pool.query(`UPDATE core_tenant_configuration SET checksum = $1 WHERE configuration_id = $2`, [
                "0".repeat(64),
                stored!.configurationId
            ])
        ).rejects.toThrow(/immutable/);

        // And the resolver refuses it independently, so neither guard is the
        // only thing standing between a tampered bundle and a running host.
        const tampered = { ...stored!, checksum: "0".repeat(64) };
        const resolved = resolveFromStored(tampered, SCOPE);
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe("CONFIGURATION_CHECKSUM_MISMATCH");
    });

    it("binds nothing when it refuses to start", async () => {
        const outcome = await startHost(pool, {}, { projectCatalogueOnStart: false });
        expect(outcome.ok).toBe(false);
        // No host object means no server, no port and nothing to close.
        expect(Object.hasOwn(outcome, "host")).toBe(false);
    });

    it("serves only after the runtime spine has verified persistence and configuration", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const host = await startHostOrThrow(pool);
        try {
            const response = await fetch(`${host.origin}/healthz`);
            const body = (await response.json()) as Record<string, unknown>;
            expect(response.status).toBe(200);
            expect(body["status"]).toBe("SERVING");
            // The health answer is the runtime's own description of the ONE
            // configuration governing it, not a second lookup.
            expect(body["configuration"]).toBe(host.runtime.describe());
            expect(body["requiredRelations"]).toBe(host.runtime.schema.present.length);
        } finally {
            await host.close();
        }
    });
});
