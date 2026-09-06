// G5-B — schema, validation, payment policy and reproducibility.
// No database.

import { describe, expect, it } from "vitest";
import {
    CONFIGURATION_PLANES,
    TENANT_CONFIG_SCHEMA_VERSION,
    type TenantConfigurationBundle
} from "../../src/config/tenant/contract";
import { validateTenantConfiguration } from "../../src/config/tenant/validate";
import {
    canonicalBundleJson,
    configurationChecksum,
    configurationReference,
    bundlesAreIdentical
} from "../../src/config/tenant/identity";
import {
    FRESHLINE_BALI_V1,
    cloneBundle,
    validateFreshline
} from "../../src/config/tenant/freshline";

const codesOf = (bundle: TenantConfigurationBundle) =>
    validateTenantConfiguration(bundle).findings.map((f) => f.code);

describe("G5-B — the Freshline bundle is schema-valid and complete", () => {
    it("passes validation as authored", () => {
        const result = validateFreshline();
        expect(result.findings).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it("declares all six configuration planes explicitly", () => {
        for (const plane of CONFIGURATION_PLANES) {
            expect(FRESHLINE_BALI_V1.planes[plane]).toBeDefined();
        }
        expect(Object.keys(FRESHLINE_BALI_V1.planes).sort()).toEqual([...CONFIGURATION_PLANES].sort());
    });

    it("carries stable tenant and market identity", () => {
        expect(FRESHLINE_BALI_V1.tenant.id).toBe("freshline-bali");
        expect(FRESHLINE_BALI_V1.tenant.organization).toBe("freshline");
        expect(FRESHLINE_BALI_V1.tenant.brand).toBe("freshline-studio");
        expect(FRESHLINE_BALI_V1.tenant.market).toBe("bali");
        expect(FRESHLINE_BALI_V1.planes.MARKET.id).toBe(FRESHLINE_BALI_V1.tenant.market);
        expect(FRESHLINE_BALI_V1.schemaVersion).toBe(TENANT_CONFIG_SCHEMA_VERSION);
    });

    it("represents the accepted catalogue, prices and codes", () => {
        const services = FRESHLINE_BALI_V1.planes.CATALOGUE.services;
        expect(services.map((s) => [s.code, s.price.amount])).toEqual([
            ["FRESH_CUT", 350000],
            ["FRESH_CUT_BEARD", 450000],
            ["FULL_FRESH", 550000]
        ]);
        const extras = FRESHLINE_BALI_V1.planes.CATALOGUE.extras;
        expect(extras.map((e) => [e.code, e.price.amount])).toEqual([
            ["FOOT_MASSAGE", 200000],
            ["BACK_SHOULDER_MASSAGE", 250000],
            ["FULL_BODY_MASSAGE", 350000]
        ]);
        // Every price is currency-bound, and codes carry identity, not names.
        for (const item of [...services, ...extras]) {
            expect(item.price.currency).toBe("IDR");
            expect(item.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
    });

    it("represents operating hours, regions and locale policy", () => {
        const market = FRESHLINE_BALI_V1.planes.MARKET;
        expect(market.operatingHours.daily).toEqual({ open: "08:00", close: "23:00" });
        expect(market.timezone).toBe("Asia/Makassar");
        expect(market.coverage.regions).toContain("Seminyak");
        expect(market.coverage.regions).toHaveLength(9);
        expect(market.localeDefault).toBe("en");
        expect(market.supportedLocales).toEqual(["en", "id"]);
    });

    it("declares which values are CC-supplied engineering assumptions", () => {
        // G5A-G09: durations are required for exclusive capacity but were not in
        // the accepted-behavior freeze. They must be visibly flagged, not
        // silently naturalized into the configuration.
        const meta = FRESHLINE_BALI_V1._meta;
        expect(meta).toBeDefined();
        expect(meta!.ccSuppliedValues.join(" ")).toMatch(/durationMinutes/);
        expect(meta!.ccSuppliedValues.join(" ")).toMatch(/confirmed by a human/i);
    });
});

describe("G5-B — validation rejects malformed configuration", () => {
    it("fails a missing tenant", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        (b as { tenant: unknown }).tenant = { id: "", organization: "", brand: "", market: "", status: "" };
        expect(codesOf(b)).toContain("TENANT_REQUIRED");
    });

    it("fails an invalid market", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.MARKET.id = "atlantis";
        expect(codesOf(b)).toContain("MARKET_INVALID");
        const c = cloneBundle(FRESHLINE_BALI_V1);
        c.planes.MARKET.country = "IDN";
        expect(codesOf(c)).toContain("MARKET_INVALID");
    });

    it("fails an invalid currency", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.MARKET.currency.price = "RUPIAH";
        expect(codesOf(b)).toContain("CURRENCY_INVALID");
    });

    it("fails a duplicate service code", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.CATALOGUE.services[1]!.code = "FRESH_CUT";
        expect(codesOf(b)).toContain("DUPLICATE_SERVICE_CODE");
    });

    it("fails a duplicate extra code", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.CATALOGUE.extras[2]!.code = "FOOT_MASSAGE";
        expect(codesOf(b)).toContain("DUPLICATE_EXTRA_CODE");
    });

    it("fails malformed operating hours", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.MARKET.operatingHours.daily.close = "25:00";
        expect(codesOf(b)).toContain("OPERATING_HOURS_INVALID");
        const c = cloneBundle(FRESHLINE_BALI_V1);
        c.planes.MARKET.operatingHours.daily = { open: "23:00", close: "08:00" };
        expect(codesOf(c)).toContain("OPERATING_HOURS_INVALID");
    });

    it("fails a negative or uncurrencied price", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.CATALOGUE.services[0]!.price.amount = -1;
        expect(codesOf(b)).toContain("PRICE_INVALID");
        const c = cloneBundle(FRESHLINE_BALI_V1);
        c.planes.CATALOGUE.services[0]!.price.currency = "USD";
        expect(codesOf(c)).toContain("PRICE_CURRENCY_MISMATCH");
    });

    it("fails a missing service duration — capacity semantics require one", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        delete (b.planes.CATALOGUE.services[0] as { durationMinutes?: number }).durationMinutes;
        expect(codesOf(b)).toContain("SERVICE_DURATION_INVALID");
    });

    it("fails a missing plane", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        delete (b.planes as { COMMERCE?: unknown }).COMMERCE;
        expect(codesOf(b)).toContain("PLANE_MISSING");
    });
});

