// G5-D unit proofs — the parts that hold without a database.
//
// The intake contract, the acknowledgement's state truth, the rendered surface,
// and the structural claim that no Freshline-specific code entered Core.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    DECLARED_INTAKE_FIELDS,
    deriveIdempotencyKey,
    intentFingerprint,
    normalizeContactHandle,
    parseCustomerIntent
} from "../../src/customer/intake";
import {
    buildAcknowledgement,
    PROHIBITED_ACKNOWLEDGEMENT_TERMS
} from "../../src/customer/acknowledgement";
import { buildCustomerProjection } from "../../src/customer/projection";
import { declaresUnconfirmedDurations } from "../../src/customer/catalogueProjection";
import { renderCustomerPage, timeChips, escapeHtml } from "../../src/host/page";
import { resolveFromStored } from "../../src/runtime/effectiveConfiguration";
import { FRESHLINE_BALI_V2, freshlineV2Checksum } from "../../src/config/tenant/freshline";
import { INGRESS_REASONS, ingressHttpStatus } from "../../src/customer/reasons";

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
            sourceReference: "SCP-G5-D-01",
            createdAt: new Date(0),
            activatedAt: new Date(0),
            bundle: FRESHLINE_BALI_V2 as never
        },
        SCOPE
    );
    if (!resolved.ok) {
        throw new Error(`${resolved.code}: ${resolved.message}`);
    }
    return resolved.configuration;
}

function goodBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        serviceCode: "FRESH_CUT",
        extraCodes: ["FOOT_MASSAGE"],
        requestedDate: "2026-11-20",
        requestedTime: "10:00",
        region: "Seminyak",
        accommodationType: "Villa",
        customerName: "Ayu Pratama",
        contactHandle: "+628123456789",
        locale: "en",
        ...overrides
    };
}

describe("G5-D / intake contract — the customer surface captures intent, nothing more", () => {
    it("accepts a well-formed submission", () => {
        const parsed = parseCustomerIntent(goodBody());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.intent.serviceCode).toBe("FRESH_CUT");
        expect(parsed.intent.extraCodes).toEqual(["FOOT_MASSAGE"]);
        expect(parsed.intent.contactHandle).toBe("+628123456789");
    });

    it("declares exactly the customer-supplied canonical fields and nothing else", () => {
        expect([...DECLARED_INTAKE_FIELDS].sort()).toEqual([
            "accommodationType",
            "contactHandle",
            "customerName",
            "extraCodes",
            "idempotencyKey",
            "locale",
            "region",
            "requestedDate",
            "requestedTime",
            "serviceCode"
        ]);
    });

    it("refuses a browser-supplied price, in every name a browser might use", () => {
        for (const field of [
            "price",
            "priceMinorUnits",
            "amount",
            "currency",
            "total",
            "priceVersionId"
        ]) {
            const parsed = parseCustomerIntent(goodBody({ [field]: 1 }));
            expect(parsed.ok, `${field} must be refused`).toBe(false);
            if (parsed.ok) continue;
            expect(parsed.findings.some((f) => f.field === field && f.code === "UNDECLARED_FIELD")).toBe(
                true
            );
        }
    });

    it("refuses a browser-supplied tenant, market, environment, state or identifier", () => {
        for (const field of [
            "tenantId",
            "marketId",
            "environment",
            "state",
            "status",
            "requestId",
            "customerIdentityId",
            "providerId",
            "configurationVersion",
            "startTime",
            "serverReceivedAt",
            "sourceChannel"
        ]) {
            const parsed = parseCustomerIntent(goodBody({ [field]: "anything" }));
            expect(parsed.ok, `${field} must be refused`).toBe(false);
        }
    });

    it("rejects malformed dates, times, contacts and oversized selections", () => {
        expect(parseCustomerIntent(goodBody({ requestedDate: "20-11-2026" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ requestedTime: "25:00" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ requestedTime: "9:00" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ contactHandle: "0812" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ extraCodes: "FOOT_MASSAGE" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ extraCodes: new Array(17).fill("X") })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ customerName: "  " })).ok).toBe(false);
        expect(parseCustomerIntent("not an object").ok).toBe(false);
        expect(parseCustomerIntent([goodBody()]).ok).toBe(false);
    });

    it("reports every finding at once so a customer corrects a form once, not five times", () => {
        const parsed = parseCustomerIntent({
            serviceCode: "",
            requestedDate: "nope",
            requestedTime: "nope",
            region: "",
            customerName: "",
            contactHandle: "x",
            locale: ""
        });
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.findings.length).toBeGreaterThanOrEqual(6);
    });

    it("normalizes a contact handle without guessing a country", () => {
        expect(normalizeContactHandle("+62 812-3456-789")).toBe("+628123456789");
        expect(normalizeContactHandle("628123456789")).toBe("+628123456789");
        // A local-format number has no country. Inferring one produces an
        // unreachable customer, so it is refused instead.
        expect(normalizeContactHandle("08123456789")).toBeNull();
        expect(normalizeContactHandle("abc")).toBeNull();
    });

    it("validates a caller-supplied idempotency key rather than trusting its shape", () => {
        expect(parseCustomerIntent(goodBody({ idempotencyKey: "short" })).ok).toBe(false);
        expect(parseCustomerIntent(goodBody({ idempotencyKey: "web-abc12345" })).ok).toBe(true);
        expect(parseCustomerIntent(goodBody({ idempotencyKey: "bad key with spaces" })).ok).toBe(false);
    });
});

