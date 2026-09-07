// G5-E unit proofs — the parts that hold without a database.
//
// The intake contracts, the schedule digest that makes apply-to-all provably
// the same truth as per-day editing, the media boundary's type detection, the
// rendered Partner surface, and the structural claim that no provider-specific
// code entered Core.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    DECLARED_PROFILE_FIELDS,
    DECLARED_AVAILABILITY_FIELDS,
    DECLARED_AVAILABILITY_DAY_FIELDS,
    DECLARED_CARD_SUBMIT_FIELDS,
    normalizeContact,
    parseAvailabilityIntent,
    parseCardDecisionIntent,
    parseCardSubmitIntent,
    parseProfileIntent,
    profileFingerprint,
    scheduleDigest
} from "../../src/provider/contracts";
import { PROVIDER_REASONS, providerHttpStatus } from "../../src/provider/reasons";
import { sniffImageType, ACCEPTED_MEDIA_TYPES, MAX_MEDIA_BYTES } from "../../src/provider/media";
import { hashToken } from "../../src/provider/session";
import { buildPartnerProjection, renderPartnerPage } from "../../src/host/partnerPage";
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
            sourceReference: "SCP-G5-E-01",
            createdAt: new Date(0),
            activatedAt: new Date(0),
            bundle: FRESHLINE_BALI_V2 as never
        },
        SCOPE
    );
    if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
    return resolved.configuration;
}

function goodProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        legalName: "I Wayan Sudiarta",
        displayName: "Wayan",
        contactHandle: "+628131234567",
        roleCode: "BB",
        serviceCodes: ["FRESH_CUT"],
        locale: "en",
        ...overrides
    };
}

function day(isoDay: number, available = true, regions = ["Seminyak"]): Record<string, unknown> {
    return available
        ? { isoDay, available: true, startTime: "09:00", endTime: "17:00", regions }
        : { isoDay, available: false };
}

function goodWeek(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        weekStartDate: "2026-11-16",
        days: [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, d <= 5)),
        ...overrides
    };
}

describe("G5-E / profile contract — the Partner surface captures intent, nothing more", () => {
    it("accepts a well-formed profile", () => {
        const parsed = parseProfileIntent(goodProfile());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.intent.roleCode).toBe("BB");
        expect(parsed.intent.serviceCodes).toEqual(["FRESH_CUT"]);
        expect(parsed.intent.contactHandle).toBe("+628131234567");
    });

    it("declares exactly the partner-supplied fields and nothing else", () => {
        expect([...DECLARED_PROFILE_FIELDS].sort()).toEqual([
            "aboutMe",
            "contactHandle",
            "displayName",
            "howYouWork",
            "idempotencyKey",
            "legalName",
            "locale",
            "portraitMediaId",
            "profileChips",
            "roleCode",
            "serviceCodes"
        ]);
        expect([...DECLARED_CARD_SUBMIT_FIELDS]).toEqual(["idempotencyKey"]);
    });

    it("refuses every field through which a browser might assert supply authority", () => {
        for (const field of [
            "supplyStatus",
            "approved",
            "providerId",
            "publicId",
            "partnerId",
            "state",
            "tenantId",
            "marketId",
            "environment",
            "confirmedBy",
            "confirmedAt",
            "identityId",
            "role"
        ]) {
            const parsed = parseProfileIntent(goodProfile({ [field]: "anything" }));
            expect(parsed.ok, `${field} must be refused`).toBe(false);
            if (parsed.ok) continue;
            expect(parsed.findings.some((f) => f.field === field && f.code === "UNDECLARED_FIELD")).toBe(
                true
            );
        }
    });

    it("requires at least one capability and refuses a repeated one", () => {
        expect(parseProfileIntent(goodProfile({ serviceCodes: [] })).ok).toBe(false);
        expect(
            parseProfileIntent(goodProfile({ serviceCodes: ["FRESH_CUT", "FRESH_CUT"] })).ok
        ).toBe(false);
    });

    it("normalizes a contact without guessing a country", () => {
        expect(normalizeContact("+62 813-123-4567")).toBe("+628131234567");
        expect(normalizeContact("628131234567")).toBe("+628131234567");
        expect(normalizeContact("08131234567")).toBeNull();
    });

    it("excludes the idempotency key from the profile fingerprint", () => {
        const a = parseProfileIntent(goodProfile({ idempotencyKey: "aaaaaaaa" }));
        const b = parseProfileIntent(goodProfile({ idempotencyKey: "bbbbbbbb" }));
        if (!a.ok || !b.ok) throw new Error("expected valid intents");
        expect(profileFingerprint(SCOPE, a.intent)).toBe(profileFingerprint(SCOPE, b.intent));
    });

    it("scopes the fingerprint to the runtime", () => {
        const parsed = parseProfileIntent(goodProfile());
        if (!parsed.ok) throw new Error("expected a valid intent");
        expect(profileFingerprint(SCOPE, parsed.intent)).not.toBe(
            profileFingerprint({ ...SCOPE, tenantId: "another" }, parsed.intent)
        );
    });
});

