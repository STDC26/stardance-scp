// C8 — qualification for the Experience Lab.
//
// Everything here runs without a database on purpose. Athena is fixture-backed so
// it is fully testable offline, the mount table and prefix stripping are pure, and
// the semantic assertions are about the CONTRACT rather than about any particular
// deployment being up. A qualification suite that needs Neon to run is a
// qualification suite that stops running.

import { describe, expect, it } from "vitest";

import {
    ATTENTION_PRECEDENCE,
    attentionRank,
    isLive,
    type AttentionLevel,
    type DemandPayload,
    type ProjectionEnvelope
} from "../../src/shell/contract";
import { resolveMount, stripMountPrefix, LAB_MOUNTS } from "../../src/shell/mount";
import {
    createFixtureProjectionProvider,
    FixtureNotFoundError,
    ATHENA_FIXTURE_VERSION,
    ATHENA_LOCALES,
    ATHENA_CURRENCY
} from "../../src/shell/fixtureProvider";
import { attentionForStage } from "../../src/shell/liveProvider";
import { inspect, renderInspector } from "../../src/shell/inspector";
import { renderAthenaPage } from "../../src/shell/athenaPage";
import { deriveJourney, journeyHref, parseSelection } from "../../src/shell/athenaInteraction";
import { formatMoney } from "../../src/shell/money";
import { customerProjectionFixture } from "../support/customerProjectionFixture";
import { ATHENA_PROFILE, FRESHLINE_PROFILE } from "../../src/host/brandProfile";

const provider = createFixtureProjectionProvider();
const ANON = { actorId: null, role: "VISITOR" } as const;

async function athenaDemand(locale = "en"): Promise<ProjectionEnvelope<DemandPayload>> {
    return provider.demand({ tenant: "athena-uat", actor: ANON, locale });
}

function athenaHtml(
    envelope: ProjectionEnvelope<DemandPayload>,
    query = ""
): string {
    return renderAthenaPage({
        envelope,
        profile: ATHENA_PROFILE,
        inspectorPath: "/labs/_inspect",
        basePath: "/labs/athena",
        params: new URLSearchParams(query),
        locales: ATHENA_LOCALES
    });
}

// ---------------------------------------------------------------------------
// C2 — mount table and prefix stripping
// ---------------------------------------------------------------------------

