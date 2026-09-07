// SCP-G5-D — the customer-visible projection.
//
// A NON-AUTHORITATIVE view of the governed effective configuration, shaped for a
// customer surface. It owns nothing. Every value in it is derived at read time
// from the ACTIVE configuration the runtime resolved, so there are no duplicated
// Freshline constants anywhere in this codebase for a catalogue, a price, a
// region, an operating hour or a locale to drift away from.
//
// The projection carries the configuration version and checksum it was built
// from. That is not decoration: it is what lets a rendered page, a submitted
// intent and a persisted request be tied back to one governing configuration.

import { loadMarketConfig, type MarketId } from "../config/marketConfig";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";

export interface ProjectedPrice {
    minorUnits: number;
    currency: string;
    /** Presentation only. Never parsed back into a number by anything. */
    display: string;
}

export interface ProjectedService {
    code: string;
    name: string;
    price: ProjectedPrice;
    durationMinutes: number;
}

export interface ProjectedExtra {
    code: string;
    name: string;
    price: ProjectedPrice;
    extraDurationMinutes: number;
}

export interface CustomerProjection {
    /** Always false. This view is a projection, never a source of truth. */
    authoritative: false;
    brand: {
        name: string;
        publicName: string;
        marketDescriptor: string;
        tagline: string;
        colors: Record<string, string>;
        headingFont: string;
        bodyFont: string;
    };
    market: {
        marketId: string;
        timezone: string;
        currency: string;
        localeDefault: string;
        supportedLocales: string[];
        operatingHours: { open: string; close: string };
        /** Where the operating hours came from — canonical or approved override. */
        operatingHoursOrigin: string;
        regions: string[];
        accommodationTypes: string[];
        bookingWindow: { minLeadMinutes: number; maxAdvanceDays: number };
    };
    catalogue: {
        services: ProjectedService[];
        extras: ProjectedExtra[];
    };
    commerce: {
        /** Both false in G5-D. Rendered so the surface cannot imply otherwise. */
        paymentActive: boolean;
        paymentPolicy: string;
        dynamicPricingActive: boolean;
    };
    experience: {
        mobileFirst: boolean;
        regionSelection: string;
        preferredTimeSelection: string;
        /** WhatsApp is a coordination channel. It never owns state. */
        whatsappCoordinationEnabled: boolean;
    };
    provenance: {
        configurationVersion: number;
        configurationChecksum: string;
        schemaVersion: string;
        canonicalMarketId: string;
        tenantId: string;
        environment: string;
    };
}

function formatPrice(minorUnits: number, symbol: string, decimalDigits: number): string {
    const major = minorUnits / 10 ** decimalDigits;
    return `${symbol}${major.toLocaleString("en-US", {
        minimumFractionDigits: decimalDigits,
        maximumFractionDigits: decimalDigits
    })}`;
}

/**
 * Builds the customer projection. Only ACTIVE catalogue items are projected: an
 * inactive service or extra is not merely disabled in the UI, it never reaches
 * the surface at all, so it cannot be submitted by a client that ignores the UI.
 */
export function buildCustomerProjection(
    configuration: EffectiveConfiguration
): CustomerProjection {
    const canonical = loadMarketConfig(configuration.provenance.canonicalMarketId as MarketId);
    const { symbol, decimalDigits } = canonical.currency;
    const toPrice = (amount: number): ProjectedPrice => {
        const minorUnits = Math.round(amount * 10 ** decimalDigits);
        return {
            minorUnits,
            currency: configuration.priceCurrency.value,
            display: formatPrice(minorUnits, symbol, decimalDigits)
        };
    };

    return {
        authoritative: false,
        brand: {
            name: configuration.brand.name,
            publicName: configuration.brand.publicName,
            marketDescriptor: configuration.brand.marketDescriptor,
            tagline: configuration.brand.tagline,
            colors: { ...configuration.brand.design.colors },
            headingFont: configuration.brand.design.headingFont,
            bodyFont: configuration.brand.design.bodyFont
        },
        market: {
            marketId: configuration.identity.marketId,
            timezone: configuration.timezone.value,
            currency: configuration.priceCurrency.value,
            localeDefault: configuration.locales.default,
            supportedLocales: [...configuration.locales.supported],
            operatingHours: configuration.operatingHours.value,
            operatingHoursOrigin: configuration.operatingHours.origin,
            regions: [...configuration.coverage.regions],
            accommodationTypes: [...configuration.coverage.customerContext.accommodationTypes],
            bookingWindow: configuration.bookingWindow.value
        },
        catalogue: {
            services: configuration.catalogue.services
                .filter((s) => s.active)
                .map((s) => ({
                    code: s.code,
                    name: s.name,
                    price: toPrice(s.price.amount),
                    durationMinutes: s.durationMinutes
                })),
            extras: configuration.catalogue.extras
                .filter((e) => e.active)
                .map((e) => ({
                    code: e.code,
                    name: e.name,
                    price: toPrice(e.price.amount),
                    extraDurationMinutes: e.extraDurationMinutes
                }))
        },
        commerce: {
            paymentActive: configuration.commerce.payment.active,
            paymentPolicy: configuration.commerce.payment.policy,
            dynamicPricingActive: configuration.commerce.locationDynamicPricing.active
        },
        experience: {
            mobileFirst: configuration.experience.customer.mobileFirst,
            regionSelection: configuration.experience.customer.regionSelection,
            preferredTimeSelection: configuration.experience.customer.preferredTimeSelection,
            whatsappCoordinationEnabled: configuration.experience.channels.whatsapp.enabled
        },
        provenance: {
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            schemaVersion: configuration.provenance.schemaVersion,
            canonicalMarketId: configuration.provenance.canonicalMarketId,
            tenantId: configuration.identity.tenantId,
            environment: configuration.identity.environment
        }
    };
}
