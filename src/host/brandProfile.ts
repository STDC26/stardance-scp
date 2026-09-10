// C5 — the Brand Experience Profile.
//
// LOCK (EXE-01A §3.3): "Brand Experience Profile changes expression, not commerce
// truth." Read the fields below and notice what is absent: no price, no service,
// no availability, no eligibility, no state, no action, no authority. A profile
// cannot make a business sell something different, only present it differently.
// Theme changes appearance; a profile changes expression; neither touches truth.
//
// Every value in FRESHLINE_PROFILE is lifted verbatim out of the CSS that was
// already inline in `page.ts`, which is why passing it produces byte-identical
// output — asserted by a hash recorded before the extraction existed. The seam
// was extracted from the proven renderer rather than replacing it.
//
// ATHENA_PROFILE is the second point of evidence that the seam is real: material
// differentiation with no change to Core, no change to the projection contract,
// and no tenant branch anywhere in domain code.

export type CompositionMode = "STACKED_COMPACT" | "EDITORIAL_SPACIOUS";
export type MerchandisingMode = "LIST_DENSE" | "CARD_FEATURE";
export type PacingMode = "IMMEDIATE" | "PROGRESSIVE";

export interface BrandExperienceProfile {
    id: string;

    /** Font stacks appended after the projection's configured families. */
    headingFallback: string;
    bodyFallback: string;

    /** Measure and rhythm. */
    contentMaxWidth: string;
    contentPadding: string;
    baseFontSize: string;
    baseLineHeight: string;
    sectionMargin: string;
    chipGap: string;
    radius: string;

    /** Display voice. */
    h1Size: string;
    h1Weight: string;
    h1LetterSpacing: string;
    h2Transform: string;
    h2LetterSpacing: string;

    /**
     * Structural posture. Consumed by the Athena renderer; the Freshline renderer
     * predates these and keeps its own composition, which is exactly the
     * "extract, don't redesign" instruction.
     */
    composition: CompositionMode;
    merchandising: MerchandisingMode;
    pacing: PacingMode;
}

/**
 * Freshline as it is today: fast, direct, mobile-first, operationally concise.
 * A narrow 560px measure, tight 8px chip gaps, condensed uppercase headings.
 */
export const FRESHLINE_PROFILE: BrandExperienceProfile = {
    id: "freshline.brand.v1",
    headingFallback: '"Oswald",system-ui,sans-serif',
    bodyFallback: '"DM Sans",system-ui,-apple-system,sans-serif',
    contentMaxWidth: "560px",
    contentPadding: "20px 16px 96px",
    baseFontSize: "16px",
    baseLineHeight: "1.5",
    sectionMargin: "28px 0 10px",
    chipGap: "8px",
    radius: "12px",
    h1Size: "1.6rem",
    h1Weight: "700",
    h1LetterSpacing: ".02em",
    h2Transform: "uppercase",
    h2LetterSpacing: ".08em",
    composition: "STACKED_COMPACT",
    merchandising: "LIST_DENSE",
    pacing: "IMMEDIATE"
};

/**
 * Athena: premium, editorial, spacious, high-trust.
 *
 * Wider measure, generous vertical rhythm, a serif display face at a much larger
 * size, no uppercase shouting, positive letter-spacing on section labels, and a
 * progressive rather than immediate pace. The intent is that a neutral observer
 * would not guess these two surfaces share a platform.
 */
export const ATHENA_PROFILE: BrandExperienceProfile = {
    id: "athena.brand.v1",
    headingFallback: '"Iowan Old Style",Georgia,"Times New Roman",serif',
    bodyFallback: 'system-ui,-apple-system,"Segoe UI",sans-serif',
    contentMaxWidth: "1080px",
    contentPadding: "56px 32px 140px",
    baseFontSize: "17px",
    baseLineHeight: "1.75",
    sectionMargin: "72px 0 28px",
    chipGap: "20px",
    radius: "2px",
    h1Size: "3.25rem",
    h1Weight: "400",
    h1LetterSpacing: "-0.02em",
    h2Transform: "none",
    h2LetterSpacing: "0.18em",
    composition: "EDITORIAL_SPACIOUS",
    merchandising: "CARD_FEATURE",
    pacing: "PROGRESSIVE"
};

/** Profiles by tenant. A miss falls back to nothing — the caller decides. */
export const BRAND_PROFILES: Readonly<Record<string, BrandExperienceProfile>> = {
    "freshline-uat": FRESHLINE_PROFILE,
    "athena-uat": ATHENA_PROFILE
};

export function brandProfileFor(tenant: string): BrandExperienceProfile | undefined {
    return Object.prototype.hasOwnProperty.call(BRAND_PROFILES, tenant)
        ? BRAND_PROFILES[tenant]
        : undefined;
}