describe("G5-D / fingerprint — a replay is recognisable, a collision is not a replay", () => {
    function fingerprintOf(body: Record<string, unknown>): string {
        const parsed = parseCustomerIntent(body);
        if (!parsed.ok) throw new Error("expected a valid intent");
        return intentFingerprint({ ...SCOPE, intent: parsed.intent });
    }

    it("is stable across extra ordering and independent of the display name", () => {
        const a = fingerprintOf(goodBody({ extraCodes: ["FOOT_MASSAGE", "FULL_BODY_MASSAGE"] }));
        const b = fingerprintOf(goodBody({ extraCodes: ["FULL_BODY_MASSAGE", "FOOT_MASSAGE"] }));
        expect(a).toBe(b);
        expect(fingerprintOf(goodBody({ customerName: "Someone Else" }))).toBe(fingerprintOf(goodBody()));
    });

    it("changes when anything material changes", () => {
        const base = fingerprintOf(goodBody());
        expect(fingerprintOf(goodBody({ serviceCode: "FULL_FRESH" }))).not.toBe(base);
        expect(fingerprintOf(goodBody({ requestedTime: "11:00" }))).not.toBe(base);
        expect(fingerprintOf(goodBody({ region: "Canggu" }))).not.toBe(base);
        expect(fingerprintOf(goodBody({ contactHandle: "+628999999999" }))).not.toBe(base);
        expect(fingerprintOf(goodBody({ extraCodes: [] }))).not.toBe(base);
    });

    it("scopes to the runtime, so the same intent in another tenant is another request", () => {
        const parsed = parseCustomerIntent(goodBody());
        if (!parsed.ok) throw new Error("expected a valid intent");
        expect(intentFingerprint({ ...SCOPE, intent: parsed.intent })).not.toBe(
            intentFingerprint({ ...SCOPE, tenantId: "another-tenant", intent: parsed.intent })
        );
    });

    it("derives a server key when the caller supplies none", () => {
        const key = deriveIdempotencyKey("a".repeat(64), "corr-1");
        expect(key.startsWith("di:")).toBe(true);
        expect(key.endsWith(":corr-1")).toBe(true);
    });
});

