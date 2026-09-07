// G5-C — runtime spine: configuration resolution (R18), runtime consumption
// (R19), persistence, identity, adapters and observability.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, withTransaction } from "../../src/db/pool";
import {
    publishConfiguration,
    approveConfiguration,
    activateConfiguration,
    rollbackToVersion,
    activeConfiguration
} from "../../src/config/tenant/store";
import {
    FRESHLINE_BALI_V1,
    FRESHLINE_BALI_V2,
    cloneBundle
} from "../../src/config/tenant/freshline";
import { loadMarketConfig } from "../../src/config/marketConfig";
import { startRuntime } from "../../src/runtime/bootstrap";
import {
    resolveEffectiveConfiguration,
    resolveFromStored
} from "../../src/runtime/effectiveConfiguration";
import { runtimeEvidenceFor } from "../../src/runtime/evidence";
import { assertIdentityMatches } from "../../src/runtime/identity";
import { AdapterSpine } from "../../src/adapters/spine/adapter";
import { createRecordingTransport, createWhatsAppTransport } from "../../src/adapters/spine/transports";
import type { TenantConfigurationBundleV2 } from "../../src/config/tenant/contract";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

const ACTOR = "PTC/DRJ";
const SOURCE = "SCP-G5-C-01";
const SCOPE = { tenantId: "freshline-bali", marketId: "bali", environment: "candidate" };

async function reset(pool: Pool): Promise<void> {
    await pool.query(
        `TRUNCATE core_runtime_evidence, core_tenant_configuration_event, core_tenant_configuration
         RESTART IDENTITY CASCADE`
    );
}

async function activate(pool: Pool, bundle: unknown) {
    return withTransaction(pool, async (client) => {
        const published = await publishConfiguration(client, {
            bundle: bundle as never,
            actorOrAuthority: ACTOR,
            sourceReference: SOURCE
        });
        if (!published.ok) throw new Error(published.message);
        if (published.value.configuration.state !== "VALIDATED") {
            return { rejected: true as const, findings: published.value.findings };
        }
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
        return { rejected: false as const, activated: activated.value.activated };
    });
}

function v3From(mutate: (b: TenantConfigurationBundleV2) => void): TenantConfigurationBundleV2 {
    const b = cloneBundle(FRESHLINE_BALI_V2 as never) as unknown as TenantConfigurationBundleV2;
    b.configurationVersion = 3;
    mutate(b);
    return b;
}

d("G5-C / R18 — one canonical configuration ownership model", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("resolves exactly one timezone, currency and operating-hours authority", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const resolved = await withTransaction(pool, (c) => resolveEffectiveConfiguration(c, SCOPE));
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        const config = resolved.configuration;
        const canonical = loadMarketConfig("bali");

        // Timezone and currency come from the canonical market, and say so.
        expect(config.timezone).toEqual({ value: canonical.timezone, origin: "CANONICAL_MARKET" });
        expect(config.priceCurrency).toEqual({
            value: canonical.currency.code,
            origin: "CANONICAL_MARKET"
        });

        // Operating hours diverge, and the divergence is explicit rather than a
        // silent second authority. This is the exact R18 conflict, now resolved:
        // Core declares 09:00, the tenant declares an approved 08:00 override.
        expect(canonical.operatingHours.openingHour).toBe(9);
        expect(config.operatingHours).toEqual({
            value: { open: "08:00", close: "23:00" },
            origin: "APPROVED_OVERRIDE"
        });
    });

    it("a duplicate authoritative value is unrepresentable, not merely rejected", async () => {
        // Schema v2 has no field in which the tenant could restate these.
        const market = FRESHLINE_BALI_V2.planes.MARKET as unknown as Record<string, unknown>;
        expect(market["timezone"]).toBeUndefined();
        expect(market["currency"]).toBeUndefined();
        expect(market["operatingHours"]).toBeUndefined();
        expect(market["marketConfigurationRef"]).toBe("bali");

        // Attempting to reintroduce one is rejected by the closed schema.
        const smuggled = v3From((b) => {
            (b.planes.MARKET as unknown as Record<string, unknown>)["timezone"] = "Asia/Jakarta";
        });
        const result = await activate(pool, smuggled);
        expect(result.rejected).toBe(true);
        if (result.rejected) {
            expect(result.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
        }
    });

    it("approved overrides are deterministic and bounded", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const first = await withTransaction(pool, (c) => resolveEffectiveConfiguration(c, SCOPE));
        const second = await withTransaction(pool, (c) => resolveEffectiveConfiguration(c, SCOPE));
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.configuration.operatingHours).toEqual(first.configuration.operatingHours);

        // The override surface is exactly one declared field; nothing else can
        // be overridden, because nothing else is declared overridable.
        const overrides = FRESHLINE_BALI_V2.planes.MARKET.approvedOverrides;
        expect(Object.keys(overrides)).toEqual(["operatingHours"]);

        const bad = v3From((b) => {
            b.planes.MARKET.approvedOverrides.operatingHours = { daily: { open: "23:00", close: "08:00" } };
        });
        const result = await activate(pool, bad);
        expect(result.rejected).toBe(true);
        if (result.rejected) {
            expect(result.findings.map((f) => f.code)).toContain("OPERATING_HOURS_INVALID");
        }
    });

    it("no override yields the canonical value, attributed to the canonical market", async () => {
        const noOverride = v3From((b) => {
            b.planes.MARKET.approvedOverrides.operatingHours = null;
        });
        await activate(pool, FRESHLINE_BALI_V2);
        await activate(pool, noOverride);
        const resolved = await withTransaction(pool, (c) => resolveEffectiveConfiguration(c, SCOPE));
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.configuration.operatingHours).toEqual({
            value: { open: "09:00", close: "23:00" },
            origin: "CANONICAL_MARKET"
        });
    });

    it("catalogue prices are validated against the canonical market currency", async () => {
        const wrongCurrency = v3From((b) => {
            b.planes.CATALOGUE.services[0]!.price.currency = "USD";
        });
        const result = await activate(pool, wrongCurrency);
        expect(result.rejected).toBe(true);
        if (result.rejected) {
            expect(result.findings.map((f) => f.code)).toContain("PRICE_CURRENCY_MISMATCH");
        }
    });

    it("an unresolvable canonical market reference fails closed", async () => {
        const dangling = v3From((b) => {
            b.planes.MARKET.marketConfigurationRef = "atlantis";
        });
        const result = await activate(pool, dangling);
        expect(result.rejected).toBe(true);
        if (result.rejected) {
            expect(result.findings.map((f) => f.code)).toContain("MARKET_REFERENCE_UNRESOLVED");
        }
    });
});

