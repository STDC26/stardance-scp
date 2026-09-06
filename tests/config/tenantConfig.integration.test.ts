// G5-B — activation, rollback, tenant isolation and inactive-capability
// inertness, against real PostgreSQL.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, withTransaction } from "../../src/db/pool";
import {
    publishConfiguration,
    approveConfiguration,
    activateConfiguration,
    rollbackToVersion,
    activeConfiguration,
    loadVersion,
    configurationHistory
} from "../../src/config/tenant/store";
import { FRESHLINE_BALI_V1, FRESHLINE_BALI_SCOPE, cloneBundle } from "../../src/config/tenant/freshline";
import { configurationChecksum } from "../../src/config/tenant/identity";
import type { TenantConfigurationBundle } from "../../src/config/tenant/contract";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

const ACTOR = "PTC/DRJ";
const SOURCE = "SCP-G5-B-01";

async function reset(pool: Pool): Promise<void> {
    await pool.query(
        `TRUNCATE core_tenant_configuration_event, core_tenant_configuration RESTART IDENTITY CASCADE`
    );
}

/** Publishes, approves and activates a bundle in one go. */
async function activate(pool: Pool, bundle: TenantConfigurationBundle) {
    return withTransaction(pool, async (client) => {
        const published = await publishConfiguration(client, {
            bundle,
            actorOrAuthority: ACTOR,
            sourceReference: SOURCE
        });
        if (!published.ok) throw new Error(published.message);
        const approved = await approveConfiguration(
            client,
            published.value.configuration.configurationId,
            ACTOR
        );
        if (!approved.ok) throw new Error(approved.message);
        const activated = await activateConfiguration(
            client,
            published.value.configuration.configurationId,
            ACTOR
        );
        if (!activated.ok) throw new Error(activated.message);
        return activated.value;
    });
}

/** A v2 bundle with a genuine catalogue change. */
function v2(): TenantConfigurationBundle {
    const b = cloneBundle(FRESHLINE_BALI_V1);
    b.configurationVersion = 2;
    b.planes.CATALOGUE.services[0]!.price.amount = 375000;
    return b;
}

