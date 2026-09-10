// LAB-INFRA-01B — proof for the deployment identity boundary and the UAT lineage
// derivation. Both are governance surfaces: one decides who a process claims to
// be, the other decides what a UAT run is allowed to differ by.

import { describe, expect, it } from "vitest";

import {
    DeploymentIdentityError,
    resolveDeploymentIdentity
} from "../../src/runtime/deploymentIdentity";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { deriveUatBundle, FRESHLINE_UAT_LINEAGE } from "../../src/config/tenant/uat";

const UAT_ENV = {
    SCP_TENANT_ID: "freshline-uat",
    ACTIVE_MARKET: "bali",
    SCP_ENVIRONMENT: "uat"
} as NodeJS.ProcessEnv;

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

    it("rejects an unknown market through the config-plane chokepoint", () => {
        // Not a DeploymentIdentityError: the market registry is what refuses, and
        // that is the point — market selection is validated in exactly one place.
        expect(() => resolveDeploymentIdentity({ ...UAT_ENV, ACTIVE_MARKET: "atlantis" })).toThrow(
            /not a recognized market id/
        );
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