d("G5-C / R19 — the runtime consumes the governed configuration", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("starts against the governed bundle and exposes its identity", async () => {
        const activated = await activate(pool, FRESHLINE_BALI_V2);
        expect(activated.rejected).toBe(false);
        if (activated.rejected) return;

        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        const runtime = started.runtime;
        expect(runtime.identity.tenantId).toBe("freshline-bali");
        expect(runtime.identity.organization).toBe("freshline");
        expect(runtime.identity.brand).toBe("freshline-studio");
        expect(runtime.identity.marketId).toBe("bali");
        expect(runtime.identity.environment).toBe("candidate");

        // The active configuration identity is inspectable.
        expect(runtime.configuration.provenance.configurationVersion).toBe(2);
        expect(runtime.configuration.provenance.checksum).toBe(activated.activated.checksum);
        expect(runtime.describe()).toContain("freshline-bali@bali/candidate v2");

        // Values come from the governed bundle, not from a hardcoded constant.
        expect(runtime.configuration.brandName).toBe("Freshline Studio");
        expect(runtime.configuration.catalogue.services.map((s) => s.code)).toEqual([
            "FRESH_CUT",
            "FRESH_CUT_BEARD",
            "FULL_FRESH"
        ]);
        expect(runtime.configuration.coverage.regions).toContain("Seminyak");
    });

    it("a controlled configuration-version change reaches the runtime with no Core change", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const before = await startRuntime({ pool, identity: SCOPE });
        expect(before.ok).toBe(true);
        if (!before.ok) return;
        expect(before.runtime.configuration.catalogue.services[0]!.price.amount).toBe(350000);
        expect(before.runtime.configuration.provenance.configurationVersion).toBe(2);

        // Publish and activate v3 with a different price. No code changes.
        const v3 = v3From((b) => {
            b.planes.CATALOGUE.services[0]!.price.amount = 375000;
        });
        await activate(pool, v3);

        const after = await startRuntime({ pool, identity: SCOPE });
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        expect(after.runtime.configuration.provenance.configurationVersion).toBe(3);
        expect(after.runtime.configuration.catalogue.services[0]!.price.amount).toBe(375000);
        expect(after.runtime.configuration.provenance.checksum).not.toBe(
            before.runtime.configuration.provenance.checksum
        );

        // And a rollback returns the runtime to the prior proven version.
        await withTransaction(pool, (c) => rollbackToVersion(c, SCOPE, 2, ACTOR, "revert price"));
        const rolled = await startRuntime({ pool, identity: SCOPE });
        expect(rolled.ok).toBe(true);
        if (!rolled.ok) return;
        expect(rolled.runtime.configuration.provenance.configurationVersion).toBe(2);
        expect(rolled.runtime.configuration.catalogue.services[0]!.price.amount).toBe(350000);
    });

    it("cold and repeated start resolve the same effective configuration", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const a = await startRuntime({ pool, identity: SCOPE });
        const b = await startRuntime({ pool, identity: SCOPE });
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(b.runtime.configuration.provenance.checksum).toBe(
            a.runtime.configuration.provenance.checksum
        );
        expect(b.runtime.configuration.operatingHours).toEqual(a.runtime.configuration.operatingHours);
        expect(b.runtime.configuration.timezone).toEqual(a.runtime.configuration.timezone);
    });

    it("refuses to start with no active configuration", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(false);
        if (!started.ok) expect(started.code).toBe("NO_ACTIVE_CONFIGURATION");
    });

    it("refuses a v1 bundle — it still restates canonical market values", async () => {
        const v1 = cloneBundle(FRESHLINE_BALI_V1);
        await activate(pool, v1);
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(false);
        if (!started.ok) {
            expect(started.code).toBe("CONFIGURATION_SCHEMA_UNSUPPORTED");
            expect(started.message).toContain("restates canonical market values");
        }
    });

    it("the stored configuration cannot be corrupted in the first place", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        // The G5-B immutability trigger refuses to let the checksum — or the
        // bundle — be rewritten, so the corruption this guard defends against
        // cannot be staged through the database at all.
        let rejected = false;
        try {
            await pool.query(
                `UPDATE core_tenant_configuration
                    SET checksum = repeat('a', 64) WHERE state = 'ACTIVE'`
            );
        } catch (err) {
            rejected = /immutable/i.test(err instanceof Error ? err.message : String(err));
        }
        expect(rejected).toBe(true);

        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
    });

    it("the checksum guard still refuses a row whose content and checksum disagree", async () => {
        // Defense-in-depth: exercised directly, because the database prevents
        // this state from being reached through the normal path.
        await activate(pool, FRESHLINE_BALI_V2);
        const stored = await withTransaction(pool, (c) => activeConfiguration(c, SCOPE));
        expect(stored).not.toBeNull();

        const tampered = { ...stored!, checksum: "a".repeat(64) };
        const resolved = resolveFromStored(tampered, SCOPE);
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) {
            expect(resolved.code).toBe("CONFIGURATION_CHECKSUM_MISMATCH");
        }

        // And a row describing a different tenant is refused too.
        const foreign = {
            ...stored!,
            bundle: { ...stored!.bundle, tenant: { ...stored!.bundle.tenant, id: "northbeam-saigon" } }
        };
        const mismatched = resolveFromStored(foreign as never, SCOPE);
        expect(mismatched.ok).toBe(false);
        if (!mismatched.ok) {
            expect(mismatched.code).toBe("CONFIGURATION_IDENTITY_MISMATCH");
        }
    });
});

