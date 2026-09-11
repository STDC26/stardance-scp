// SCP-SHELL-04A-UAT-R1 — the single localization lookup.
//
// This logic was private to `src/host/page.ts`. Athena needs the same lookup for
// EN/FR, and hard stop #2 forbids a second localization architecture — so it was
// EXTRACTED here rather than duplicated, and `page.ts` now imports it. The body is
// unchanged, which is why Freshline's rendered output is still byte-identical to
// the golden recorded before any of this work started.
//
// One dictionary, one resolution rule, one fallback: `strings.json`, keyed
// section → key → locale, falling back to `en` and then to empty. An empty string
// is deliberate — a missing translation should leave a visible hole in UAT, not
// print a technical key at a customer.
//
// LOCK: language changes expression, not state, authority, eligibility,
// availability, price truth, commitment or fulfillment. Nothing in this module can
// reach any of those; it maps a key to a string.

import strings from "./strings.json";

type LocalizedEntry = Record<string, string>;

/** The locale used when a string has no entry for the requested one. */
export const FALLBACK_LOCALE = "en";

export function translate(section: string, key: string, locale: string): string {
    const table = (strings as unknown as Record<string, Record<string, LocalizedEntry>>)[section];
    const entry = table?.[key];
    return entry?.[locale] ?? entry?.[FALLBACK_LOCALE] ?? "";
}

/**
 * Resolves a requested locale against what a surface actually supports.
 *
 * Returns the first supported locale rather than throwing, because an unsupported
 * `?lang=` in a URL is a visitor typo, not a governed failure — and it must not be
 * able to change anything except which words appear.
 */
export function resolveLocale(
    requested: string | null | undefined,
    supported: readonly string[]
): string {
    const first = supported[0] ?? FALLBACK_LOCALE;
    if (requested === null || requested === undefined) {
        return first;
    }
    const normalized = requested.trim().toLowerCase();
    return supported.includes(normalized) ? normalized : first;
}