describe("G5-D / acknowledgement — received is not confirmed", () => {
    it("states every lifecycle position it does NOT hold", () => {
        const ack = buildAcknowledgement({
            locale: "en",
            requestId: "11111111-1111-1111-1111-111111111111",
            brandPublicName: "Freshline",
            replay: false
        });
        expect(ack.stateTruth).toBe("REQUEST_RECEIVED");
        expect(ack.canonicalState).toBe("PENDING_ACCEPTANCE");
        expect(ack.ownerQualified).toBe(false);
        expect(ack.providerAccepted).toBe(false);
        expect(ack.providerAssigned).toBe(false);
        expect(ack.customerConfirmed).toBe(false);
        expect(ack.fulfillmentStarted).toBe(false);
        expect(ack.serviceCompleted).toBe(false);
        expect(ack.paymentTaken).toBe(false);
    });

    it("keeps the warm tone without claiming a lifecycle position, in both locales", () => {
        for (const locale of ["en", "id"]) {
            const ack = buildAcknowledgement({
                locale,
                requestId: "r-1",
                brandPublicName: "Freshline",
                replay: false
            });
            const copy = `${ack.headline} ${ack.body} ${ack.nextStep}`.toLowerCase();
            expect(copy.length).toBeGreaterThan(40);
            for (const term of PROHIBITED_ACKNOWLEDGEMENT_TERMS) {
                expect(copy, `${locale} copy must not contain "${term}"`).not.toContain(term);
            }
        }
    });

    it("interpolates the governed brand rather than a hardcoded one", () => {
        const ack = buildAcknowledgement({
            locale: "en",
            requestId: "r-1",
            brandPublicName: "SomeOtherBrand",
            replay: false
        });
        expect(ack.body).toContain("SomeOtherBrand");
        expect(ack.body).not.toContain("{brand}");
    });

    it("says a replay is the same request, not a second one", () => {
        const replay = buildAcknowledgement({
            locale: "en",
            requestId: "r-1",
            brandPublicName: "Freshline",
            replay: true
        });
        expect(replay.replay).toBe(true);
        expect(replay.nextStep.toLowerCase()).toContain("same reference");
    });

    it("falls back to readable English rather than silence for an untranslated locale", () => {
        const ack = buildAcknowledgement({
            locale: "th",
            requestId: "r-1",
            brandPublicName: "Freshline",
            replay: false
        });
        expect(ack.headline.length).toBeGreaterThan(0);
    });
});

describe("G5-D / customer projection — governed configuration, not duplicated constants", () => {
    const projection = buildCustomerProjection(effective());

    it("is explicitly non-authoritative", () => {
        expect(projection.authoritative).toBe(false);
    });

    it("projects the frozen Freshline catalogue from configuration", () => {
        expect(projection.catalogue.services.map((s) => s.name)).toEqual([
            "The Fresh Cut",
            "Fresh Cut + Beard",
            "The Full Fresh"
        ]);
        expect(projection.catalogue.services.map((s) => s.price.minorUnits)).toEqual([
            350000, 450000, 550000
        ]);
        expect(projection.catalogue.extras.map((e) => e.price.minorUnits)).toEqual([
            200000, 250000, 350000
        ]);
        expect(projection.catalogue.services[0]!.price.display).toBe("Rp350,000");
    });

    it("projects the frozen coverage, locales and hours", () => {
        expect(projection.market.regions).toEqual([
            "Seminyak",
            "Canggu",
            "Kuta",
            "Legian",
            "Sanur",
            "Denpasar",
            "Nusa Dua",
            "Uluwatu",
            "Other"
        ]);
        expect(projection.market.accommodationTypes).toEqual(["Hotel", "Villa", "Airbnb"]);
        expect(projection.market.supportedLocales).toEqual(["en", "id"]);
        expect(projection.market.operatingHours).toEqual({ open: "08:00", close: "23:00" });
        expect(projection.market.timezone).toBe("Asia/Makassar");
        // The 08:00 opening is an approved divergence from the canonical 09:00,
        // and the projection says so rather than hiding it.
        expect(projection.market.operatingHoursOrigin).toBe("APPROVED_OVERRIDE");
    });

    it("carries the governing configuration identity", () => {
        expect(projection.provenance.configurationVersion).toBe(2);
        expect(projection.provenance.configurationChecksum).toBe(freshlineV2Checksum());
        expect(projection.provenance.canonicalMarketId).toBe("bali");
    });

    it("shows payment and dynamic pricing as inactive", () => {
        expect(projection.commerce.paymentActive).toBe(false);
        expect(projection.commerce.paymentPolicy).toBe("OFFLINE");
        expect(projection.commerce.dynamicPricingActive).toBe(false);
    });

    it("never projects an inactive catalogue item onto the surface at all", () => {
        const configuration = effective();
        configuration.catalogue.services[1]!.active = false;
        configuration.catalogue.extras[0]!.active = false;
        const filtered = buildCustomerProjection(configuration);
        expect(filtered.catalogue.services.map((s) => s.code)).toEqual(["FRESH_CUT", "FULL_FRESH"]);
        expect(filtered.catalogue.extras.map((e) => e.code)).not.toContain("FOOT_MASSAGE");
    });
});

