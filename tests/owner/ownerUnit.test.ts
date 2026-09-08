// G5-F unit proofs — the parts that hold without a database.
//
// The command contracts, the stage derivation, the rendered console, and the
// structural claims: no second state machine, no duplicate authority, no
// Freshline-specific Core logic.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveStage } from "../../src/owner/queue";
import { NEVER_DECLARED } from "../../src/owner/commands";
import { OWNER_REASONS, ownerHttpStatus } from "../../src/owner/reasons";
import {
    QUALIFICATION_OUTCOMES,
    isQualificationOutcome
} from "../../src/lifecycle/qualification";
import { OPERATIONAL_ACTION_TYPES } from "../../src/lifecycle/actions";
import { buildOwnerProjection, renderOwnerConsole } from "../../src/host/ownerPage";
import { resolveFromStored } from "../../src/runtime/effectiveConfiguration";
import { FRESHLINE_BALI_V2, freshlineV2Checksum } from "../../src/config/tenant/freshline";

const SCOPE = { tenantId: "freshline-bali", marketId: "bali", environment: "candidate" };

function effective() {
    const resolved = resolveFromStored(
        {
            configurationId: "00000000-0000-0000-0000-000000000001",
            tenantId: SCOPE.tenantId,
            marketId: SCOPE.marketId,
            environment: SCOPE.environment,
            configurationVersion: 2,
            schemaVersion: "scp.tenant.configuration.v2",
            state: "ACTIVE",
            checksum: freshlineV2Checksum(),
            predecessorVersion: 1,
            actorOrAuthority: "PTC/DRJ",
            sourceReference: "SCP-G5-F-01",
            createdAt: new Date(0),
            activatedAt: new Date(0),
            bundle: FRESHLINE_BALI_V2 as never
        },
        SCOPE
    );
    if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
    return resolved.configuration;
}

const BASE = {
    state: "PENDING_ACCEPTANCE" as const,
    qualification: null,
    hasOpenOffer: false,
    providerAccepted: false,
    hasAssignment: false,
    confirmed: false,
    fulfillmentStarted: false
};

describe("G5-F / stage derivation — a label for an operator, never a state", () => {
    it("walks the operational journey in order", () => {
        expect(deriveStage(BASE)).toBe("AWAITING_QUALIFICATION");
        expect(deriveStage({ ...BASE, qualification: "CLARIFICATION_REQUIRED" })).toBe(
            "CLARIFICATION_REQUIRED"
        );
        expect(deriveStage({ ...BASE, qualification: "SERVICEABLE" })).toBe("READY_FOR_MATCHING");
        expect(deriveStage({ ...BASE, state: "PROVIDER_DISPATCHED" })).toBe("OFFER_OUTSTANDING");
        expect(deriveStage({ ...BASE, state: "PROVIDER_ACCEPTED" })).toBe(
            "PROVIDER_ACCEPTED_AWAITING_ASSIGNMENT"
        );
        expect(deriveStage({ ...BASE, state: "OWNER_ASSIGNED" })).toBe(
            "ASSIGNED_AWAITING_CONFIRMATION_REQUEST"
        );
        expect(deriveStage({ ...BASE, state: "AWAITING_CUSTOMER_CONFIRMATION" })).toBe(
            "AWAITING_CUSTOMER_CONFIRMATION"
        );
        expect(deriveStage({ ...BASE, state: "CUSTOMER_CONFIRMED" })).toBe(
            "CONFIRMED_AWAITING_FULFILLMENT"
        );
        expect(deriveStage({ ...BASE, state: "FULFILLMENT_ACTIVE" })).toBe("FULFILLMENT_ACTIVE");
    });

    it("treats every terminal canonical state as closed", () => {
        for (const state of ["SERVICE_COMPLETED", "CANCELLED", "NO_SHOW", "UNABLE_TO_FULFILL"] as const) {
            expect(deriveStage({ ...BASE, state, qualification: "SERVICEABLE" })).toBe("CLOSED");
        }
    });

    it("never reports a serviceable judgement as matched, offered or assigned", () => {
        // A judgement is not progress. READY_FOR_MATCHING is the strongest thing
        // a qualification alone can produce.
        expect(deriveStage({ ...BASE, qualification: "SERVICEABLE" })).toBe("READY_FOR_MATCHING");
        expect(deriveStage({ ...BASE, qualification: "UNSERVICEABLE" })).toBe(
            "AWAITING_QUALIFICATION"
        );
    });
});

describe("G5-F / qualification vocabulary", () => {
    it("is a closed set of three judgements", () => {
        expect([...QUALIFICATION_OUTCOMES]).toEqual([
            "SERVICEABLE",
            "CLARIFICATION_REQUIRED",
            "UNSERVICEABLE"
        ]);
        expect(isQualificationOutcome("SERVICEABLE")).toBe(true);
        expect(isQualificationOutcome("QUALIFIED")).toBe(false);
        expect(isQualificationOutcome(null)).toBe(false);
    });

    it("adds exactly one action to the canonical taxonomy", () => {
        expect(OPERATIONAL_ACTION_TYPES).toContain("QUALIFY_REQUEST");
        expect(OPERATIONAL_ACTION_TYPES).toHaveLength(16);
        // Nothing resembling a new lifecycle state entered the taxonomy.
        for (const invented of ["QUALIFIED", "MATCHED", "READY_FOR_MATCHING", "OFFER_SENT"]) {
            expect(OPERATIONAL_ACTION_TYPES).not.toContain(invented);
        }
    });
});