d("G5-C — identity", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
        await activate(pool, FRESHLINE_BALI_V2);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("refuses to start when identity is not configured", async () => {
        for (const partial of [
            { marketId: "bali", environment: "candidate" },
            { tenantId: "freshline-bali", environment: "candidate" },
            { tenantId: "freshline-bali", marketId: "bali" },
            { tenantId: "  ", marketId: "bali", environment: "candidate" }
        ]) {
            const started = await startRuntime({ pool, identity: partial });
            expect(started.ok).toBe(false);
            if (!started.ok) expect(started.code).toBe("IDENTITY_NOT_CONFIGURED");
        }
    });

    it("refuses a cross-tenant or mismatched-market context", async () => {
        const wrongTenant = await startRuntime({
            pool,
            identity: { ...SCOPE, tenantId: "northbeam-saigon" }
        });
        expect(wrongTenant.ok).toBe(false);
        if (!wrongTenant.ok) expect(wrongTenant.code).toBe("NO_ACTIVE_CONFIGURATION");

        const wrongMarket = await startRuntime({ pool, identity: { ...SCOPE, marketId: "saigon" } });
        expect(wrongMarket.ok).toBe(false);

        const wrongEnv = await startRuntime({ pool, identity: { ...SCOPE, environment: "production" } });
        expect(wrongEnv.ok).toBe(false);
    });

    it("an untrusted claim cannot override the resolved identity", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        // A caller may assert; it may never set.
        expect(assertIdentityMatches(started.runtime.identity, { tenantId: "freshline-bali" }).ok).toBe(
            true
        );
        const spoofed = assertIdentityMatches(started.runtime.identity, {
            tenantId: "northbeam-saigon"
        });
        expect(spoofed.ok).toBe(false);
        if (!spoofed.ok) expect(spoofed.code).toBe("IDENTITY_MISMATCH");

        const wrongEnv = assertIdentityMatches(started.runtime.identity, { environment: "production" });
        expect(wrongEnv.ok).toBe(false);
        if (!wrongEnv.ok) expect(wrongEnv.code).toBe("ENVIRONMENT_MISMATCH");
    });

    it("identity lineage reaches every runtime evidence row", async () => {
        await startRuntime({ pool, identity: SCOPE });
        const evidence = await withTransaction(pool, (c) => runtimeEvidenceFor(c, SCOPE));
        expect(evidence.length).toBeGreaterThan(0);
        for (const row of evidence) {
            expect(row.tenantId).toBe("freshline-bali");
            expect(row.marketId).toBe("bali");
            expect(row.environment).toBe("candidate");
        }
        expect(evidence.map((e) => e.kind)).toEqual([
            "PERSISTENCE_VERIFIED",
            "IDENTITY_RESOLVED",
            "CONFIGURATION_RESOLVED",
            "RUNTIME_START"
        ]);
        const resolvedConfig = evidence.find((e) => e.kind === "CONFIGURATION_RESOLVED")!;
        expect(resolvedConfig.configurationVersion).toBe(2);
        expect(resolvedConfig.configurationChecksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a refused startup still leaves attributable evidence", async () => {
        await pool.query(`UPDATE core_tenant_configuration SET state = 'SUPERSEDED', superseded_at = now() WHERE state = 'ACTIVE'`);
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(false);
        const evidence = await withTransaction(pool, (c) => runtimeEvidenceFor(c, SCOPE));
        const refusal = evidence.find((e) => e.kind === "CONFIGURATION_REFUSED");
        expect(refusal).toBeDefined();
        expect(refusal!.outcome).toBe("REFUSED");
        expect(refusal!.reasonCode).toBe("NO_ACTIVE_CONFIGURATION");
    });
});