describe("G5-D / rendered surface — mobile-first and bilingual", () => {
    const projection = buildCustomerProjection(effective());
    const page = (locale: string) =>
        renderCustomerPage({ projection, locale, ingressPath: "/api/customer/requests" });

    it("renders the governed catalogue, prices, regions and accommodation types", () => {
        const html = page("en");
        for (const name of ["The Fresh Cut", "Fresh Cut + Beard", "The Full Fresh"]) {
            expect(html).toContain(name);
        }
        expect(html).toContain("Rp350,000");
        for (const region of projection.market.regions) {
            expect(html).toContain(`value="${region}"`);
        }
        for (const type of projection.market.accommodationTypes) {
            expect(html).toContain(`<option value="${type}">`);
        }
    });

    it("is mobile-first: a viewport meta, fluid width, 44px targets and a widening breakpoint", () => {
        const html = page("en");
        expect(html).toContain('name="viewport"');
        expect(html).toContain("width=device-width");
        expect(html).toContain("max-width:560px");
        expect(html).toContain("min-height:44px");
        expect(html).toContain("@media (min-width:480px)");
        // Nothing may force the document wider than a small phone. `max-width`
        // and `min-width` are constraints, not forced widths, so they are
        // excluded rather than counted as violations.
        const fixedWidths = [...html.matchAll(/(?<!max-|min-)width:\s*(\d+)px/g)].map((m) =>
            Number(m[1])
        );
        for (const width of fixedWidths) {
            expect(width).toBeLessThanOrEqual(320);
        }
    });

    it("renders both governed locales and links between them", () => {
        const en = page("en");
        const id = page("id");
        expect(en).toContain('<html lang="en">');
        expect(id).toContain('<html lang="id">');
        expect(en).toContain("Choose your service");
        expect(id).toContain("Pilih layanan Anda");
        expect(en).toContain('href="?lang=id"');
        expect(id).toContain('href="?lang=en"');
    });

    it("falls back to the governed default locale for an unsupported one", () => {
        expect(page("th")).toContain('<html lang="en">');
    });

    it("tells the customer that sending is a request, and that payment is offline", () => {
        const html = page("en");
        expect(html).toContain("not a reservation");
        expect(html).toContain("No payment is taken online");
        expect(html).toContain("it is not where your request lives");
    });

    it("offers no field through which a browser could send a price or an identity", () => {
        const html = page("en");
        for (const name of ["price", "amount", "tenantId", "marketId", "environment", "state"]) {
            expect(html).not.toContain(`name="${name}"`);
        }
    });

    it("derives time chips from the governed operating hours", () => {
        expect(timeChips("08:00", "23:00")).toHaveLength(15);
        expect(timeChips("08:00", "23:00")[0]).toBe("08:00");
        expect(timeChips("07:00", "10:00")).toEqual(["07:00", "08:00", "09:00"]);
    });

    it("escapes configuration-sourced text rather than trusting it", () => {
        expect(escapeHtml(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
        const hostile = effective();
        hostile.brand.tagline = `</style><script>alert(1)</script>`;
        const html = renderCustomerPage({
            projection: buildCustomerProjection(hostile),
            locale: "en",
            ingressPath: "/x"
        });
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;alert(1)");
    });
});

describe("G5-D / R16 — durations stay declared assumptions", () => {
    it("reads the bundle's own declaration that catalogue durations are CC-supplied", () => {
        expect(declaresUnconfirmedDurations(FRESHLINE_BALI_V2)).toBe(true);
    });

    it("does not treat a missing declaration as ratification", () => {
        expect(declaresUnconfirmedDurations({ _meta: { ccSuppliedValues: [] } })).toBe(false);
        expect(declaresUnconfirmedDurations({})).toBe(false);
    });
});

describe("G5-D / refusal vocabulary", () => {
    it("maps every reason to a status without a default that hides a case", () => {
        for (const reason of INGRESS_REASONS) {
            const status = ingressHttpStatus(reason);
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThan(600);
        }
        expect(ingressHttpStatus("IDEMPOTENCY_KEY_CONFLICT")).toBe(409);
        expect(ingressHttpStatus("IDENTITY_MISMATCH")).toBe(403);
        expect(ingressHttpStatus("CONFIGURATION_UNRESOLVED")).toBe(503);
    });
});

describe("G5-D / no Freshline-specific Core fork", () => {
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
    const governedCore = ["core", "kernel", "lifecycle"].flatMap((d) => filesUnder(join(root, d)));

    it("Core, kernel and lifecycle import nothing from the G5-D customer or host modules", () => {
        expect(governedCore.length).toBeGreaterThan(20);
        for (const file of governedCore) {
            const source = readFileSync(file, "utf8");
            expect(source, `${file} must not import the customer module`).not.toMatch(
                /from\s+["'][^"']*\/customer\//
            );
            expect(source, `${file} must not import the host module`).not.toMatch(
                /from\s+["'][^"']*\/host\//
            );
        }
    });

    it("Core, kernel and lifecycle contain no Freshline catalogue, brand or region literal", () => {
        const tenantLiterals = [
            "FRESH_CUT",
            "FULL_FRESH",
            "FOOT_MASSAGE",
            "Freshline Studio",
            "Seminyak",
            "Canggu",
            "Uluwatu"
        ];
        for (const file of governedCore) {
            const source = readFileSync(file, "utf8");
            for (const literal of tenantLiterals) {
                expect(source, `${file} must not carry the tenant literal ${literal}`).not.toContain(
                    literal
                );
            }
        }
    });

    it("the G5-D modules add no lifecycle state to the canonical vocabulary", () => {
        const canonical = readFileSync(join(root, "core", "types.ts"), "utf8");
        // Comments are stripped first. The invariant is that no G5-D CODE names
        // or acts on another lifecycle state; a comment explaining which
        // collapse the code prevents is the opposite of a violation.
        const g5d = [...filesUnder(join(root, "customer")), ...filesUnder(join(root, "host"))]
            .map((f) =>
                readFileSync(f, "utf8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/^[ \t]*\/\/.*$/gm, "")
            )
            .join("\n");
        // The only canonical state G5-D may name is the one Core assigns at
        // intake. Naming any other would be a lifecycle opinion this gate does
        // not hold.
        for (const state of [
            "PROVIDER_DISPATCHED",
            "PROVIDER_ACCEPTED",
            "OWNER_ASSIGNED",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CUSTOMER_CONFIRMED",
            "FULFILLMENT_ACTIVE",
            "SERVICE_COMPLETED",
            "NO_SHOW",
            "UNABLE_TO_FULFILL"
        ]) {
            expect(canonical).toContain(state);
            expect(g5d, `G5-D must not name ${state}`).not.toContain(state);
        }
        expect(g5d).toContain("PENDING_ACCEPTANCE");
    });

    it("the G5-D modules never write to the legacy appointments surface", () => {
        const g5d = [...filesUnder(join(root, "customer")), ...filesUnder(join(root, "host"))]
            .map((f) => readFileSync(f, "utf8"))
            .join("\n");
        expect(g5d).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+appointments/i);
    });
});
