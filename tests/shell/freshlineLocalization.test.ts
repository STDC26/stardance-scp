// UAT-R2-B — Freshline Indonesian localization completeness.
//
// The founder's finding was mixed-language output on the Indonesian surface. The
// audit showed the structural dictionary is complete for `id` (24/24 keys) — every
// leaking string came from governed CONFIGURATION, whose schema has no locale
// dimension, so one string serves every language.
//
// The repair is a presentation overlay for the GENERIC configuration strings. It
// translates what is displayed and never what is submitted, so localization cannot
// move commercial truth. Product names stay as configured and are classified
// CANONICAL_OR_BRAND_PRESERVED rather than left English by accident.

import { describe, expect, it } from "vitest";

import { renderCustomerPage } from "../../src/host/page";
import { translate } from "../../src/localization/translate";
import { customerProjectionFixture } from "../support/customerProjectionFixture";

/** The real Freshline locale set, per its governed configuration. */
const REAL_LOCALES = {
    supportedLocales: ["en", "id"],
    localeDefault: "en",
    // Mirrors the shapes the deployed governed configuration actually produces:
    // a generic "Other" region, a "Villa" accommodation and the English tagline.
    regions: ["Canggu", "Seminyak", "Other"],
    accommodationTypes: ["Hotel", "Villa", "Airbnb"],
    tagline: "Your style, your space, your Freshline."
};

function render(locale: string): string {
    return renderCustomerPage({
        projection: customerProjectionFixture(REAL_LOCALES),
        locale,
        ingressPath: "/labs/freshline/api/customer/requests"
    });
}

/**
 * Strings that are intentionally identical in every locale because they are the
 * tenant's published product and brand names, carried in governed configuration.
 * Listed explicitly so "still English" is a recorded decision, not an oversight.
 */
const CANONICAL_OR_BRAND_PRESERVED = [
    "Freshline Studio",
    "Classic Treatment",
    "Extended Treatment",
    "Scalp Add-on"
] as const;

describe("UAT-R2-B structural copy", () => {
    it("resolves English structural copy in EN", () => {
        const html = render("en");
        expect(html).toContain(translate("customer", "label_accommodation", "en"));
        expect(html).toContain('<html lang="en">');
    });

    it("resolves Indonesian structural copy in ID", () => {
        const html = render("id");
        const accommodation = translate("customer", "label_accommodation", "id");

        expect(accommodation).not.toBe("");
        expect(html).toContain(accommodation);
        expect(html).toContain('<html lang="id">');
    });

    it("has no Indonesian gap in the customer dictionary", () => {
        // The audit that produced this repair, kept as a standing assertion: a new
        // English-only key would fail here rather than reaching a customer.
        const strings = require("../../src/localization/strings.json") as Record<
            string,
            Record<string, Record<string, string>>
        >;
        const missing = Object.entries(strings["customer"] ?? {})
            .filter(([, entry]) => entry["id"] === undefined)
            .map(([key]) => key);

        expect(missing).toEqual([]);
    });
});

describe("UAT-R2-B configuration-sourced display", () => {
    it("localizes the generic region option rather than leaving it English", () => {
        // "Other" was the founder's example of accidental English.
        expect(render("id")).toContain("Lainnya");
        expect(render("id")).not.toMatch(/>Other</);
    });

    it("keeps the submitted region value canonical while translating its label", () => {
        const html = render("id");
        // Canonical value in the form, Indonesian only in the visible label.
        expect(html).toContain('value="Other"');
        expect(html).toContain("Lainnya");
    });

    it("localizes the accommodation option and the tagline", () => {
        const html = render("id");
        expect(html).toContain("Vila");
        expect(html).toContain("Gaya Anda, ruang Anda, Freshline Anda.");
    });

    it("shows a date-format hint in ID and none in EN", () => {
        // The browser owns the native date input's own placeholder; SCP states the
        // expected order beside it instead of pretending to control it.
        expect(render("id")).toContain("Format tanggal mengikuti pengaturan peramban Anda");
        expect(render("en")).not.toContain('class="hint"');
    });

    it("preserves canonical product and brand names in both locales", () => {
        // Not a blanket English ban: these are intentionally invariant.
        const en = render("en");
        const id = render("id");
        for (const name of CANONICAL_OR_BRAND_PRESERVED) {
            expect(en, `${name} in EN`).toContain(name);
            expect(id, `${name} in ID`).toContain(name);
        }
    });
});

describe("UAT-R2-B commercial truth invariance", () => {
    it("keeps Freshline in IDR in both locales", () => {
        for (const locale of ["en", "id"]) {
            const html = render(locale);
            expect(html).toContain("Rp450,000.00");
            expect(html).not.toContain("EUR");
            expect(html).not.toContain("€");
        }
    });

    it("keeps every canonical value identical across EN and ID", () => {
        const en = render("en");
        const id = render("id");

        // Codes and prices are truth; they must not move when words do.
        for (const canonical of [
            'value="FL-CLASSIC"',
            'value="FL-EXTENDED"',
            'value="FL-SCALP"',
            'value="Other"',
            'value="Canggu"',
            "Rp450,000.00",
            "Rp650,000.00"
        ]) {
            expect(en, `${canonical} in EN`).toContain(canonical);
            expect(id, `${canonical} in ID`).toContain(canonical);
        }
    });

    it("changes words without changing the form contract", () => {
        const fields = (html: string): string[] =>
            (html.match(/name="[a-zA-Z]+"/g) ?? []).sort();

        expect(fields(render("id"))).toEqual(fields(render("en")));
    });
});