d("G5-C — persistence", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("verifies required schema and names legacy relations as non-authoritative", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        expect(started.runtime.schema.ok).toBe(true);
        expect(started.runtime.schema.missing).toEqual([]);
        expect(started.runtime.schema.present).toContain("core_service_request");
        expect(started.runtime.schema.present).toContain("core_tenant_configuration");
        // `appointments` exists but is explicitly recorded as non-authoritative.
        expect(started.runtime.schema.legacyPresentButNonAuthoritative).toContain("appointments");
        expect(started.runtime.schema.present).not.toContain("appointments");
    });

    it("authoritative configuration survives a process restart", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const first = await startRuntime({ pool, identity: SCOPE });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        await pool.end();

        // A brand new pool stands in for a restarted process.
        const restarted = createPool({});
        const second = await startRuntime({ pool: restarted, identity: SCOPE });
        expect(second.ok).toBe(true);
        if (second.ok) {
            expect(second.runtime.configuration.provenance.checksum).toBe(
                first.runtime.configuration.provenance.checksum
            );
            expect(second.runtime.configuration.provenance.configurationVersion).toBe(2);
        }
        const stillActive = await withTransaction(restarted, (c) => activeConfiguration(c, SCOPE));
        expect(stillActive!.configurationVersion).toBe(2);
        await restarted.end();
        pool = createPool({});
    });

    it("repeated startup does not duplicate authoritative configuration records", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        for (let i = 0; i < 5; i++) {
            await startRuntime({ pool, identity: SCOPE });
        }
        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_tenant_configuration`
        );
        expect(Number(rows[0]!.n)).toBe(1);
        const active = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_tenant_configuration WHERE state = 'ACTIVE'`
        );
        expect(Number(active.rows[0]!.n)).toBe(1);
    });

    it("legacy appointments cannot become canonical authority for the runtime", async () => {
        await activate(pool, FRESHLINE_BALI_V2);
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        // The runtime's required-relation set does not include it, and the
        // effective configuration contains no reference to it.
        expect(JSON.stringify(started.runtime.configuration)).not.toMatch(/appointments/i);
    });
});