describe("G5-E / availability contract — one canonical week", () => {
    it("accepts a well-formed week", () => {
        const parsed = parseAvailabilityIntent(goodWeek());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.intent.days).toHaveLength(7);
        expect(parsed.intent.days.map((d) => d.isoDay)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("declares exactly the schedule fields, with no entry-mode field to become a truth model", () => {
        expect([...DECLARED_AVAILABILITY_FIELDS].sort()).toEqual([
            "days",
            "idempotencyKey",
            "weekStartDate"
        ]);
        expect([...DECLARED_AVAILABILITY_DAY_FIELDS].sort()).toEqual([
            "available",
            "endTime",
            "isoDay",
            "regions",
            "startTime"
        ]);
        expect(DECLARED_AVAILABILITY_FIELDS as readonly string[]).not.toContain("applyToAll");
        expect(DECLARED_AVAILABILITY_FIELDS as readonly string[]).not.toContain("entryMode");
    });

    it("requires exactly seven distinct days", () => {
        expect(parseAvailabilityIntent(goodWeek({ days: [day(1)] })).ok).toBe(false);
        expect(
            parseAvailabilityIntent(goodWeek({ days: [1, 1, 2, 3, 4, 5, 6].map((d) => day(d)) })).ok
        ).toBe(false);
        expect(
            parseAvailabilityIntent(goodWeek({ days: [1, 2, 3, 4, 5, 6, 8].map((d) => day(d)) })).ok
        ).toBe(false);
    });

    it("refuses a half-stated day in either direction", () => {
        const missingHours = goodWeek({
            days: [{ isoDay: 1, available: true, regions: ["Seminyak"] }, ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))]
        });
        expect(parseAvailabilityIntent(missingHours).ok).toBe(false);

        const hoursOnDayOff = goodWeek({
            days: [
                { isoDay: 1, available: false, startTime: "09:00" },
                ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))
            ]
        });
        expect(parseAvailabilityIntent(hoursOnDayOff).ok).toBe(false);

        const regionsOnDayOff = goodWeek({
            days: [
                { isoDay: 1, available: false, regions: ["Seminyak"] },
                ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))
            ]
        });
        expect(parseAvailabilityIntent(regionsOnDayOff).ok).toBe(false);
    });

    it("refuses an available day with no coverage, and a repeated region", () => {
        expect(
            parseAvailabilityIntent(
                goodWeek({ days: [day(1, true, []), ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))] })
            ).ok
        ).toBe(false);
        expect(
            parseAvailabilityIntent(
                goodWeek({
                    days: [
                        day(1, true, ["Seminyak", "Seminyak"]),
                        ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))
                    ]
                })
            ).ok
        ).toBe(false);
    });

    it("refuses undeclared fields inside a day, naming the path", () => {
        const parsed = parseAvailabilityIntent(
            goodWeek({
                days: [
                    { ...day(1), confirmed: true },
                    ...[2, 3, 4, 5, 6, 7].map((d) => day(d, false))
                ]
            })
        );
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.findings.some((f) => f.field === "days[0].confirmed")).toBe(true);
    });

    it("sorts days into canonical order however they arrive", () => {
        const shuffled = parseAvailabilityIntent(
            goodWeek({ days: [7, 3, 1, 5, 2, 6, 4].map((d) => day(d, d <= 5)) })
        );
        expect(shuffled.ok).toBe(true);
        if (!shuffled.ok) return;
        expect(shuffled.intent.days.map((d) => d.isoDay)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});

describe("G5-E / A04 — apply-to-all and per-day editing are the same truth", () => {
    // What a partner produces by pressing "apply Monday to every day".
    const applied = [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, true, ["Seminyak", "Canggu"]));
    // The same week typed out one day at a time, in a different order, with the
    // regions listed the other way round.
    const manual = [4, 1, 7, 2, 6, 3, 5].map((d) => day(d, true, ["Canggu", "Seminyak"]));

    it("produces an identical canonical schedule digest", () => {
        const a = parseAvailabilityIntent(goodWeek({ days: applied }));
        const b = parseAvailabilityIntent(goodWeek({ days: manual }));
        if (!a.ok || !b.ok) throw new Error("expected valid weeks");
        expect(scheduleDigest(SCOPE, "2026-11-16", a.intent.days)).toBe(
            scheduleDigest(SCOPE, "2026-11-16", b.intent.days)
        );
    });

    it("still differs when the week actually differs", () => {
        const a = parseAvailabilityIntent(goodWeek({ days: applied }));
        const changed = parseAvailabilityIntent(
            goodWeek({
                days: [
                    day(1, true, ["Seminyak", "Canggu"]),
                    day(2, true, ["Seminyak", "Canggu"]),
                    day(3, true, ["Seminyak", "Canggu"]),
                    day(4, true, ["Seminyak", "Canggu"]),
                    day(5, true, ["Seminyak", "Canggu"]),
                    day(6, true, ["Seminyak", "Canggu"]),
                    { isoDay: 7, available: true, startTime: "10:00", endTime: "17:00", regions: ["Seminyak", "Canggu"] }
                ]
            })
        );
        if (!a.ok || !changed.ok) throw new Error("expected valid weeks");
        expect(scheduleDigest(SCOPE, "2026-11-16", a.intent.days)).not.toBe(
            scheduleDigest(SCOPE, "2026-11-16", changed.intent.days)
        );
    });

    it("is scoped to the runtime and the week", () => {
        const a = parseAvailabilityIntent(goodWeek({ days: applied }));
        if (!a.ok) throw new Error("expected a valid week");
        expect(scheduleDigest(SCOPE, "2026-11-16", a.intent.days)).not.toBe(
            scheduleDigest(SCOPE, "2026-11-23", a.intent.days)
        );
        expect(scheduleDigest(SCOPE, "2026-11-16", a.intent.days)).not.toBe(
            scheduleDigest({ ...SCOPE, marketId: "bangkok" }, "2026-11-16", a.intent.days)
        );
    });
});