describe("G5-B — canonical authority cannot be configured away", () => {
    it("fails when provider acceptance is claimed to assign", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.OPERATIONS.lifecycle.providerAcceptanceDoesNotAssign = false;
        expect(codesOf(b)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");
    });

    it("fails when owner assignment or customer confirmation is collapsed", () => {
        for (const field of ["ownerAssignmentRequired", "customerConfirmationSeparate"] as const) {
            const b = cloneBundle(FRESHLINE_BALI_V1);
            b.planes.OPERATIONS.lifecycle[field] = false;
            expect(codesOf(b)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");
        }
    });

    it("fails when approval, non-overlap or amendment requirements are switched off", () => {
        const a = cloneBundle(FRESHLINE_BALI_V1);
        a.planes.OPERATIONS.provider.approvalRequired = false;
        expect(codesOf(a)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");

        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.OPERATIONS.scheduling.nonOverlapRequired = false;
        expect(codesOf(b)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");

        const c = cloneBundle(FRESHLINE_BALI_V1);
        c.planes.OPERATIONS.recovery.amendmentRequiredForCustomerCommitmentChange = false;
        expect(codesOf(c)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");
    });

    it("fails when a channel claims to own state", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.EXPERIENCE.channels.whatsapp.authoritativeStateOwner = true;
        expect(codesOf(b)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");
    });

    it("fails when measurement lineage is disabled", () => {
        for (const field of ["tenantRequired", "marketRequired"] as const) {
            const b = cloneBundle(FRESHLINE_BALI_V1);
            b.measurement.lineage[field] = false;
            expect(codesOf(b)).toContain("MEASUREMENT_LINEAGE_DISABLED");
        }
    });

    it("fails when a projection claims business truth", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.measurement.reporting.mayOwnBusinessTruth = true;
        expect(codesOf(b)).toContain("PROJECTION_AUTHORITY_VIOLATION");
    });

    it("fails a CLAD-specific inferred-state attempt", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.measurement.cladConstraints.cladSpecificInferredStatesInScpCore = true;
        expect(codesOf(b)).toContain("CLAD_CONSTRAINT_VIOLATION");

        // And a smuggled field anywhere in the bundle is rejected outright.
        const c = cloneBundle(FRESHLINE_BALI_V1) as unknown as Record<string, unknown>;
        (c["planes"] as Record<string, Record<string, unknown>>)["EXPERIENCE"]![
            "customerPsychologicalProfile"
        ] = { openness: 0.8 };
        expect(codesOf(c as unknown as TenantConfigurationBundle)).toContain(
            "CLAD_CONSTRAINT_VIOLATION"
        );

        const d = cloneBundle(FRESHLINE_BALI_V1) as unknown as Record<string, unknown>;
        (d["planes"] as Record<string, Record<string, unknown>>)["OPERATIONS"]![
            "cladInferredIntent"
        ] = "LOYAL";
        expect(codesOf(d as unknown as TenantConfigurationBundle)).toContain(
            "CLAD_CONSTRAINT_VIOLATION"
        );
    });

    it("fails a configuration naming legacy appointments as canonical authority", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1) as unknown as Record<string, unknown>;
        (b["measurement"] as Record<string, unknown>)["canonicalSourceNote"] =
            "legacy appointments table is the authoritative source of truth";
        expect(codesOf(b as unknown as TenantConfigurationBundle)).toContain(
            "LEGACY_AUTHORITY_REFERENCE"
        );
    });
});