describe("G5-F / Owner refusal vocabulary", () => {
    it("maps every reason to a status", () => {
        for (const reason of OWNER_REASONS) {
            const status = ownerHttpStatus(reason);
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThan(600);
        }
        expect(ownerHttpStatus("SESSION_INVALID")).toBe(401);
        expect(ownerHttpStatus("OWNER_AUTHORITY_REQUIRED")).toBe(403);
        expect(ownerHttpStatus("REQUEST_UNKNOWN")).toBe(404);
        expect(ownerHttpStatus("IDEMPOTENCY_KEY_CONFLICT")).toBe(409);
    });

    it("names the fields no Owner command will ever declare", () => {
        for (const field of ["state", "actorIdentityId", "tenantId", "role", "confirmed"]) {
            expect(NEVER_DECLARED as readonly string[]).toContain(field);
        }
    });
});

describe("G5-F / Owner console — an interface, not a record", () => {
    const projection = buildOwnerProjection(effective());
    const page = renderOwnerConsole(projection);

    it("is explicitly non-authoritative and says so on the page", () => {
        expect(projection.authoritative).toBe(false);
        expect(page).toContain("It is not the system of record");
    });

    it("renders governed configuration, not constants", () => {
        expect(projection.market.operatingHours).toEqual({ open: "08:00", close: "23:00" });
        expect(projection.market.regions).toContain("Uluwatu");
        expect(projection.provenance.configurationVersion).toBe(2);
        expect(projection.provenance.configurationChecksum).toBe(freshlineV2Checksum());
        expect(page).toContain("cfg v2");
    });

    it("reports payment, dynamic pricing and rating/commission exactly as configured", () => {
        expect(projection.commerce.paymentActive).toBe(false);
        expect(projection.commerce.dynamicPricingActive).toBe(false);
        // G5A-G10 stays unresolved; the console reports it rather than deciding.
        expect(projection.commerce.ratingCommissionState).toBe("UNRESOLVED");
        expect(projection.commerce.ratingCommissionActive).toBe(false);
        expect(page).toContain("Payment inactive");
        expect(page).toContain("rating/commission UNRESOLVED");
    });

    it("spells out the separations the operator must not blur", () => {
        expect(page).toContain("Qualifying is not matching");
        expect(page).toContain("Offering is not acceptance");
        expect(page).toContain("Assigning is not customer confirmation");
        expect(page).toContain("Confirmation is not fulfillment");
    });

    it("stores nothing in the browser and contacts no external host", () => {
        for (const api of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
            expect(page, `the console must not use ${api}`).not.toContain(api);
        }
        expect(page).not.toMatch(/<script[^>]+src=/i);
        expect(page).not.toMatch(/<link[^>]+stylesheet/i);
        expect(page).not.toMatch(/https?:\/\//);
    });

    it("offers no control that could confirm on the customer's behalf", () => {
        // The console can ASK the customer to confirm. Recording the answer
        // needs the CUSTOMER role on that request, which no Owner route reaches.
        expect(page).toContain("/api/owner/request-confirmation");
        expect(page).not.toContain("/api/owner/record-confirmation");
        expect(page).not.toContain("/api/owner/confirm");
    });
});

describe("G5-F / no second state machine and no duplicate authority", () => {
    function filesUnder(dir: string): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                out.push(...filesUnder(full));
            } else if (full.endsWith(".ts")) {
                out.push(full);
            }
        }
        return out;
    }

    const root = join(__dirname, "..", "..", "src");
    const g5fFiles = [
        ...filesUnder(join(root, "owner")),
        join(root, "host", "ownerHost.ts"),
        join(root, "host", "ownerPage.ts")
    ];
    const stripped = g5fFiles
        .map((f) =>
            readFileSync(f, "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^[ \t]*\/\/.*$/gm, "")
        )
        .join("\n");

    it("writes to no canonical lifecycle table directly", () => {
        for (const table of [
            "core_service_request",
            "core_dispatch_offer",
            "core_assignment",
            "core_customer_confirmation",
            "core_fulfillment",
            "core_operational_action",
            "core_request_qualification",
            "core_capacity_window",
            "core_provider",
            "appointments"
        ]) {
            expect(stripped, `G5-F must not write ${table}`).not.toMatch(
                new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, "i")
            );
        }
    });

    it("performs every mutation through the one governed orchestrator entry point", () => {
        expect(stripped).toContain("executeOperationalAction");
        // No transition helper is reachable from the Owner layer.
        for (const forbidden of ["transitionRequest", "assignProvider(", "confirmContext", "openAttempt"]) {
            expect(stripped, `G5-F must not call ${forbidden}`).not.toContain(forbidden);
        }
    });

    it("implements no eligibility rule of its own", () => {
        expect(stripped).toContain("evaluateServiceCommerce");
        // No capacity or coverage predicate is written here; the kernel owns it.
        expect(stripped).not.toMatch(/tstzrange/i);
        expect(stripped).not.toMatch(/core_capacity_window/i);
        expect(stripped).not.toMatch(/core_service_area/i);
    });

    it("carries no Freshline-specific rule", () => {
        for (const literal of ["Seminyak", "Canggu", "FRESH_CUT", "Freshline Studio", "bali"]) {
            expect(stripped, `G5-F must not carry the tenant literal ${literal}`).not.toContain(
                literal
            );
        }
    });

    it("Core, kernel and lifecycle import nothing from the Owner modules", () => {
        const governed = ["core", "kernel", "lifecycle"].flatMap((d) => filesUnder(join(root, d)));
        for (const file of governed) {
            const source = readFileSync(file, "utf8");
            expect(source, `${file} must not import the owner module`).not.toMatch(
                /from\s+["'][^"']*\/owner\//
            );
            expect(source, `${file} must not import a host`).not.toMatch(/from\s+["'][^"']*\/host\//);
        }
    });
});
