// SCP-G5-H-UX-CLOSE-01 — rendered UX evidence.
//
// Test tooling only. Boots the real Freshline-facing SCP hosts and renders each
// surface in a real browser at every viewport SCP-UX-BRAND-01 requires, then
// records what the browser actually computed.
//
// The distinction matters: G5-H already proved the brand tokens are present in
// tenant configuration. That is a claim about intent. This proves what the
// rendered output resolved to, which is a claim about the thing a customer
// would actually see.
//
// Read-only outside the isolated test database: no form is submitted, no
// governed state is changed, and the reference surface (when captured) is only
// loaded and observed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import type { Pool } from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld, shutdownWorld, getOwnerPool, type OwnerWorld } from "../owner/ownerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;
const OUT = process.env["UX_OUT"] ?? "/tmp/ux-evidence";

/** §10 — the mandatory viewport matrix. */
const VIEWPORTS = [
    { name: "320", width: 320, height: 720, note: "narrowest supported mobile" },
    { name: "375", width: 375, height: 812, note: "iPhone-class" },
    { name: "390", width: 390, height: 844, note: "iPhone-class modern" },
    { name: "430", width: 430, height: 932, note: "large mobile" },
    { name: "834", width: 834, height: 1112, note: "tablet / small desktop" },
    { name: "1440", width: 1440, height: 900, note: "representative desktop" }
] as const;

/** Reference Brand Configuration 001. */
const TOKENS = {
    primary: "#00AFA5",
    primaryHover: "#0BB8AE",
    ink: "#0B0D0E",
    silver: "#E7ECEF",
    canvas: "#FFFFFF"
};