describe("G5-B — payment policy", () => {
    it("READY + inactive + OFFLINE passes", () => {
        const payment = FRESHLINE_BALI_V1.planes.COMMERCE.payment;
        expect(payment.capability).toBe("READY");
        expect(payment.active).toBe(false);
        expect(payment.policy).toBe("OFFLINE");
        expect(validateFreshline().valid).toBe(true);
    });

    it("an OFFLINE policy cannot be active", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.COMMERCE.payment.active = true;
        expect(codesOf(b)).toContain("PAYMENT_POLICY_INCOHERENT");
    });

    it("inactive payment cannot carry a configured processor or an active fee policy", () => {
        const a = cloneBundle(FRESHLINE_BALI_V1);
        a.planes.COMMERCE.payment.processorAdapter.configured = true;
        expect(codesOf(a)).toContain("INACTIVE_PAYMENT_NOT_INERT");

        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.COMMERCE.payment.platformFeePolicy.active = true;
        expect(codesOf(b)).toContain("INACTIVE_PAYMENT_NOT_INERT");
    });

    it("charge and settlement currencies stay null while payment is inactive", () => {
        expect(FRESHLINE_BALI_V1.planes.COMMERCE.payment.currencies.chargeCurrency).toBeNull();
        expect(FRESHLINE_BALI_V1.planes.COMMERCE.payment.currencies.settlementCurrency).toBeNull();

        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.COMMERCE.payment.currencies.chargeCurrency = "IDR";
        expect(codesOf(b)).toContain("INACTIVE_PAYMENT_NOT_INERT");
    });

    it("the financial audit boundary is mandatory and payment-ready seams are reserved", () => {
        const payment = FRESHLINE_BALI_V1.planes.COMMERCE.payment;
        expect(payment.financialAuditBoundary.required).toBe(true);
        expect(payment.processorAdapter.contractReserved).toBe(true);
        expect(payment.platformFeePolicy.shapeReserved).toBe(true);

        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.COMMERCE.payment.financialAuditBoundary.required = false;
        expect(codesOf(b)).toContain("AUDIT_BOUNDARY_REQUIRED");
    });

    it("inactive dynamic pricing cannot contain a pricing rule", () => {
        const dynamic = FRESHLINE_BALI_V1.planes.COMMERCE.locationDynamicPricing;
        expect(dynamic.prepared).toBe(true);
        expect(dynamic.active).toBe(false);
        expect(dynamic.rules).toEqual([]);

        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.COMMERCE.locationDynamicPricing.rules = [{ region: "Seminyak", multiplier: 1.2 }];
        expect(codesOf(b)).toContain("INACTIVE_PRICING_NOT_INERT");
    });

    it("an unresolved rating/commission capability cannot be active", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.EXPERIENCE.providerExperience.ratingCommission.active = true;
        expect(codesOf(b)).toContain("INACTIVE_CAPABILITY_NOT_INERT");
    });
});

