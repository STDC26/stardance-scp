// LAB-INFRA-01B — proof for the deployment identity boundary and the UAT lineage
// derivation. Both are governance surfaces: one decides who a process claims to
// be, the other decides what a UAT run is allowed to differ by.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    DeploymentIdentityError,
    isGovernedEnvironment,
    resolveDeploymentIdentity,
    type DeploymentIdentityRefusalCode
} from "../../src/runtime/deploymentIdentity";
import { getActiveMarketConfig, MarketSelectionError } from "../../src/config/marketConfig";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { deriveUatBundle, FRESHLINE_UAT_LINEAGE } from "../../src/config/tenant/uat";

const UAT_ENV = {
    SCP_TENANT_ID: "freshline-uat",
    ACTIVE_MARKET: "bali",
    SCP_ENVIRONMENT: "uat"
} as NodeJS.ProcessEnv;

/** The refusal code, so assertions read on the machine-observable reason. */
function codeOf(env: NodeJS.ProcessEnv): DeploymentIdentityRefusalCode | "NO_REFUSAL" {
    try {
        resolveDeploymentIdentity(env);
        return "NO_REFUSAL";
    } catch (error) {
        return error instanceof DeploymentIdentityError ? error.code : "NO_REFUSAL";
    }
}

describe("resolveDeploymentIdentity", () => {
    it("resolves the full lineage from deployment variables", () => {
        expect(resolveDeploymentIdentity(UAT_ENV)).toEqual({
            tenantId: "freshline-uat",
            marketId: "bali",
            environment: "uat"
        });
    });

    it("fails closed when the tenant is absent", () => {
        const env = { ...UAT_ENV };
        delete env["SCP_TENANT_ID"];

        expect(() => resolveDeploymentIdentity(env)).toThrow(DeploymentIdentityError);
    });

    it("fails closed when the environment is absent", () => {
        const env = { ...UAT_ENV };
        delete env["SCP_ENVIRONMENT"];

        expect(() => resolveDeploymentIdentity(env)).toThrow(DeploymentIdentityError);
    });

    it("treats whitespace as absent rather than as a tenant name", () => {
        expect(() => resolveDeploymentIdentity({ ...UAT_ENV, SCP_TENANT_ID: "   " })).toThrow(
            DeploymentIdentityError
        );
    });

    it("substitutes no production identity when nothing is set", () => {
        // The failure must be a refusal, not a default. If this ever returns an
        // object, some default tenant has been introduced.
        expect(() => resolveDeploymentIdentity({} as NodeJS.ProcessEnv)).toThrow(
            DeploymentIdentityError
        );
    });

    it("rejects an unknown market, with the chokepoint's own reason preserved", () => {
        // The registry is what refuses; this boundary only restates the verdict in
        // deployment terms, so the machine-readable code must survive translation.
        expect(() => resolveDeploymentIdentity({ ...UAT_ENV, ACTIVE_MARKET: "atlantis" })).toThrow(
            /not a recognized market id/
        );
        expect(codeOf({ ...UAT_ENV, ACTIVE_MARKET: "atlantis" })).toBe("UNKNOWN_MARKET");
    });
});