d("G5-C — adapter spine", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
        await activate(pool, FRESHLINE_BALI_V2);
    });
    afterAll(async () => {
        await pool?.end();
    });

    const context = {
        correlationId: "corr-1",
        idempotencyKey: "idem-1",
        lineage: SCOPE
    };
    const message = { channel: "TEST", recipientHandle: "+62800", body: "hello" };

    it("transport success does not itself advance canonical state", async () => {
        const recorder = createRecordingTransport("TEST");
        const spine = new AdapterSpine().register(recorder);
        const result = await spine.send("TEST", context, message);
        expect(result.transported).toBe(true);
        expect(result.advancesCanonicalState).toBe(false);
        expect(recorder.sent).toHaveLength(1);

        // Nothing in SCP moved.
        const requests = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(requests.rows[0]!.n)).toBe(0);
    });

    it("adapter failure does not imply state success", async () => {
        const spine = new AdapterSpine().register(
            createRecordingTransport("TEST", {
                fail: { code: "TRANSPORT_TIMEOUT", message: "upstream timed out" }
            })
        );
        const result = await spine.send("TEST", context, message);
        expect(result.transported).toBe(false);
        expect(result.advancesCanonicalState).toBe(false);
        if (!result.transported) expect(result.code).toBe("TRANSPORT_TIMEOUT");
    });

    it("requires correlation, idempotency and tenant lineage", async () => {
        const spine = new AdapterSpine().register(createRecordingTransport("TEST"));
        const incomplete = await spine.send(
            "TEST",
            { correlationId: "", idempotencyKey: "", lineage: { tenantId: "", marketId: "", environment: "" } },
            message
        );
        expect(incomplete.transported).toBe(false);
        if (!incomplete.transported) {
            expect(incomplete.code).toBe("CONTEXT_INCOMPLETE");
            expect(incomplete.message).toContain("correlationId");
            expect(incomplete.message).toContain("lineage.tenantId");
        }
    });

    it("WhatsApp remains non-authoritative and inactive in G5-C", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        expect(started.runtime.adapters.channels()).toEqual(["WHATSAPP"]);

        const result = await started.runtime.adapters.send("WHATSAPP", context, {
            ...message,
            channel: "WHATSAPP"
        });
        expect(result.transported).toBe(false);
        expect(result.advancesCanonicalState).toBe(false);
        if (!result.transported) expect(result.code).toBe("ADAPTER_NOT_CONFIGURED");

        // And the configuration still says the channel never owns state.
        expect(
            started.runtime.configuration.experience.channels.whatsapp.authoritativeStateOwner
        ).toBe(false);
    });

    it("substituting a fake transport changes nothing about Core truth semantics", async () => {
        const real = new AdapterSpine().register(createWhatsAppTransport({ enabled: false }));
        const fake = new AdapterSpine().register(createRecordingTransport("WHATSAPP"));

        const realResult = await real.send("WHATSAPP", context, { ...message, channel: "WHATSAPP" });
        const fakeResult = await fake.send("WHATSAPP", context, { ...message, channel: "WHATSAPP" });

        // Different transport outcomes...
        expect(realResult.transported).toBe(false);
        expect(fakeResult.transported).toBe(true);
        // ...identical (non-)authority.
        expect(realResult.advancesCanonicalState).toBe(false);
        expect(fakeResult.advancesCanonicalState).toBe(false);

        const requests = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_service_request`
        );
        expect(Number(requests.rows[0]!.n)).toBe(0);
    });
});

d("G5-C — commerce capabilities remain inactive", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = createPool({});
        await reset(pool);
        await activate(pool, FRESHLINE_BALI_V2);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("payment stays READY + inactive + OFFLINE through the runtime", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        const payment = started.runtime.configuration.commerce.payment;
        expect(payment.capability).toBe("READY");
        expect(payment.active).toBe(false);
        expect(payment.policy).toBe("OFFLINE");
        expect(payment.processorAdapter.configured).toBe(false);
        expect(payment.platformFeePolicy.active).toBe(false);
        expect(payment.currencies.chargeCurrency).toBeNull();
        expect(payment.currencies.settlementCurrency).toBeNull();
    });

    it("dynamic pricing stays inactive and rule-free", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        const pricing = started.runtime.configuration.commerce.locationDynamicPricing;
        expect(pricing.prepared).toBe(true);
        expect(pricing.active).toBe(false);
        expect(pricing.rules).toEqual([]);

        // The resolved catalogue price is exactly the configured price.
        expect(started.runtime.configuration.catalogue.services[0]!.price.amount).toBe(350000);
    });

    it("measurement lineage remains mandatory in the resolved configuration", async () => {
        const started = await startRuntime({ pool, identity: SCOPE });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        expect(started.runtime.configuration.measurement.lineage).toEqual({
            tenantRequired: true,
            marketRequired: true
        });
        expect(started.runtime.configuration.measurement.reporting.mayOwnBusinessTruth).toBe(false);
        expect(started.runtime.configuration.measurement.canonicalSource).toBe(
            "SCP_EVENTS_AND_RECORDS"
        );
    });
});