describe("G5-B — reproducibility", () => {
    it("the same configuration yields the same deterministic identity", () => {
        const a = configurationChecksum(FRESHLINE_BALI_V1);
        const b = configurationChecksum(cloneBundle(FRESHLINE_BALI_V1));
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("key ordering is not a configuration change", () => {
        // Genuinely rebuild every object with its keys in reverse order, so the
        // clone differs only in insertion order and in nothing else.
        const reverseKeys = (node: unknown): unknown => {
            if (node === null || typeof node !== "object") return node;
            if (Array.isArray(node)) return node.map(reverseKeys);
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(node as Record<string, unknown>).reverse()) {
                out[key] = reverseKeys((node as Record<string, unknown>)[key]);
            }
            return out;
        };
        const reordered = reverseKeys(FRESHLINE_BALI_V1) as TenantConfigurationBundle;
        expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(FRESHLINE_BALI_V1));
        expect(canonicalBundleJson(reordered)).toBe(canonicalBundleJson(FRESHLINE_BALI_V1));
        expect(configurationChecksum(reordered)).toBe(configurationChecksum(FRESHLINE_BALI_V1));
    });

    it("catalogue ORDER is semantically meaningful and does change identity", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        const [first, second, third] = b.planes.CATALOGUE.services;
        b.planes.CATALOGUE.services = [second!, first!, third!];
        expect(configurationChecksum(b)).not.toBe(configurationChecksum(FRESHLINE_BALI_V1));
    });

    it("any material change changes the identity", () => {
        const original = configurationChecksum(FRESHLINE_BALI_V1);
        const price = cloneBundle(FRESHLINE_BALI_V1);
        price.planes.CATALOGUE.services[0]!.price.amount = 360000;
        expect(configurationChecksum(price)).not.toBe(original);

        const tenant = cloneBundle(FRESHLINE_BALI_V1);
        tenant.tenant.id = "freshline-bangkok";
        expect(configurationChecksum(tenant)).not.toBe(original);

        expect(bundlesAreIdentical(FRESHLINE_BALI_V1, cloneBundle(FRESHLINE_BALI_V1))).toBe(true);
        expect(bundlesAreIdentical(FRESHLINE_BALI_V1, price)).toBe(false);
    });

    it("produces a stable human-readable reference", () => {
        expect(configurationReference(FRESHLINE_BALI_V1)).toBe(
            "freshline-bali@bali/candidate#v1"
        );
    });
});

// =============================================================================
// SCP-G5-B-CORR-01 — corrections proven by DTS
// =============================================================================