describe("G5-E / Owner command contracts", () => {
    it("card and confirmation decisions accept nothing that could name a decider", () => {
        for (const field of ["decidedBy", "confirmedBy", "actorIdentityId", "role", "supplyStatus"]) {
            expect(parseCardDecisionIntent({ cardId: crypto.randomUUID(), [field]: "x" }).ok).toBe(false);
        }
    });

    it("card submission carries nothing but an idempotency key", () => {
        expect(parseCardSubmitIntent({}).ok).toBe(true);
        expect(parseCardSubmitIntent({ profileId: "x" }).ok).toBe(false);
        expect(parseCardSubmitIntent({ publicId: "BB-0001" }).ok).toBe(false);
    });

    it("requires a well-formed card identifier", () => {
        expect(parseCardDecisionIntent({ cardId: "not-a-uuid" }).ok).toBe(false);
        expect(parseCardDecisionIntent({}).ok).toBe(false);
    });
});

describe("G5-E / refusal vocabulary", () => {
    it("maps every reason to a status", () => {
        for (const reason of PROVIDER_REASONS) {
            const status = providerHttpStatus(reason);
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThan(600);
        }
        expect(providerHttpStatus("SESSION_INVALID")).toBe(401);
        expect(providerHttpStatus("OWNER_AUTHORITY_REQUIRED")).toBe(403);
        expect(providerHttpStatus("IDEMPOTENCY_KEY_CONFLICT")).toBe(409);
        expect(providerHttpStatus("MEDIA_TOO_LARGE")).toBe(413);
    });
});