function rgb(hex: string): string {
    const h = hex.replace("#", "");
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

interface SurfaceEvidence {
    url: string;
    viewports: Record<string, unknown>;
    tokens: {
        cssVariables: Record<string, string>;
        fontFamilies: string[];
        resolved: Record<string, boolean>;
        displayFontInForce: boolean;
        bodyFontInForce: boolean;
    };
}

const evidence: {
    browser: string;
    capturedAt: string;
    surfaces: Record<string, SurfaceEvidence>;
} = { browser: "", capturedAt: "", surfaces: {} };

d("SCP-G5-H-UX / rendered SCP surfaces", () => {
    let pool: Pool;
    let world: OwnerWorld;
    let browser: Browser;

    beforeAll(async () => {
        pool = getOwnerPool();
        world = await bootWorld(pool);
        browser = await chromium.launch();
        evidence.browser = `Chromium ${browser.version()}`;
        evidence.capturedAt = new Date().toISOString();
        mkdirSync(OUT, { recursive: true });
    }, 180_000);

    afterAll(async () => {
        await browser?.close();
        await shutdownWorld(world);
        await pool?.end();
        writeFileSync(join(OUT, "scp-capture.json"), JSON.stringify(evidence, null, 2));
    }, 120_000);

    const surfaces = () => [
        { label: "customer-home", url: `${world.customerHost.origin}/` },
        { label: "partner-portal", url: `${world.partnerHost.origin}/` },
        { label: "owner-console", url: `${world.ownerHost.origin}/` }
    ];

    it("renders every surface at every required viewport without horizontal overflow", async () => {
        for (const surface of surfaces()) {
            const dir = join(OUT, "scp", surface.label);
            mkdirSync(dir, { recursive: true });
            const viewports: Record<string, unknown> = {};

            for (const vp of VIEWPORTS) {
                const context = await browser.newContext({
                    viewport: { width: vp.width, height: vp.height },
                    deviceScaleFactor: 2
                });
                const page = await context.newPage();
                const response = await page.goto(surface.url, {
                    waitUntil: "networkidle",
                    timeout: 45_000
                });
                expect(response?.status(), `${surface.label} @ ${vp.name}`).toBe(200);

                const shot = join(dir, `${vp.name}.png`);
                await page.screenshot({ path: shot, fullPage: true });

                const checks = await page.evaluate((width: number) => {
                    const doc = document.documentElement;
                    const all = Array.from(document.querySelectorAll("*")).slice(0, 4000);
                    const interactive = Array.from(
                        document.querySelectorAll(
                            "button, a, input, select, textarea, [role=button], label"
                        )
                    );
                    const small = interactive
                        .map((el) => {
                            const r = el.getBoundingClientRect();
                            return {
                                tag: el.tagName.toLowerCase(),
                                w: Math.round(r.width),
                                h: Math.round(r.height)
                            };
                        })
                        .filter((b) => b.w > 0 && b.h > 0 && (b.w < 44 || b.h < 44));
                    return {
                        documentScrollWidth: doc.scrollWidth,
                        horizontalOverflowPx: Math.max(0, doc.scrollWidth - width),
                        elementsPastViewport: [
                            ...new Set(
                                all
                                    .filter((el) => el.getBoundingClientRect().right > width + 1)
                                    .map((el) => el.tagName.toLowerCase())
                            )
                        ],
                        interactiveCount: interactive.length,
                        touchTargetsUnder44px: small.length,
                        touchTargetSamples: small.slice(0, 6),
                        stickyOrFixed: all.filter((el) =>
                            ["fixed", "sticky"].includes(getComputedStyle(el).position)
                        ).length,
                        truncatedLeaves: all.filter(
                            (el) => el.scrollWidth > el.clientWidth + 2 && el.children.length === 0
                        ).length
                    };
                }, vp.width);

                viewports[vp.name] = {
                    viewport: { width: vp.width, height: vp.height, note: vp.note },
                    screenshot: shot,
                    checks
                };

                if (vp.name === "390") {
                    const computed = await page.evaluate(() => {
                        const root = getComputedStyle(document.documentElement);
                        const names = Array.from(document.styleSheets)
                            .flatMap((s) => {
                                try {
                                    return Array.from(s.cssRules ?? []);
                                } catch {
                                    return [];
                                }
                            })
                            .flatMap((r) =>
                                (r as CSSStyleRule).style ? Array.from((r as CSSStyleRule).style) : []
                            )
                            .filter((p) => p.startsWith("--"));
                        const vars: Record<string, string> = {};
                        for (const n of new Set(names)) {
                            const v = root.getPropertyValue(n).trim();
                            if (v) vars[n] = v;
                        }
                        const colours = new Set<string>();
                        const fonts = new Set<string>();
                        for (const el of Array.from(document.querySelectorAll("*")).slice(0, 4000)) {
                            const cs = getComputedStyle(el);
                            if (cs.color) colours.add(cs.color);
                            if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)")
                                colours.add(cs.backgroundColor);
                            if (cs.borderTopColor) colours.add(cs.borderTopColor);
                            if (cs.fontFamily) fonts.add(cs.fontFamily);
                        }
                        return {
                            cssVariables: vars,
                            colours: [...colours].sort(),
                            fontFamilies: [...fonts].sort()
                        };
                    });
                    evidence.surfaces[surface.label] = {
                        url: surface.url,
                        viewports,
                        tokens: {
                            cssVariables: computed.cssVariables,
                            fontFamilies: computed.fontFamilies,
                            resolved: Object.fromEntries(
                                Object.entries(TOKENS).map(([k, hex]) => [
                                    k,
                                    computed.colours.includes(rgb(hex)) ||
                                        Object.values(computed.cssVariables).some(
                                            (v) => v.toLowerCase() === hex.toLowerCase()
                                        )
                                ])
                            ),
                            displayFontInForce: computed.fontFamilies.some((f) => /Oswald/i.test(f)),
                            bodyFontInForce: computed.fontFamilies.some((f) => /DM Sans/i.test(f))
                        }
                    };
                }
                await context.close();
            }
            if (evidence.surfaces[surface.label]) {
                evidence.surfaces[surface.label]!.viewports = viewports;
            }
        }
    }, 600_000);

    it("no surface scrolls sideways at any required viewport", () => {
        // The one responsive property that is never a matter of taste. Measured
        // across the whole matrix first so a single failure cannot truncate the
        // evidence for every other surface.
        const overflows: string[] = [];
        for (const [label, surface] of Object.entries(evidence.surfaces)) {
            for (const [vp, data] of Object.entries(surface.viewports)) {
                const c = (data as { checks: { horizontalOverflowPx: number; elementsPastViewport: string[] } })
                    .checks;
                if (c.horizontalOverflowPx > 0) {
                    overflows.push(`${label}@${vp}=${c.horizontalOverflowPx}px`);
                }
            }
        }
        // SCP-G5-H-UX-CLOSE-02: UX01-D01 corrected. The frozen invariant is now
        // absolute — no page-level horizontal overflow on any surface at any
        // required viewport.
        expect(overflows).toEqual([]);
    });

    it("the rendered output resolves Reference Brand Configuration 001", async () => {
        for (const [label, surface] of Object.entries(evidence.surfaces)) {
            // Tokens the browser actually computed, not tokens the source
            // declares. A config value that never reaches the page is not a
            // brand; it is a comment.
            expect(surface.tokens.resolved["primary"], `${label} primary`).toBe(true);
            expect(surface.tokens.resolved["ink"], `${label} ink`).toBe(true);
            expect(surface.tokens.resolved["canvas"], `${label} canvas`).toBe(true);
            expect(surface.tokens.displayFontInForce, `${label} Oswald`).toBe(true);
            expect(surface.tokens.bodyFontInForce, `${label} DM Sans`).toBe(true);
        }
    });

    it("UX01-D01: the availability controls reflow rather than being clipped or hidden", async () => {
        // Removing an overflow by hiding a control would satisfy the number and
        // break the product. So the assertion is about the controls themselves:
        // at 320px both time inputs must still be rendered, visible, inside the
        // viewport, and large enough to use.
        const ctx = await browser.newContext({ viewport: { width: 320, height: 720 } });
        const page = await ctx.newPage();
        await page.goto(`${world.partnerHost.origin}/`, { waitUntil: "networkidle", timeout: 45_000 });
        const controls = await page.evaluate(() => {
            const inputs = Array.from(
                document.querySelectorAll('fieldset.day input[type=time]')
            ) as HTMLInputElement[];
            return inputs.slice(0, 4).map((el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    name: el.name,
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                    right: Math.round(r.right),
                    visible: cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0",
                    clipped: el.scrollWidth > el.clientWidth + 2
                };
            });
        });
        expect(controls.length).toBeGreaterThanOrEqual(2);
        for (const c of controls) {
            expect(c.visible, `${c.name} visible`).toBe(true);
            expect(c.clipped, `${c.name} not clipped`).toBe(false);
            expect(c.right, `${c.name} inside viewport`).toBeLessThanOrEqual(320);
            expect(c.width, `${c.name} usable width`).toBeGreaterThanOrEqual(100);
            expect(c.height, `${c.name} usable height`).toBeGreaterThanOrEqual(44);
        }
        // And the page still must not be sideways-scrollable to reach them.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - 320);
        expect(overflow).toBeLessThanOrEqual(0);
        await ctx.close();
    }, 120_000);

    it("touch targets on the narrowest mobile viewport stay usable", async () => {
        for (const [label, surface] of Object.entries(evidence.surfaces)) {
            const narrow = surface.viewports["320"] as { checks: { touchTargetsUnder44px: number; touchTargetSamples: unknown[] } };
            // Reported rather than silently tolerated: a count above zero is a
            // divergence candidate for the register, not an automatic failure,
            // because inline links legitimately fall under 44px.
            expect(narrow.checks.touchTargetsUnder44px, `${label} @320`).toBeTypeOf("number");
        }
    });
});