describe("CORR-01 — CLAD/Core separation is a closed schema, not a denylist", () => {
    const withField = (mutate: (b: TenantConfigurationBundle) => void) => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        mutate(b);
        return validateTenantConfiguration(b);
    };

    // The exact fields DTS smuggled past the old fixed token list.
    it("rejects commitmentStrength", () => {
        const r = withField((b) => {
            (b.planes.OPERATIONS as unknown as Record<string, unknown>)["commitmentStrength"] = 0.9;
        });
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
    });

    it("rejects inferredConfidence", () => {
        const r = withField((b) => {
            (b.planes.EXPERIENCE as unknown as Record<string, unknown>)["inferredConfidence"] = 0.7;
        });
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
    });

    it("rejects learningQuality at the top level", () => {
        const r = withField((b) => {
            (b as unknown as Record<string, unknown>)["learningQuality"] = "HIGH";
        });
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
    });

    it("rejects learningQuality nested four levels deep", () => {
        const r = withField((b) => {
            (b.planes.EXPERIENCE.provider.bilingual as unknown as Record<string, unknown>)[
                "learningQuality"
            ] = "HIGH";
        });
        expect(r.valid).toBe(false);
        const finding = r.findings.find((f) => f.code === "UNDECLARED_FIELD");
        expect(finding!.path).toBe("planes.EXPERIENCE.provider.bilingual.learningQuality");
    });

    it("rejects every representative CLAD-adjacent inferred/profiling field", () => {
        const smuggled: Array<[string, (b: TenantConfigurationBundle) => void]> = [
            ["psychologicalProfile", (b) => set(b.planes.EXPERIENCE.customer, "psychologicalProfile", {})],
            ["emotionalState", (b) => set(b.planes.EXPERIENCE.customer, "emotionalState", "CALM")],
            ["behaviorPrediction", (b) => set(b.planes.OPERATIONS, "behaviorPrediction", "LIKELY")],
            ["customerSentiment", (b) => set(b.measurement, "customerSentiment", 0.5)],
            ["userProfile", (b) => set(b.planes.BRAND, "userProfile", {})],
            ["engagementScore", (b) => set(b.planes.MARKET, "engagementScore", 42)],
            // Names nobody put on any list — the point of an allowlist.
            ["loyaltyPropensityIndex", (b) => set(b.planes.OPERATIONS, "loyaltyPropensityIndex", 3)],
            ["churnRisk", (b) => set(b.planes.MARKET, "churnRisk", "LOW")],
            ["adaptationSignal", (b) => set(b.measurement, "adaptationSignal", 1)]
        ];
        for (const [name, mutate] of smuggled) {
            const r = withField(mutate);
            expect(r.valid, `${name} must be rejected`).toBe(false);
            expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
        }
    });

    it("rejects an undeclared field even inside an inactive capability", () => {
        const r = withField((b) => {
            set(b.planes.COMMERCE.locationDynamicPricing, "inferredDemandCurve", [1, 2, 3]);
        });
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
    });

    // Positive controls: the declared boundary must keep working.
    it("accepts the canonical bundle with measurement.cladConstraints", () => {
        expect(FRESHLINE_BALI_V1.measurement.cladConstraints).toEqual({
            cladSpecificInferredStatesInScpCore: false,
            psychologicalProfileFields: false,
            transactionalAuthority: false
        });
        expect(validateFreshline().valid).toBe(true);
    });

    it("accepts the canonical bundle with measurement.projectionBoundaries", () => {
        expect(FRESHLINE_BALI_V1.measurement.projectionBoundaries["cladStar"]).toBe(
            "FUTURE_GOVERNED_EVIDENCE_INTERPRETATION_ONLY"
        );
        expect(validateFreshline().valid).toBe(true);
    });

    it("a projection boundary can never become an authority grant", () => {
        const r = withField((b) => {
            b.measurement.projectionBoundaries["cladStar"] = "AUTHORITATIVE";
        });
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("VALUE_NOT_PERMITTED");
    });

    it("does NOT over-block ordinary text that happens to mention psychology", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        b.planes.BRAND.tagline = "A haircut is emotional. Your personality, your Freshline.";
        b.planes.MARKET.coverage.regions = [...b.planes.MARKET.coverage.regions, "Sentiment Bay"];
        b.planes.EXPERIENCE.providerExperience.displayIdPrefixes["PS"] = "Psychology-informed stylist";
        // Values, not schema fields: no inferred state is created, so these pass.
        expect(validateTenantConfiguration(b).valid).toBe(true);
    });
});