// SCP-DEPLOY-ID-01 — the ambiguity being removed is narrow and easy to
// reintroduce: absence of a market signal must not mean "the default market".
describe("SCP-DEPLOY-ID-01 explicit market selection", () => {
    const governedEnvironments = ["uat", "staging", "production", "candidate", "UAT"];

    it.each(governedEnvironments)("refuses a missing market in %s", (environment) => {
        const env = { SCP_TENANT_ID: "freshline-uat", SCP_ENVIRONMENT: environment };

        expect(() => resolveDeploymentIdentity(env)).toThrow(DeploymentIdentityError);
        expect(codeOf(env)).toBe("MISSING_ACTIVE_MARKET");
    });

    it("treats an unrecognised environment name as governed, not as a laptop", () => {
        // Failing safe matters more than failing precisely: a new environment
        // nobody anticipated must behave production-like.
        expect(isGovernedEnvironment("something-nobody-planned")).toBe(true);
        expect(codeOf({ SCP_TENANT_ID: "t", SCP_ENVIRONMENT: "something-nobody-planned" })).toBe(
            "MISSING_ACTIVE_MARKET"
        );
    });

    it("accepts explicit Bali in a governed environment", () => {
        expect(resolveDeploymentIdentity({ ...UAT_ENV, ACTIVE_MARKET: "bali" })).toEqual({
            tenantId: "freshline-uat",
            marketId: "bali",
            environment: "uat"
        });
    });

    it("accepts an explicit alternate registered market", () => {
        expect(
            resolveDeploymentIdentity({ ...UAT_ENV, ACTIVE_MARKET: "bangkok" }).marketId
        ).toBe("bangkok");
    });

    it("refuses a blank market signal rather than reading it as absent", () => {
        expect(codeOf({ ...UAT_ENV, ACTIVE_MARKET: "" })).toBe("UNKNOWN_MARKET");
    });

    it("permits the development default only under an exact development environment", () => {
        const dev = { SCP_TENANT_ID: "freshline-dev", SCP_ENVIRONMENT: "development" };

        expect(isGovernedEnvironment("development")).toBe(false);
        expect(resolveDeploymentIdentity(dev)).toEqual({
            tenantId: "freshline-dev",
            marketId: "bali",
            environment: "development"
        });
    });

    it("does not let development-adjacent names reach the fallback", () => {
        for (const environment of ["dev", "local", "development-uat", "DEVELOPMENTAL"]) {
            expect(isGovernedEnvironment(environment)).toBe(true);
            expect(codeOf({ SCP_TENANT_ID: "t", SCP_ENVIRONMENT: environment })).toBe(
                "MISSING_ACTIVE_MARKET"
            );
        }
    });

    it("still resolves the market through the canonical registry, not a local copy", () => {
        const viaIdentity = resolveDeploymentIdentity({ ...UAT_ENV, ACTIVE_MARKET: "bangkok" });
        const viaChokepoint = getActiveMarketConfig({ ACTIVE_MARKET: "bangkok" });

        expect(viaIdentity.marketId).toBe(viaChokepoint.marketId);
        expect(viaChokepoint.timezone).toBe("Asia/Bangkok");
    });

    it("keeps the chokepoint the only reader of the market-selection signal", () => {
        // Structural guard. If this boundary ever reads ACTIVE_MARKET itself there
        // are two interpretations of one signal, which AGENTS.md Rule 1 forbids and
        // SCP-DEPLOY-ID-01 §6 lists as prohibited architecture. The one permitted
        // mention is the presence check that decides whether to log the fallback.
        const source = readFileSync(
            join(__dirname, "..", "..", "src", "runtime", "deploymentIdentity.ts"),
            "utf8"
        );
        const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const reads = code.match(/env\[["']ACTIVE_MARKET["']\]/g) ?? [];

        expect(reads.length).toBeLessThanOrEqual(1);
        expect(code).not.toMatch(/REGISTRY|\.market\.json/);
    });
});

describe("SCP-DEPLOY-ID-01 chokepoint behaviour", () => {
    it("still defaults when explicitness is not required", () => {
        expect(getActiveMarketConfig({}).marketId).toBe("bali");
    });

    it("refuses absence when explicitness is required", () => {
        expect(() => getActiveMarketConfig({}, { requireExplicit: true })).toThrow(
            MarketSelectionError
        );
        try {
            getActiveMarketConfig({}, { requireExplicit: true });
            expect.unreachable();
        } catch (error) {
            expect((error as MarketSelectionError).code).toBe("MISSING_ACTIVE_MARKET");
        }
    });

    it("refuses an unknown market whether or not explicitness is required", () => {
        expect(() => getActiveMarketConfig({ ACTIVE_MARKET: "atlantis" })).toThrow(
            MarketSelectionError
        );
        expect(() =>
            getActiveMarketConfig({ ACTIVE_MARKET: "atlantis" }, { requireExplicit: true })
        ).toThrow(MarketSelectionError);
    });
});

describe("deriveUatBundle", () => {
    it("replaces deployment identity and nothing else", () => {
        const derived = deriveUatBundle(FRESHLINE_BALI_V2, FRESHLINE_UAT_LINEAGE);

        expect(derived.tenant.id).toBe("freshline-uat");
        expect(derived.tenant.market).toBe("bali");
        expect(derived.environment).toBe("uat");

        // Everything outside those three fields must be byte-identical. A UAT run
        // that quietly relaxes a policy proves nothing about the configuration it
        // claims to be exercising.
        const strip = (bundle: unknown): unknown => {
            const copy = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
            delete copy["environment"];
            delete copy["tenant"];
            return copy;
        };

        expect(strip(derived)).toEqual(strip(FRESHLINE_BALI_V2));
    });

    it("carries over the source schema and configuration version", () => {
        const derived = deriveUatBundle(FRESHLINE_BALI_V2, FRESHLINE_UAT_LINEAGE);

        expect(derived.schemaVersion).toBe(FRESHLINE_BALI_V2.schemaVersion);
        expect(derived.configurationVersion).toBe(FRESHLINE_BALI_V2.configurationVersion);
    });

    it("preserves the non-identity tenant fields", () => {
        const derived = deriveUatBundle(FRESHLINE_BALI_V2, FRESHLINE_UAT_LINEAGE);

        expect(derived.tenant.organization).toBe(FRESHLINE_BALI_V2.tenant.organization);
        expect(derived.tenant.brand).toBe(FRESHLINE_BALI_V2.tenant.brand);
    });

    it("does not mutate the imported source bundle", () => {
        // The bundle's checksum is its identity, and the source is a shared module
        // object. Mutating it in place would corrupt every later reader.
        const before = JSON.stringify(FRESHLINE_BALI_V2);
        deriveUatBundle(FRESHLINE_BALI_V2, FRESHLINE_UAT_LINEAGE);

        expect(JSON.stringify(FRESHLINE_BALI_V2)).toBe(before);
        expect(FRESHLINE_BALI_V2.tenant.id).toBe("freshline-bali");
        expect(FRESHLINE_BALI_V2.environment).toBe("candidate");
    });

    it("never yields the production tenant identity", () => {
        const derived = deriveUatBundle(FRESHLINE_BALI_V2, FRESHLINE_UAT_LINEAGE);

        expect(derived.tenant.id).not.toBe(FRESHLINE_BALI_V2.tenant.id);
        expect(derived.environment).not.toBe(FRESHLINE_BALI_V2.environment);
    });
});
