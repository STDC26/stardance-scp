// SCP-SHELL-04A-UAT-R1 — one formatting boundary for all Shell money.
//
// MARKET ≠ CURRENCY ≠ LANGUAGE. This module is where that separation is actually
// enforced: the currency comes from the projection payload, the locale comes from
// the request, and the market is not consulted at all. Athena is a `bali` tenant
// presenting EUR in French, and nothing here needs to know that is unusual.
//
// There is no tenant in this file's vocabulary. `if (tenant === "athena")` is the
// shape this exists to make unnecessary — a per-tenant branch in a formatter is how
// a platform ends up with as many renderers as customers.
//
// The AMOUNT is never touched. `minorUnits` is authoritative and identical across
// every locale; only its presentation changes. That is the invariance the
// localization tests assert, and it is a one-line guarantee here because the
// function's only input for the number is `minorUnits`.

/** Minor units per major unit, for currencies that are not two-decimal. */
const EXPONENT: Readonly<Record<string, number>> = {
    // Rupiah is quoted without decimals in market; SCP stores it at 2dp.
    IDR: 2,
    EUR: 2,
    USD: 2,
    GBP: 2,
    // Zero-decimal currencies, listed so a future market does not silently
    // acquire two decimal places it does not have.
    JPY: 0,
    KRW: 0,
    VND: 0
};

export function currencyExponent(currency: string): number {
    return EXPONENT[currency.toUpperCase()] ?? 2;
}

/**
 * Formats a monetary amount for display.
 *
 * Locale-aware by construction: `Intl.NumberFormat` yields `€185.00` for `en` and
 * `185,00 €` for `fr`, which is the difference UAT-R1 §5 asks to see — and it comes
 * from the platform rather than from hand-built strings per language.
 */
export function formatMoney(minorUnits: number, currency: string, locale: string): string {
    const exponent = currencyExponent(currency);
    const major = minorUnits / 10 ** exponent;

    try {
        return new Intl.NumberFormat(localeTag(locale), {
            style: "currency",
            currency: currency.toUpperCase(),
            minimumFractionDigits: exponent,
            maximumFractionDigits: exponent
        }).format(major);
    } catch {
        // An unknown currency code must not take a page down. Degrade to a plain
        // amount with the code, which is ugly and unmistakably not a real price.
        return `${currency.toUpperCase()} ${major.toFixed(exponent)}`;
    }
}

/**
 * Maps a bare language tag to the regional tag whose conventions we want.
 *
 * `fr` alone already produces French grouping and a trailing symbol, so this is
 * about being explicit rather than about fixing a defect.
 */
function localeTag(locale: string): string {
    switch (locale.toLowerCase()) {
        case "en":
            return "en-US";
        case "fr":
            return "fr-FR";
        case "id":
            return "id-ID";
        default:
            return locale;
    }
}