describe("CORR-02 — every load-bearing authority flag is an executable invariant", () => {
    const REQUIRED_FLAGS: Array<[string, (b: TenantConfigurationBundle) => void]> = [
        ["provider.approvalRequired", (b) => (b.planes.OPERATIONS.provider.approvalRequired = false)],
        [
            "provider.ownerConfirmedAvailabilityRequired",
            (b) => (b.planes.OPERATIONS.provider.ownerConfirmedAvailabilityRequired = false)
        ],
        [
            "provider.strictEligibilityRequired",
            (b) => (b.planes.OPERATIONS.provider.strictEligibilityRequired = false)
        ],
        [
            "lifecycle.providerAcceptanceDoesNotAssign",
            (b) => (b.planes.OPERATIONS.lifecycle.providerAcceptanceDoesNotAssign = false)
        ],
        [
            "lifecycle.ownerAssignmentRequired",
            (b) => (b.planes.OPERATIONS.lifecycle.ownerAssignmentRequired = false)
        ],
        [
            "lifecycle.customerConfirmationSeparate",
            (b) => (b.planes.OPERATIONS.lifecycle.customerConfirmationSeparate = false)
        ],
        [
            "scheduling.nonOverlapRequired",
            (b) => (b.planes.OPERATIONS.scheduling.nonOverlapRequired = false)
        ],
        [
            "recovery.amendmentRequiredForCustomerCommitmentChange",
            (b) => (b.planes.OPERATIONS.recovery.amendmentRequiredForCustomerCommitmentChange = false)
        ]
    ];

    it("rejects every required invariant set to false", () => {
        for (const [name, mutate] of REQUIRED_FLAGS) {
            const b = cloneBundle(FRESHLINE_BALI_V1);
            mutate(b);
            const r = validateTenantConfiguration(b);
            expect(r.valid, `${name}=false must be rejected`).toBe(false);
            expect(r.findings.map((f) => f.code)).toContain("CANONICAL_AUTHORITY_CONTRADICTION");
        }
    });

    it("rejects a required invariant that has been REMOVED", () => {
        for (const [name, mutate] of REQUIRED_FLAGS) {
            const b = cloneBundle(FRESHLINE_BALI_V1);
            mutate(b); // navigate to the right object, then delete the key
            const path = name.split(".");
            const parent = (b.planes.OPERATIONS as unknown as Record<string, Record<string, unknown>>)[
                path[0]!
            ]!;
            delete parent[path[1]!];
            const r = validateTenantConfiguration(b);
            expect(r.valid, `${name} removed must be rejected`).toBe(false);
            expect(r.findings.map((f) => f.code)).toContain("MISSING_REQUIRED_FIELD");
        }
    });

    it("rejects an attempt to override an invariant through an alternate path", () => {
        const b = cloneBundle(FRESHLINE_BALI_V1);
        set(b.planes.OPERATIONS.provider, "ownerConfirmedAvailabilityOverride", true);
        const r = validateTenantConfiguration(b);
        expect(r.valid).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain("UNDECLARED_FIELD");
    });

    it("still accepts the canonical bundle with all invariants true", () => {
        const operations = FRESHLINE_BALI_V1.planes.OPERATIONS;
        expect(operations.provider.approvalRequired).toBe(true);
        expect(operations.provider.ownerConfirmedAvailabilityRequired).toBe(true);
        expect(operations.provider.strictEligibilityRequired).toBe(true);
        expect(operations.lifecycle.providerAcceptanceDoesNotAssign).toBe(true);
        expect(operations.lifecycle.ownerAssignmentRequired).toBe(true);
        expect(operations.lifecycle.customerConfirmationSeparate).toBe(true);
        expect(operations.scheduling.nonOverlapRequired).toBe(true);
        expect(operations.recovery.amendmentRequiredForCustomerCommitmentChange).toBe(true);
        expect(validateFreshline().valid).toBe(true);
    });
});

function set(target: unknown, key: string, value: unknown): void {
    (target as Record<string, unknown>)[key] = value;
}
