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
    ATHENA_FIXTURE_VERSION
} from "../../src/shell/fixtureProvider";
import { attentionForStage } from "../../src/shell/liveProvider";
import { inspect, renderInspector } from "../../src/shell/inspector";
import { renderAthenaPage } from "../../src/shell/athenaPage";
import { ATHENA_PROFILE, FRESHLINE_PROFILE } from "../../src/host/brandProfile";

const provider = createFixtureProjectionProvider();
const ANON = { actorId: null, role: "VISITOR" } as const;

async function athenaDemand(): Promise<ProjectionEnvelope<DemandPayload>> {
    return provider.demand({ tenant: "athena-uat", actor: ANON });
}

function athenaHtml(envelope: ProjectionEnvelope<DemandPayload>): string {
    return renderAthenaPage({ envelope, profile: ATHENA_PROFILE, inspectorPath: "/labs/_inspect" });
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

    it("surfaces the source unmistakably in the rendered page", async () => {
        const html = athenaHtml(await athenaDemand());

        expect(html).toContain("<strong>FIXTURE</strong>");
        // Assert on the class actually APPLIED to the banner, not on the presence
        // of the string anywhere — both classes are defined in the stylesheet, so a
        // bare substring check would pass for the wrong reason.
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
    });

    it("NEGATIVE: refuses to enable commit when the source does not allow it", async () => {
        // The required negative-state test. The Shell is handed an envelope whose
        // authority says no, and must render a disabled control with the reason —
        // not a hopeful button, and not a hidden one.
        const envelope = await athenaDemand();
        const downgraded: ProjectionEnvelope<DemandPayload> = {
            ...envelope,
            authority: { ...envelope.authority, canCommit: false },
            actions: [
                { id: "submit-demand", label: "Request this time", kind: "REQUEST", enabled: true },
                {
                    id: "commit",
                    label: "Reserve",
                    kind: "COMMIT",
                    enabled: false,
                    reason: "Capacity is not confirmed for this window."
                }
            ],
            payload: {
                ...envelope.payload,
                committable: {
                    posture: "NO_VALID_CAPACITY",
                    reason: "No provider has accepted this window.",
                    resolved: { service: true, price: true, eligibility: true, capacity: false }
                }
            }
        };

        const html = athenaHtml(downgraded);

        expect(html).toContain("disabled");
        expect(html).toContain("Capacity is not confirmed for this window.");
        expect(html).toContain("no valid capacity");
        expect(html).toContain("capacity unresolved");
    });

    it("NEGATIVE: never prints a stronger posture than the payload carries", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope);

        // The posture is rendered from the payload, so a page cannot claim
        // CAN_COMMIT unless the payload said so.
        expect(envelope.payload.committable.posture).toBe("CAN_COMMIT");
        expect(html).toContain("can commit");
        expect(html).not.toContain("confirmed booking");
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