describe("G5-E / media boundary — a declared content type is a claim, not a fact", () => {
    it("identifies accepted images from their leading bytes", () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
        const webp = Buffer.concat([
            Buffer.from("RIFF", "ascii"),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from("WEBP", "ascii")
        ]);
        expect(sniffImageType(png)).toBe("image/png");
        expect(sniffImageType(jpeg)).toBe("image/jpeg");
        expect(sniffImageType(webp)).toBe("image/webp");
    });

    it("refuses anything that is not one of them, however it is labelled", () => {
        expect(sniffImageType(Buffer.from("<?php echo 1; ?>", "utf8"))).toBeNull();
        expect(sniffImageType(Buffer.from("GIF89a", "ascii"))).toBeNull();
        expect(sniffImageType(Buffer.alloc(0))).toBeNull();
        expect(ACCEPTED_MEDIA_TYPES).toHaveLength(3);
        expect(MAX_MEDIA_BYTES).toBe(5 * 1024 * 1024);
    });
});

describe("G5-E / sessions — only a digest is ever stored", () => {
    it("hashes a token to a 64-character hex digest", () => {
        const digest = hashToken("some-token");
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(hashToken("some-token")).toBe(digest);
        expect(hashToken("some-other-token")).not.toBe(digest);
    });
});

describe("G5-E / Partner surface — governed configuration, not duplicated constants", () => {
    const projection = buildPartnerProjection(effective());
    const page = (locale: string) => renderPartnerPage({ projection, locale });

    it("is explicitly non-authoritative", () => {
        expect(projection.authoritative).toBe(false);
    });

    it("projects the governed roles, capabilities, coverage and hours", () => {
        expect(projection.roles.map((r) => r.code)).toEqual(["BB", "EC", "FX", "MS", "NT"]);
        expect(projection.services.map((s) => s.code)).toEqual([
            "FRESH_CUT",
            "FRESH_CUT_BEARD",
            "FULL_FRESH"
        ]);
        expect(projection.market.regions).toContain("Uluwatu");
        expect(projection.market.operatingHours).toEqual({ open: "08:00", close: "23:00" });
        expect(projection.market.supportedLocales).toEqual(["en", "id"]);
        expect(projection.brand.experienceTerm).toBe("PARTNER");
    });

    it("reports the rating/commission position from configuration rather than inventing one", () => {
        // G5A-G10: UNRESOLVED and inactive is a fact about the business.
        expect(projection.commerce.ratingCommissionState).toBe("UNRESOLVED");
        expect(projection.commerce.ratingCommissionActive).toBe(false);
        expect(projection.commerce.paymentActive).toBe(false);
        expect(projection.commerce.dynamicPricingActive).toBe(false);
    });

    it("renders both governed locales and a Monday-start seven-day week", () => {
        const en = page("en");
        const id = page("id");
        expect(en).toContain('<html lang="en">');
        expect(id).toContain('<html lang="id">');
        expect(en).toContain("Partner Portal");
        expect(id).toContain("Portal Mitra");
        expect(en).toContain("Monday");
        expect(id).toContain("Senin");
        expect(en.indexOf("Monday")).toBeLessThan(en.indexOf("Tuesday"));
        for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
            expect(en).toContain(day);
        }
        expect(en).toContain("Apply Monday to every day");
        expect(id).toContain("Terapkan Senin ke semua hari");
    });

    it("is mobile-first with 44px targets", () => {
        const html = page("en");
        expect(html).toContain("width=device-width");
        expect(html).toContain("min-height:44px");
        expect(html).toContain("max-width:640px");
        expect(html).toContain("@media (min-width:520px)");
    });

    it("never renders a client-authored Partner ID field", () => {
        const html = page("en");
        const form = html.slice(html.indexOf("<form"), html.lastIndexOf("</form>"));
        for (const name of ["publicId", "partnerId", "supplyStatus", "providerId", "state"]) {
            expect(form).not.toContain(`name="${name}"`);
        }
        expect(html).toContain("Your Partner ID is issued by the Freshline team");
    });

    it("tells the partner plainly what saving, submitting and sending do NOT do", () => {
        const html = page("en");
        expect(html).toContain("Saving a profile is not approval");
        expect(html).toContain("Sending your week is not confirmation");
        expect(html).toContain("never books a customer for you");
    });

    it("stores nothing in the browser that could become truth", () => {
        const html = page("en");
        for (const api of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
            expect(html, `the partner page must not use ${api}`).not.toContain(api);
        }
    });

    it("contacts no external host", () => {
        const html = page("en");
        expect(html).not.toMatch(/<script[^>]+src=/i);
        expect(html).not.toMatch(/<link[^>]+stylesheet/i);
        expect(html).not.toMatch(/https?:\/\//);
    });

    it("escapes configuration-sourced text rather than trusting it", () => {
        const hostile = effective();
        hostile.brand.tagline = `</style><script>alert(1)</script>`;
        hostile.experience.providerExperience.tenantExperienceTerm = `<img onerror=alert(2)>`;
        const html = renderPartnerPage({ projection: buildPartnerProjection(hostile), locale: "en" });
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).not.toContain("<img onerror=alert(2)>");
    });
});