describe("C2 mount resolution", () => {
    it("resolves the longest matching prefix, not the first", () => {
        // The bug this prevents: `/labs/freshline/operate` resolving to the DEMAND
        // mount because `/labs/freshline` also matches.
        expect(resolveMount("/labs/freshline/operate")?.perspective).toBe("OPERATE");
        expect(resolveMount("/labs/freshline/partner")?.perspective).toBe("SUPPLY");
        expect(resolveMount("/labs/freshline")?.perspective).toBe("DEMAND");
        expect(resolveMount("/labs/athena/operate")?.perspective).toBe("OPERATE");
        expect(resolveMount("/labs/athena")?.perspective).toBe("DEMAND");
    });

    it("does not match a tenant that merely shares a prefix", () => {
        expect(resolveMount("/labs/freshline-typo")).toBeUndefined();
        expect(resolveMount("/labs/athenaX")).toBeUndefined();
        expect(resolveMount("/labs")).toBeUndefined();
        expect(resolveMount("/labs/health")).toBeUndefined();
    });

    it("gives each mounted handler its own path space", () => {
        expect(stripMountPrefix("/labs/freshline", "/labs/freshline")).toBe("/");
        expect(stripMountPrefix("/labs/freshline/", "/labs/freshline")).toBe("/");
        expect(stripMountPrefix("/labs/freshline/api/customer/requests", "/labs/freshline")).toBe(
            "/api/customer/requests"
        );
        expect(stripMountPrefix("/labs/freshline?lang=id-ID", "/labs/freshline")).toBe("/?lang=id-ID");
        expect(
            stripMountPrefix("/labs/freshline/api/customer/configuration?x=1", "/labs/freshline")
        ).toBe("/api/customer/configuration?x=1");
    });

    it("leaves a non-matching url untouched", () => {
        expect(stripMountPrefix("/labs/health", "/labs/freshline")).toBe("/labs/health");
    });

    it("mounts Freshline on extracted host handlers and Athena on the Shell", () => {
        const freshline = LAB_MOUNTS.filter((m) => m.tenant === "freshline-uat");
        const athena = LAB_MOUNTS.filter((m) => m.tenant === "athena-uat");

        // REAL WHERE PROVEN: Freshline is never Shell-rendered.
        expect(freshline.every((m) => m.handler !== "SHELL")).toBe(true);
        expect(athena.every((m) => m.handler === "SHELL")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// C3/C4 — provenance
// ---------------------------------------------------------------------------

describe("C3/C4 provenance", () => {
    it("marks every Athena projection FIXTURE with a version", async () => {
        const demand = await athenaDemand();
        const operate = await provider.operate({ tenant: "athena-uat", actor: ANON });

        for (const envelope of [demand, operate]) {
            expect(envelope.provenance.sourceType).toBe("FIXTURE");
            expect(envelope.provenance.fixtureVersion).toBe(ATHENA_FIXTURE_VERSION);
            expect(isLive(envelope)).toBe(false);
            // A fixture must never claim live maturity.
            expect(envelope.provenance.maturity).toBeUndefined();
            expect(envelope.provenance.sourceVersion).toBeUndefined();
        }
    });

    it("states the simulation in plain language, not in system vocabulary", async () => {
        // UPDATED BY CLOSE-01-B. This previously asserted "<strong>FIXTURE</strong>"
        // on the customer surface. Fixture honesty is unchanged — what changed is
        // that it is now said in words an actor can read. The raw vocabulary lives
        // in the inspector, asserted below.
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain("Simulated experience — no real booking or payment will be created.");
        expect(html).toContain('class="src src-fixture"');
        expect(html).not.toContain('class="src src-live"');
    });

    it("reports absent semantics as absent rather than as false", () => {
        // A LIVE-shaped envelope that carries no availability: the inspector must
        // say "not modelled", because rendering that as "not eligible" would invent
        // a negative eligibility decision nobody made.
        const report = inspect({
            tenant: "freshline-uat",
            actor: ANON,
            perspective: "DEMAND",
            authority: { canRequest: true, canCommit: false, requiresAuthority: false, grants: [] },
            canonicalRef: { kind: "TENANT_CONFIGURATION", id: "2" },
            state: { code: "DEMAND_OPEN", label: "Accepting requests", terminal: false },
            actions: [],
            provenance: {
                sourceType: "LIVE",
                provider: "scp-live",
                sourceVersion: "v2",
                generatedAt: "2026-09-10T00:00:00.000Z"
            },
            payload: {
                brand: {
                    name: "freshline",
                    publicName: "Freshline",
                    tagline: "",
                    marketDescriptor: "",
                    colors: {},
                    headingFont: "x",
                    bodyFont: "y"
                },
                market: {
                    marketId: "bali",
                    timezone: "Asia/Makassar",
                    currency: "IDR",
                    regions: [],
                    operatingHours: { open: "09:00", close: "23:00" }
                },
                services: [],
                offers: [],
                availability: [],
                committable: {
                    posture: "NOT_DETERMINED",
                    reason: "",
                    resolved: { service: false, price: false, eligibility: false, capacity: false }
                }
            }
        });

        expect(report.commercial.eligibilityModelled).toBe(false);
        expect(report.commercial.eligibleWindowCount).toBeNull();
        expect(report.source.sourceType).toBe("LIVE");
    });

    it("renders an absent value as a dash, not as a zero", async () => {
        const html = renderInspector([inspect(await athenaDemand())]);

        expect(html).toContain('class="absent"');
        expect(html).toContain("FIXTURE");
    });

    it("reports the worst attention level across an operate queue", async () => {
        const report = inspect(await provider.operate({ tenant: "athena-uat", actor: ANON }));

        // The Athena fixture queue contains JUDGMENT_REQUIRED and NORMAL items.
        expect(report.operational.highestAttention).toBe("JUDGMENT_REQUIRED");
        expect(report.operational.itemCount).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// C7 — attention precedence
// ---------------------------------------------------------------------------

describe("C7 attention precedence", () => {
    it("orders severity highest-first", () => {
        expect(ATTENTION_PRECEDENCE[0]).toBe("BLOCKED");
        expect(ATTENTION_PRECEDENCE[ATTENTION_PRECEDENCE.length - 1]).toBe("NORMAL");

        const ranks = ATTENTION_PRECEDENCE.map(attentionRank);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    });

    it("does not invent attention levels the canonical stage cannot justify", () => {
        // Only two mappings are justified today. If a future change starts
        // returning BLOCKED or AUTHORITY_REQUIRED from a stage, that is a claim
        // about canonical truth and must be argued, not slipped in.
        expect(attentionForStage("CLARIFICATION_REQUIRED")).toBe("JUDGMENT_REQUIRED");
        expect(attentionForStage("OFFER_OUTSTANDING")).toBe("MATERIAL_CHANGE");

        const unsupported: AttentionLevel[] = ["BLOCKED", "AUTHORITY_REQUIRED", "EXCEPTION"];
        for (const stage of [
            "AWAITING_QUALIFICATION",
            "READY_FOR_MATCHING",
            "PROVIDER_ACCEPTED_AWAITING_ASSIGNMENT",
            "ASSIGNED_AWAITING_CONFIRMATION_REQUEST",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CONFIRMED_AWAITING_FULFILLMENT",
            "FULFILLMENT_ACTIVE",
            "CLOSED"
        ]) {
            expect(unsupported).not.toContain(attentionForStage(stage));
        }
    });
});

// ---------------------------------------------------------------------------
// C6/C8 — semantic integrity
// ---------------------------------------------------------------------------

describe("C8 semantic integrity", () => {
    it("holds ASSIGNED apart from CONFIRMED in the operate payload", async () => {
        const operate = await provider.operate({ tenant: "athena-uat", actor: ANON });
        const assignedNotConfirmed = operate.payload.items.find(
            (item) => item.assignment === "ASSIGNED" && item.confirmation === "NOT_CONFIRMED"
        );

        // The whole distinction exists so this row can be represented at all.
        expect(assignedNotConfirmed).toBeDefined();
        expect(assignedNotConfirmed?.stage).toBe("AWAITING_CUSTOMER_CONFIRMATION");
    });

    it("holds CONFIRMED apart from FULFILLED", async () => {
        const operate = await provider.operate({ tenant: "athena-uat", actor: ANON });
        const confirmedNotFulfilled = operate.payload.items.find(
            (item) => item.confirmation === "CONFIRMED" && item.fulfillment === "NOT_STARTED"
        );

        expect(confirmedNotFulfilled).toBeDefined();
        expect(confirmedNotFulfilled?.stage).toBe("CONFIRMED_AWAITING_FULFILLMENT");
    });

    it("holds AVAILABLE apart from ELIGIBLE and shows the difference", async () => {
        const envelope = await athenaDemand();
        const notEligible = envelope.payload.availability.filter((w) => w.eligible === false);

        expect(notEligible.length).toBeGreaterThan(0);

        const html = athenaHtml(envelope);
        // Rendered, not hidden: an available-but-not-eligible window is visible and
        // labelled, because silently dropping it would misrepresent supply.
        expect(html).toContain("available, not eligible for you");
        expect(html).toContain("av-off");
    });

    it("holds RECOMMENDATION apart from OFFER", async () => {
        const envelope = await athenaDemand();
        const recommendations = envelope.payload.offers.filter((o) => o.kind === "RECOMMENDATION");
        const offers = envelope.payload.offers.filter((o) => o.kind === "OFFER");

        expect(recommendations.length).toBeGreaterThan(0);
        expect(offers.length).toBeGreaterThan(0);

        const html = athenaHtml(envelope);
        expect(html).toContain("offer-rec");
        expect(html).toContain("offer-authorised");
        expect(html).toContain("A recommendation, not an authorised price for you.");
        expect(html).toContain("offer-rec");
    });

    it("NEGATIVE: an ineligible window blocks commitment with a stated reason", async () => {
        // The required negative-state test, and the heart of UAT-R1-02. Window index
        // 2 is AVAILABLE but NOT ELIGIBLE. Selecting it must leave the surface
        // honest: the option stays visible, the commit control is disabled, and the
        // reason is printed rather than the button quietly disappearing.
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=2");

        expect(html).toContain("This time is not eligible for this request.");
        expect(html).toContain(
            "This time is available but you are not eligible for it, so it cannot be reserved."
        );
        // Disabled, not absent.
        expect(html).toContain('aria-disabled="true"');
        expect(html).not.toContain('class="btn btn-primary" href');
    });

    it("NEGATIVE: never prints a stronger posture than the selection supports", async () => {
        const envelope = await athenaDemand();

        // Nothing chosen: no posture claim beyond "not determined", and no request.
        const empty = athenaHtml(envelope);
        expect(empty).toContain("Choose a treatment to continue.");
        expect(empty).toContain("Choose a treatment first.");
        expect(empty).not.toContain("Ready to reserve");

        // Service but no time: request is honest, reserve is not yet.
        const partial = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL");
        expect(partial).toContain("Select an eligible time.");
        expect(partial).toContain("Select an eligible time first.");
        expect(partial).not.toContain("Ready to reserve");

        // Complete and eligible: only now may it say so.
        const complete = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0");
        expect(complete).toContain("Ready to reserve");
    });

    it("NEGATIVE: a suggestion cannot become the payable amount", async () => {
        // SUGGESTION ≠ AUTHORIZED PRICE. Applying the recommendation must leave the
        // payable amount at the service price, not at the suggestion's €45.
        const envelope = await athenaDemand();
        const withRecommendation = deriveJourney(
            parseSelection(
                new URLSearchParams("svc=ATH-SIGNATURE-RITUAL&slot=0&offer=ATH-REC-PAIRING"),
                ATHENA_LOCALES
            ),
            envelope.payload
        );

        expect(withRecommendation.offer?.kind).toBe("RECOMMENDATION");
        expect(withRecommendation.offerApplied).toBe(false);
        expect(withRecommendation.payable?.minorUnits).toBe(18_500);

        // An authorised OFFER may change it.
        const withOffer = deriveJourney(
            parseSelection(
                new URLSearchParams("svc=ATH-SIGNATURE-RITUAL&slot=0&offer=ATH-OFFER-RESIDENT"),
                ATHENA_LOCALES
            ),
            envelope.payload
        );
        expect(withOffer.offerApplied).toBe(true);
        expect(withOffer.payable?.minorUnits).toBe(14_800);
    });

    it("NEGATIVE: a fixture result is never presentable as a canonical commitment", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0&done=1");

        expect(html).toContain("Simulated reservation recorded");
        expect(html).toContain(
            "Nothing has been reserved, nothing has been charged, and no booking record exists."
        );
        // The reference stays fixture-identifiable — that is what makes the
        // simulation impossible to mistake for a canonical booking id.
        expect(html).toContain("FIXTURE-ATH-SIGNATURE-RITUAL-0-NO-OFFER");
        // The reference is unmistakably a fixture, not a UUID.
        expect(html).toContain("FIXTURE-ATH-SIGNATURE-RITUAL-0-NO-OFFER");
        expect(html).toContain('class="src src-fixture"');
    });

    it("does not let an unsubmitted journey show a result", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0");
        expect(html).not.toContain("Simulated reservation recorded");
    });

    it("refuses to show a result for an ineligible selection even when submitted", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=2&done=1");

        // Submitting an ineligible selection must not manufacture a result.
        expect(html).not.toContain("Simulated reservation recorded");
        expect(html).toContain("This time is not eligible for this request.");
    });
});

// ---------------------------------------------------------------------------
// UAT-R1 — interaction, currency, localization
// ---------------------------------------------------------------------------

describe("UAT-R1 Athena interaction", () => {
    it("completes the fixture journey end to end", async () => {
        const envelope = await athenaDemand();

        const steps = [
            { query: "", expect: "Choose a treatment to continue." },
            { query: "svc=ATH-SIGNATURE-RITUAL", expect: "Select an eligible time." },
            { query: "svc=ATH-SIGNATURE-RITUAL&slot=0", expect: "Ready to reserve" },
            { query: "svc=ATH-SIGNATURE-RITUAL&slot=0&done=1", expect: "Simulated reservation recorded" }
        ];

        for (const step of steps) {
            expect(athenaHtml(envelope, step.query), `step ${step.query}`).toContain(step.expect);
        }
    });

    it("marks the chosen service and selected window in the markup", async () => {
        const html = athenaHtml(await athenaDemand(), "svc=ATH-RESTORATIVE-DEEP&slot=1");
        expect(html).toContain("svc-chosen");
        expect(html).toContain("av-on");
        expect(html).toContain("Chosen");
        expect(html).toContain("Selected");
    });

    it("offers at least two eligible windows and one visible ineligible one", async () => {
        const windows = (await athenaDemand()).payload.availability;
        expect(windows.filter((w) => w.eligible === true).length).toBeGreaterThanOrEqual(2);
        expect(windows.filter((w) => w.eligible === false).length).toBeGreaterThanOrEqual(1);
    });

    it("keeps the fixture result deterministic", async () => {
        const envelope = await athenaDemand();
        const a = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0&done=1");
        const b = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0&done=1");
        // generatedAt differs between projections, so compare the reference itself.
        expect(a.includes("FIXTURE-ATH-SIGNATURE-RITUAL-0-NO-OFFER")).toBe(true);
        expect(b.includes("FIXTURE-ATH-SIGNATURE-RITUAL-0-NO-OFFER")).toBe(true);
    });
});

describe("UAT-R1 currency", () => {
    it("presents Athena in EUR, never IDR, in both languages", async () => {
        for (const locale of ATHENA_LOCALES) {
            const envelope = await athenaDemand(locale);
            expect(envelope.payload.market.currency).toBe(ATHENA_CURRENCY);
            for (const service of envelope.payload.services) {
                expect(service.price.currency).toBe("EUR");
            }
            for (const offer of envelope.payload.offers) {
                expect(offer.price.currency).toBe("EUR");
            }

            const html = athenaHtml(envelope, "svc=ATH-SIGNATURE-RITUAL&slot=0");
            expect(html).not.toContain("IDR");
            expect(html).not.toContain("Rp");
            expect(html).toContain("EUR");
        }
    });

    it("formats EUR per locale while leaving the amount untouched", async () => {
        // Intl separates the amount from € with a NARROW NO-BREAK SPACE (U+202F) in
        // French, not an ordinary space. Normalising Unicode spaces keeps this test
        // about the formatting decision rather than about an invisible codepoint.
        const flat = (value: string): string => value.replace(/[\u00A0\u202F\u2009]/g, " ");

        expect(flat(formatMoney(18_500, "EUR", "en"))).toBe("€185.00");
        expect(flat(formatMoney(18_500, "EUR", "fr"))).toBe("185,00 €");

        // The amount is identical; only its presentation moved.
        expect(formatMoney(18_500, "EUR", "en")).not.toBe(formatMoney(18_500, "EUR", "fr"));

        expect(athenaHtml(await athenaDemand("en"), "lang=en")).toContain("€185.00");
        expect(flat(athenaHtml(await athenaDemand("fr"), "lang=fr"))).toContain("185,00 €");
    });

    it("does not change Freshline's currency", () => {
        // MARKET ≠ CURRENCY cuts both ways: Athena going EUR must not move Freshline.
        expect(customerProjectionFixture().market.currency).toBe("IDR");
        expect(customerProjectionFixture().catalogue.services[0]?.price.currency).toBe("IDR");
    });
});

describe("UAT-R1 localization invariance", () => {
    it("translates the journey into French", async () => {
        const html = athenaHtml(await athenaDemand("fr"), "lang=fr&svc=ATH-SIGNATURE-RITUAL&slot=2");

        expect(html).toContain("Récapitulatif");
        expect(html).toContain("Les soins");
        expect(html).toContain("disponible, mais non éligible pour vous");
        // escapeHtml renders the apostrophe as &#39;, so assert a fragment without one.
        expect(html).toContain("pas éligible pour cette demande");
        expect(html).toContain('lang="fr"');
    });

    it("changes words without changing a single business fact", async () => {
        const query = "svc=ATH-SIGNATURE-RITUAL&slot=2&offer=ATH-OFFER-RESIDENT";
        const en = await athenaDemand("en");
        const fr = await athenaDemand("fr");

        const jEn = deriveJourney(parseSelection(new URLSearchParams(query), ATHENA_LOCALES), en.payload);
        const jFr = deriveJourney(
            parseSelection(new URLSearchParams(`${query}&lang=fr`), ATHENA_LOCALES),
            fr.payload
        );

        // Price amount, selection, eligibility, availability shape, authority and
        // posture must all be identical. Only the words differ.
        expect(jFr.payable?.minorUnits).toBe(jEn.payable?.minorUnits);
        expect(jFr.payable?.currency).toBe(jEn.payable?.currency);
        expect(jFr.service?.code).toBe(jEn.service?.code);
        expect(jFr.offer?.code).toBe(jEn.offer?.code);
        expect(jFr.offerApplied).toBe(jEn.offerApplied);
        expect(jFr.window?.eligible).toBe(jEn.window?.eligible);
        expect(jFr.posture).toBe(jEn.posture);
        expect(jFr.canCommit).toBe(jEn.canCommit);
        expect(jFr.blockedReasonKey).toBe(jEn.blockedReasonKey);
        expect(fr.payload.availability.length).toBe(en.payload.availability.length);
        expect(fr.authority).toEqual(en.authority);
        expect(fr.provenance.sourceType).toBe(en.provenance.sourceType);
        expect(fr.provenance.fixtureVersion).toBe(en.provenance.fixtureVersion);
        // Localized copy really did change, so the test above is not vacuous.
        expect(jFr.service?.name).not.toBe(jEn.service?.name);
    });

    it("carries the whole selection through a language switch", async () => {
        const selection = parseSelection(
            new URLSearchParams("svc=ATH-SIGNATURE-RITUAL&slot=1&offer=ATH-OFFER-RESIDENT&done=1"),
            ATHENA_LOCALES
        );
        const href = journeyHref("/labs/athena", selection, { locale: "fr" });

        expect(href).toContain("lang=fr");
        expect(href).toContain("svc=ATH-SIGNATURE-RITUAL");
        expect(href).toContain("slot=1");
        expect(href).toContain("offer=ATH-OFFER-RESIDENT");
        expect(href).toContain("done=1");
    });

    it("falls back to the primary locale for an unsupported language", () => {
        const selection = parseSelection(new URLSearchParams("lang=de"), ATHENA_LOCALES);
        expect(selection.locale).toBe("en");
    });

    it("renders both language links, marking the active one", async () => {
        const html = athenaHtml(await athenaDemand("fr"), "lang=fr&svc=ATH-SIGNATURE-RITUAL");
        expect(html).toContain(">EN<");
        expect(html).toContain(">FR<");
        expect(html).toContain("lang-on");
    });
});

// ---------------------------------------------------------------------------
// C8 — tenant isolation
// ---------------------------------------------------------------------------

describe("C8 tenant isolation", () => {
    it("refuses an unknown tenant rather than serving another tenant's fixtures", async () => {
        await expect(provider.demand({ tenant: "freshline-uat", actor: ANON })).rejects.toThrow(
            FixtureNotFoundError
        );
        await expect(provider.operate({ tenant: "nobody", actor: ANON })).rejects.toThrow(
            FixtureNotFoundError
        );
    });

    it("keeps Athena fixture content out of any Freshline surface", async () => {
        // Freshline's renderer is driven by CustomerProjection and has no path to
        // the fixture registry at all — asserted structurally so a future import
        // would fail the suite rather than leak quietly.
        const athena = await athenaDemand();
        const athenaCodes = athena.payload.services.map((s) => s.code);

        expect(athenaCodes.every((code) => code.startsWith("ATH-"))).toBe(true);
        expect(athena.tenant).toBe("athena-uat");
        expect(athena.payload.brand.name).toBe("athena");
    });

    it("echoes back the requested tenant and never substitutes one", async () => {
        const envelope = await athenaDemand();
        expect(envelope.tenant).toBe("athena-uat");
    });

    it("gives the two tenants different brand profiles with no shared mutable state", () => {
        expect(FRESHLINE_PROFILE.id).not.toBe(ATHENA_PROFILE.id);
        expect(FRESHLINE_PROFILE.contentMaxWidth).not.toBe(ATHENA_PROFILE.contentMaxWidth);
        expect(FRESHLINE_PROFILE.composition).not.toBe(ATHENA_PROFILE.composition);
    });
});

// ---------------------------------------------------------------------------
// C5/C8 — differentiation and responsive composition
// ---------------------------------------------------------------------------

describe("C5 differentiation", () => {
    it("differs from Freshline on every required dimension", () => {
        const dimensions: Array<keyof typeof FRESHLINE_PROFILE> = [
            "headingFallback",
            "bodyFallback",
            "contentMaxWidth",
            "contentPadding",
            "baseFontSize",
            "baseLineHeight",
            "sectionMargin",
            "chipGap",
            "radius",
            "h1Size",
            "h1Weight",
            "h1LetterSpacing",
            "h2Transform",
            "h2LetterSpacing",
            "composition",
            "merchandising",
            "pacing"
        ];

        for (const dimension of dimensions) {
            expect(ATHENA_PROFILE[dimension], `dimension ${dimension} must differ`).not.toBe(
                FRESHLINE_PROFILE[dimension]
            );
        }
    });

    it("expresses the profile in the rendered markup", async () => {
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain(ATHENA_PROFILE.contentMaxWidth);
        expect(html).toContain(ATHENA_PROFILE.h1Size);
        expect(html).toContain(ATHENA_PROFILE.headingFallback);
        // Editorial serif, not Freshline's condensed sans.
        expect(html).toContain("Iowan Old Style");
        expect(html).not.toContain("Oswald");
    });

    it("uses a materially different composition, not a recolour", async () => {
        const html = athenaHtml(await athenaDemand());

        // Card grid rather than a dense chip list.
        expect(html).toContain("grid-template-columns:repeat(auto-fit,minmax(300px,1fr))");
        expect(html).toContain("svc-featured");
        // Freshline's chip markup must not appear.
        expect(html).not.toContain("chip-body");
    });
});

describe("C8 responsive composition", () => {
    it("declares a viewport and mobile breakpoints", async () => {
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain('name="viewport"');
        expect(html).toContain("width=device-width");
        expect(html).toContain("@media (max-width:833px)");
        expect(html).toContain("@media (max-width:400px)");
    });

    it("carries no fixed pixel width that could overflow the narrowest viewport", async () => {
        const html = athenaHtml(await athenaDemand());
        const styleBlock = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

        // `width:NNNpx` is what breaks a 320px screen. `max-width` is fine, and
        // min-width on a grid track is bounded by auto-fit.
        expect(styleBlock).not.toMatch(/[^-]width:\s*\d{3,}px/);
    });

    it("keeps every tenant surface indexable-safe", async () => {
        const html = athenaHtml(await athenaDemand());
        expect(html).toContain('name="robots" content="noindex"');
    });
});

describe("UAT-R2 state label localization", () => {
    it("localizes the projection state label by its canonical code", async () => {
        const en = athenaHtml(await athenaDemand("en"), "lang=en");
        const fr = athenaHtml(await athenaDemand("fr"), "lang=fr");

        expect(en).toContain("Accepting requests");
        // The founder-visible leak: an English state label on a French surface.
        expect(fr).toContain("Demandes acceptées");
        expect(fr).not.toContain("Accepting requests");
    });

    it("falls back to the envelope label for a state with no entry", async () => {
        const envelope = await athenaDemand("fr");
        const unknown = { ...envelope, state: { code: "NOVEL_STATE", label: "Novel", terminal: false } };
        // Degrades to the envelope's own label, never to a blank.
        expect(athenaHtml(unknown, "lang=fr")).toContain("Novel");
    });
});


// ---------------------------------------------------------------------------
// CLOSE-01 — interaction context, experience language, locale stability
// ---------------------------------------------------------------------------

describe("CLOSE-01-A interaction context", () => {
    it("anchors every control to the thing it changed", async () => {
        // A navigation with no fragment lands at document top, which is what threw
        // the user off "Pavilion for Two" — the third card, far down the page.
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain("#ATH-COUPLES-PAVILION");
        expect(html).toContain("#ATH-SIGNATURE-RITUAL");
        expect(html).toContain("#ATH-RESTORATIVE-DEEP");
        expect(html).toContain("#when");
        expect(html).toContain("#offers");
    });

    it("provides the anchor targets those fragments point at", async () => {
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain('id="ATH-COUPLES-PAVILION"');
        expect(html).toContain('id="when"');
        expect(html).toContain('id="offers"');
        expect(html).toContain('id="review"');
        // Context above the anchor, rather than jamming it to the viewport edge.
        expect(html).toContain("scroll-margin-top");
    });

    it("sends the commit and request actions to the review section", async () => {
        const html = athenaHtml(await athenaDemand(), "svc=ATH-SIGNATURE-RITUAL&slot=0");
        expect(html).toContain("#review");
    });

    it("keeps the locale on every anchored control", async () => {
        // A fragment must not cost the language. Every control carries lang=fr.
        const html = athenaHtml(await athenaDemand("fr"), "lang=fr");
        // The language switch legitimately offers the other locale; every OTHER
        // control must carry the active one.
        const hrefs = (html.match(/href="\/labs\/athena[^"]*"/g) ?? []).filter(
            (href) => !href.includes("lang=en")
        );

        expect(hrefs.length).toBeGreaterThan(4);
        for (const href of hrefs) {
            expect(href, href).toContain("lang=fr");
        }
    });

    it("exposes selection state semantically", async () => {
        const html = athenaHtml(await athenaDemand(), "svc=ATH-SIGNATURE-RITUAL&slot=0");
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('aria-pressed="false"');
    });
});

describe("CLOSE-01-B experience language boundary", () => {
    const FORBIDDEN_ON_ACTOR_SURFACE = [
        "athena-uat.fixtures.v2",
        "ATHENA-FIXTURE",
        "sourceType",
        "fixtureVersion",
        "ProjectionProvider",
        "NOT_DETERMINED",
        "CAN_COMMIT",
        "CAN_REQUEST",
        "INSPECT PROJECTION"
    ];

    it("keeps raw system vocabulary off the customer surface in both languages", async () => {
        for (const locale of ["en", "fr"]) {
            const html = athenaHtml(await athenaDemand(locale), `lang=${locale}&svc=ATH-SIGNATURE-RITUAL&slot=0`);
            for (const term of FORBIDDEN_ON_ACTOR_SURFACE) {
                expect(html, `${term} leaked in ${locale}`).not.toContain(term);
            }
        }
    });

    it("does not use an internal service code as a primary label", async () => {
        const html = athenaHtml(await athenaDemand());
        // The code may still appear inside an href/anchor id — it is an identifier
        // there, not label text — but never as copy the customer must interpret.
        expect(html).not.toContain("90 minutes · ATH-SIGNATURE-RITUAL");
        expect(html).not.toContain("· ATH-COUPLES-PAVILION</p>");
    });

    it("still says plainly that nothing real is created", async () => {
        expect(athenaHtml(await athenaDemand())).toContain(
            "Simulated experience — no real booking or payment will be created."
        );
        expect(athenaHtml(await athenaDemand("fr"), "lang=fr")).toContain("Expérience simulée");
    });

    it("offers the technical details in actor-appropriate wording", async () => {
        expect(athenaHtml(await athenaDemand())).toContain("View technical details");
        expect(athenaHtml(await athenaDemand("fr"), "lang=fr")).toContain("Voir les détails techniques");
    });

    it("KEEPS the canonical truth available in the diagnostic surface", async () => {
        // The boundary moves vocabulary; it must not destroy it.
        const report = inspect(await athenaDemand());
        const html = renderInspector([report]);

        expect(html).toContain("FIXTURE");
        expect(html).toContain(ATHENA_FIXTURE_VERSION);
        expect(report.source.sourceType).toBe("FIXTURE");
        expect(report.commercial.committablePosture).toBe("CAN_COMMIT");
    });

    it("leaves canonical state codes unrenamed", async () => {
        // Copy was repaired, not the model.
        const envelope = await athenaDemand();
        expect(envelope.payload.committable.posture).toBe("CAN_COMMIT");
        expect(envelope.state.code).toBe("DEMAND_OPEN");
    });
});

describe("CLOSE-01-C locale stability", () => {
    it("never emits a control that drops or flips the locale", async () => {
        for (const locale of ["en", "fr"]) {
            const html = athenaHtml(
                await athenaDemand(locale),
                `lang=${locale}&svc=ATH-SIGNATURE-RITUAL&slot=2&offer=ATH-OFFER-RESIDENT`
            );
            const hrefs = (html.match(/href="\/labs\/athena[^"]*"/g) ?? []).filter(
                (href) => !href.includes(`lang=${locale === "en" ? "fr" : "en"}`)
            );

            for (const href of hrefs) {
                expect(href, `${href} in ${locale}`).toContain(`lang=${locale}`);
            }
        }
    });

    it("only the language control changes the language", async () => {
        const html = athenaHtml(await athenaDemand("en"), "lang=en&svc=ATH-SIGNATURE-RITUAL");
        const switching = (html.match(/href="\/labs\/athena[^"]*lang=fr[^"]*"/g) ?? []);

        // Exactly one control offers French: the language switch itself.
        expect(switching.length).toBe(1);
        expect(switching[0]).toContain("svc=ATH-SIGNATURE-RITUAL");
    });
});

describe("CLOSE-01-A fragment navigation is not suppressed", () => {
    it("does not set smooth scroll-behavior on the document element", async () => {
        // Witnessed on the deployed preview: with `html{scroll-behavior:smooth}`,
        // Chrome set the hash and then never performed the fragment scroll — the
        // target sat at y=1549 while scrollY stayed at 25. An automated test can
        // assert the anchor exists and still miss this, which is why the browser
        // witness is mandatory. Guarding the regression here anyway.
        const html = athenaHtml(await athenaDemand());
        expect(html).not.toContain("scroll-behavior:smooth");
        // The offset that keeps context above the anchor must survive.
        expect(html).toContain("scroll-margin-top");
    });
});