d("G5-B — activation and versioning", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("publishes the Freshline bundle with full provenance and deterministic identity", async () => {
        const result = await withTransaction(pool, (client) =>
            publishConfiguration(client, {
                bundle: FRESHLINE_BALI_V1,
                actorOrAuthority: ACTOR,
                sourceReference: SOURCE
            })
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const config = result.value.configuration;

        expect(result.value.findings).toEqual([]);
        expect(config.state).toBe("VALIDATED");
        expect(config.checksum).toBe(configurationChecksum(FRESHLINE_BALI_V1));
        expect(config.tenantId).toBe("freshline-bali");
        expect(config.marketId).toBe("bali");
        expect(config.environment).toBe("candidate");
        expect(config.configurationVersion).toBe(1);
        expect(config.predecessorVersion).toBeNull();
        expect(config.actorOrAuthority).toBe(ACTOR);
        expect(config.sourceReference).toBe(SOURCE);
        expect(config.createdAt).toBeInstanceOf(Date);
        expect(config.activatedAt).toBeNull();
    });

    it("a DRAFT/VALIDATED configuration cannot execute as active", async () => {
        const published = await withTransaction(pool, (client) =>
            publishConfiguration(client, {
                bundle: FRESHLINE_BALI_V1,
                actorOrAuthority: ACTOR,
                sourceReference: SOURCE
            })
        );
        if (!published.ok) throw new Error("publish failed");

        // Activation without approval is refused.
        const premature = await withTransaction(pool, (client) =>
            activateConfiguration(client, published.value.configuration.configurationId, ACTOR)
        );
        expect(premature.ok).toBe(false);
        if (!premature.ok) expect(premature.code).toBe("INVALID_TRANSITION");

        expect(await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE))).toBeNull();
    });

    it("an invalid configuration is recorded REJECTED and can never activate", async () => {
        const broken = cloneBundle(FRESHLINE_BALI_V1);
        broken.planes.OPERATIONS.lifecycle.customerConfirmationSeparate = false;

        const published = await withTransaction(pool, (client) =>
            publishConfiguration(client, {
                bundle: broken,
                actorOrAuthority: ACTOR,
                sourceReference: SOURCE
            })
        );
        expect(published.ok).toBe(true);
        if (!published.ok) return;
        expect(published.value.configuration.state).toBe("REJECTED");
        expect(published.value.findings.map((f) => f.code)).toContain(
            "CANONICAL_AUTHORITY_CONTRADICTION"
        );

        const approved = await withTransaction(pool, (client) =>
            approveConfiguration(client, published.value.configuration.configurationId, ACTOR)
        );
        expect(approved.ok).toBe(false);

        const activated = await withTransaction(pool, (client) =>
            activateConfiguration(client, published.value.configuration.configurationId, ACTOR)
        );
        expect(activated.ok).toBe(false);
        expect(await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE))).toBeNull();
    });

    it("approved configuration activates atomically and becomes queryable", async () => {
        const result = await activate(pool, FRESHLINE_BALI_V1);
        expect(result.activated.state).toBe("ACTIVE");
        expect(result.activated.activatedAt).toBeInstanceOf(Date);
        expect(result.superseded).toBeNull();

        const active = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        expect(active!.configurationVersion).toBe(1);
        expect(active!.checksum).toBe(configurationChecksum(FRESHLINE_BALI_V1));
        expect(active!.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(350000);
    });

    it("activating v2 supersedes v1, and only one is ever ACTIVE", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        const second = await activate(pool, v2());

        expect(second.activated.configurationVersion).toBe(2);
        expect(second.activated.predecessorVersion).toBe(1);
        expect(second.superseded!.configurationVersion).toBe(1);
        expect(second.superseded!.state).toBe("SUPERSEDED");

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_tenant_configuration WHERE state = 'ACTIVE'`
        );
        expect(Number(rows[0]!.n)).toBe(1);

        const active = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        expect(active!.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(375000);
    });

    it("a version cannot go backwards", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        await activate(pool, v2());

        const stale = cloneBundle(FRESHLINE_BALI_V1);
        stale.configurationVersion = 2;
        const republish = await withTransaction(pool, (client) =>
            publishConfiguration(client, {
                bundle: stale,
                actorOrAuthority: ACTOR,
                sourceReference: SOURCE
            })
        );
        expect(republish.ok).toBe(false);
    });

    it("a persisted bundle is immutable — the database refuses to rewrite it", async () => {
        const result = await activate(pool, FRESHLINE_BALI_V1);
        let rejected = false;
        try {
            await pool.query(
                `UPDATE core_tenant_configuration
                    SET bundle = jsonb_set(bundle, '{tenant,id}', '"other-tenant"')
                  WHERE configuration_id = $1`,
                [result.activated.configurationId]
            );
        } catch (err) {
            rejected = /immutable/i.test(err instanceof Error ? err.message : String(err));
        }
        expect(rejected).toBe(true);

        const active = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        expect(active!.bundle.tenant.id).toBe("freshline-bali");
    });
});

d("G5-B — rollback", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("restores a prior proven version without mutating history", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        await activate(pool, v2());

        const rolled = await withTransaction(pool, (client) =>
            rollbackToVersion(client, FRESHLINE_BALI_SCOPE, 1, ACTOR, "v2 priced incorrectly")
        );
        expect(rolled.ok).toBe(true);
        if (!rolled.ok) return;
        expect(rolled.value.activated.configurationVersion).toBe(1);
        expect(rolled.value.superseded!.configurationVersion).toBe(2);

        const active = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        expect(active!.configurationVersion).toBe(1);
        expect(active!.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(350000);

        // History is preserved, not rewritten: v2 still exists with its own
        // content and checksum, and the timeline shows the rollback happened.
        const v2Row = await withTransaction(pool, (c) => loadVersion(c, FRESHLINE_BALI_SCOPE, 2));
        expect(v2Row).not.toBeNull();
        expect(v2Row!.state).toBe("SUPERSEDED");
        expect(v2Row!.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(375000);
        expect(v2Row!.checksum).toBe(configurationChecksum(v2()));

        const history = await withTransaction(pool, (c) =>
            configurationHistory(c, FRESHLINE_BALI_SCOPE)
        );
        expect(history).toEqual([
            { configurationVersion: 1, fromState: "DRAFT", toState: "VALIDATED" },
            { configurationVersion: 1, fromState: "VALIDATED", toState: "APPROVED" },
            { configurationVersion: 1, fromState: "APPROVED", toState: "ACTIVE" },
            { configurationVersion: 2, fromState: "DRAFT", toState: "VALIDATED" },
            { configurationVersion: 2, fromState: "VALIDATED", toState: "APPROVED" },
            { configurationVersion: 1, fromState: "ACTIVE", toState: "SUPERSEDED" },
            { configurationVersion: 2, fromState: "APPROVED", toState: "ACTIVE" },
            { configurationVersion: 2, fromState: "ACTIVE", toState: "SUPERSEDED" },
            { configurationVersion: 1, fromState: "SUPERSEDED", toState: "ACTIVE" }
        ]);
    });

    it("cannot roll back to a version that was never proven", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        const broken = cloneBundle(FRESHLINE_BALI_V1);
        broken.configurationVersion = 2;
        broken.measurement.lineage.tenantRequired = false;
        await withTransaction(pool, (client) =>
            publishConfiguration(client, {
                bundle: broken,
                actorOrAuthority: ACTOR,
                sourceReference: SOURCE
            })
        );

        const rolled = await withTransaction(pool, (client) =>
            rollbackToVersion(client, FRESHLINE_BALI_SCOPE, 2, ACTOR, "attempt")
        );
        expect(rolled.ok).toBe(false);
        if (!rolled.ok) expect(rolled.code).toBe("INVALID_TRANSITION");

        const active = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        expect(active!.configurationVersion).toBe(1);
    });

    it("a historical version remains interpretable after rollback", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        await activate(pool, v2());
        await withTransaction(pool, (client) =>
            rollbackToVersion(client, FRESHLINE_BALI_SCOPE, 1, ACTOR, "rollback")
        );

        // A transaction governed by v2 can still be interpreted against v2.
        const historical = await withTransaction(pool, (c) => loadVersion(c, FRESHLINE_BALI_SCOPE, 2));
        expect(historical!.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(375000);
        expect(historical!.activatedAt).toBeInstanceOf(Date);
    });
});

d("G5-B — tenant isolation and inactive-capability inertness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    /** A second tenant in a different market, to prove isolation. */
    function otherTenant(): TenantConfigurationBundle {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.tenant = {
            id: "northbeam-saigon",
            organization: "northbeam",
            brand: "northbeam-barbering",
            market: "saigon",
            status: "ACTIVE_CANDIDATE"
        };
        b.planes.BRAND.name = "Northbeam Barbering";
        b.planes.BRAND.publicName = "Northbeam";
        b.planes.MARKET.id = "saigon";
        b.planes.MARKET.country = "VN";
        b.planes.MARKET.timezone = "Asia/Ho_Chi_Minh";
        b.planes.MARKET.currency = { price: "VND", display: "VND" };
        b.planes.MARKET.coverage.regions = ["District 1"];
        b.planes.COMMERCE.payment.currencies.priceCurrency = "VND";
        b.planes.COMMERCE.payment.currencies.displayCurrency = "VND";
        for (const item of [...b.planes.CATALOGUE.services, ...b.planes.CATALOGUE.extras]) {
            item.price.currency = "VND";
        }
        return b;
    }

    it("Freshline configuration cannot alter another tenant or market", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        await activate(pool, otherTenant());

        const freshline = await withTransaction(pool, (c) => activeConfiguration(c, FRESHLINE_BALI_SCOPE));
        const northbeam = await withTransaction(pool, (c) =>
            activeConfiguration(c, {
                tenantId: "northbeam-saigon",
                marketId: "saigon",
                environment: "candidate"
            })
        );

        expect(freshline!.bundle.planes.BRAND.name).toBe("Freshline Studio");
        expect(northbeam!.bundle.planes.BRAND.name).toBe("Northbeam Barbering");
        expect(freshline!.bundle.planes.MARKET.currency.price).toBe("IDR");
        expect(northbeam!.bundle.planes.MARKET.currency.price).toBe("VND");
        expect(freshline!.checksum).not.toBe(northbeam!.checksum);

        // Superseding Freshline leaves the other tenant untouched.
        await activate(pool, v2());
        const northbeamAfter = await withTransaction(pool, (c) =>
            activeConfiguration(c, {
                tenantId: "northbeam-saigon",
                marketId: "saigon",
                environment: "candidate"
            })
        );
        expect(northbeamAfter!.configurationVersion).toBe(1);
        expect(northbeamAfter!.checksum).toBe(northbeam!.checksum);
    });

    it("the Freshline catalogue does not leak globally", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        await activate(pool, otherTenant());

        const { rows } = await pool.query<{ tenant_id: string; codes: string[] }>(
            `SELECT tenant_id,
                    ARRAY(SELECT jsonb_array_elements(bundle->'planes'->'CATALOGUE'->'services')->>'code') AS codes
               FROM core_tenant_configuration WHERE state = 'ACTIVE' ORDER BY tenant_id`
        );
        // Each tenant's catalogue is scoped to its own configuration row; there
        // is no global catalogue table for one tenant to write into.
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.codes).toEqual(["FRESH_CUT", "FRESH_CUT_BEARD", "FULL_FRESH"]);
        }
        const currencies = await pool.query<{ tenant_id: string; currency: string }>(
            `SELECT tenant_id, bundle->'planes'->'MARKET'->'currency'->>'price' AS currency
               FROM core_tenant_configuration WHERE state = 'ACTIVE' ORDER BY tenant_id`
        );
        expect(currencies.rows.map((r) => r.currency).sort()).toEqual(["IDR", "VND"]);
    });

    it("inactive capabilities are inert in the activated configuration", async () => {
        const result = await activate(pool, FRESHLINE_BALI_V1);
        const commerce = result.activated.bundle.planes.COMMERCE;

        // Payment: ready, configured OFFLINE, and behaviorally inert.
        expect(commerce.payment.capability).toBe("READY");
        expect(commerce.payment.active).toBe(false);
        expect(commerce.payment.policy).toBe("OFFLINE");
        expect(commerce.payment.processorAdapter.configured).toBe(false);
        expect(commerce.payment.platformFeePolicy.active).toBe(false);
        expect(commerce.payment.currencies.chargeCurrency).toBeNull();
        expect(commerce.payment.currencies.settlementCurrency).toBeNull();

        // Dynamic pricing: prepared, inactive, carrying no rule that could bite.
        expect(commerce.locationDynamicPricing.prepared).toBe(true);
        expect(commerce.locationDynamicPricing.active).toBe(false);
        expect(commerce.locationDynamicPricing.rules).toEqual([]);

        // Rating/commission: unresolved and inactive.
        expect(
            result.activated.bundle.planes.EXPERIENCE.providerExperience.ratingCommission
        ).toEqual({ state: "UNRESOLVED", active: false });

        // The activated price is exactly the catalogue price: no fee, no
        // multiplier, nothing an inactive capability could have altered.
        expect(result.activated.bundle.planes.CATALOGUE.services[0]!.price.amount).toBe(350000);
    });

    it("tenant and market lineage is present on every stored configuration", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        const { rows } = await pool.query<{ tenant_id: string; market_id: string; n: string }>(
            `SELECT tenant_id, market_id, count(*)::text AS n
               FROM core_tenant_configuration GROUP BY tenant_id, market_id`
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.tenant_id).toBe("freshline-bali");
        expect(rows[0]!.market_id).toBe("bali");

        const events = await pool.query<{ tenant_id: string; market_id: string }>(
            `SELECT tenant_id, market_id FROM core_tenant_configuration_event`
        );
        expect(events.rows.length).toBeGreaterThan(0);
        for (const event of events.rows) {
            expect(event.tenant_id).toBe("freshline-bali");
            expect(event.market_id).toBe("bali");
        }
    });

    it("no configuration row derives authority from legacy appointments", async () => {
        await activate(pool, FRESHLINE_BALI_V1);
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_tenant_configuration
              WHERE bundle::text ILIKE '%appointments%'`
        );
        expect(Number(rows[0]!.n)).toBe(0);
    });

    it("a clean environment loads the same configuration deterministically", async () => {
        const first = await activate(pool, FRESHLINE_BALI_V1);
        const checksum = first.activated.checksum;

        // Wipe and reload from the same source bundle.
        await reset(pool);
        const second = await activate(pool, FRESHLINE_BALI_V1);
        expect(second.activated.checksum).toBe(checksum);
        expect(second.activated.bundle).toEqual(first.activated.bundle);
    });
});