describe("G5-E / no Freshline-specific Core fork", () => {
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
    const g5e = [...filesUnder(join(root, "provider")), join(root, "host", "partnerHost.ts"), join(root, "host", "partnerPage.ts")];

    it("Core, kernel and lifecycle import nothing from the G5-E provider or host modules", () => {
        for (const file of governedCore) {
            const source = readFileSync(file, "utf8");
            expect(source, `${file} must not import the provider module`).not.toMatch(
                /from\s+["'][^"']*\/provider\/(session|contracts|profile|card|availability|supply|media|ingress|serviceAreas|reasons)["']/
            );
            expect(source, `${file} must not import the host module`).not.toMatch(
                /from\s+["'][^"']*\/host\//
            );
        }
    });

    it("Core, kernel and lifecycle carry no Freshline partner literal", () => {
        for (const file of governedCore) {
            const source = readFileSync(file, "utf8");
            for (const literal of ["BB-", "PARTNER", "Freshline Studio", "Seminyak", "displayIdPrefixes"]) {
                expect(source, `${file} must not carry the tenant literal ${literal}`).not.toContain(
                    literal
                );
            }
        }
    });

    it("the G5-E modules create no lifecycle, assignment or confirmation state", () => {
        const source = g5e
            .map((f) =>
                readFileSync(f, "utf8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/^[ \t]*\/\/.*$/gm, "")
            )
            .join("\n");
        for (const table of [
            "core_dispatch_offer",
            "core_assignment",
            "core_customer_confirmation",
            "core_fulfillment",
            "core_service_request",
            "core_operational_action",
            "appointments"
        ]) {
            expect(source, `G5-E must not write ${table}`).not.toMatch(
                new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, "i")
            );
        }
        for (const state of [
            "PROVIDER_DISPATCHED",
            "PROVIDER_ACCEPTED",
            "OWNER_ASSIGNED",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CUSTOMER_CONFIRMED",
            "FULFILLMENT_ACTIVE",
            "SERVICE_COMPLETED"
        ]) {
            expect(source, `G5-E must not name the lifecycle state ${state}`).not.toContain(state);
        }
    });

    it("supply status is written in exactly one place, and it is the G2 Core command", () => {
        const source = g5e.map((f) => readFileSync(f, "utf8")).join("\n");
        // No G5-E module writes supply_status directly; activation goes through
        // approveProviderSupply, which owns that column.
        expect(source).not.toMatch(/UPDATE\s+core_provider\s+SET[^;]*supply_status/i);
        expect(source).toContain("approveProviderSupply");
    });
});
