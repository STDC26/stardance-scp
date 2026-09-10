// Test support — a deterministic CustomerProjection.
//
// Built by hand rather than from the database so the Freshline byte-identity
// proof in C5 is a unit test with no external dependency. The values are
// arbitrary but FIXED: what the assertion cares about is that rendering the same
// projection produces the same bytes before and after the Brand Experience
// Profile extraction.

import type { CustomerProjection } from "../../src/customer/projection";

export function customerProjectionFixture(): CustomerProjection {
    return {
        authoritative: false,
        brand: {
            name: "freshline",
            publicName: "Freshline Studio",
            marketDescriptor: "Bali · mobile service",
            tagline: "Booked today, done today.",
            colors: {
                primaryBlack: "#0B0D0E",
                freshlineTeal: "#00AFA5",
                tealHover: "#00958C",
                silver: "#E7ECEF",
                white: "#FFFFFF"
            },
            headingFont: "'Inter', sans-serif",
            bodyFont: "'Inter', sans-serif"
        },
        market: {
            marketId: "bali",
            timezone: "Asia/Makassar",
            currency: "IDR",
            localeDefault: "en-US",
            supportedLocales: ["en-US", "id-ID"],
            operatingHours: { open: "09:00", close: "23:00" },
            operatingHoursOrigin: "CANONICAL",
            regions: ["Canggu", "Seminyak", "Ubud"],
            accommodationTypes: ["VILLA", "HOTEL", "APARTMENT"],
            bookingWindow: { minLeadMinutes: 120, maxAdvanceDays: 60 }
        },
        catalogue: {
            services: [
                {
                    code: "FL-CLASSIC",
                    name: "Classic Treatment",
                    price: { minorUnits: 45_000_000, currency: "IDR", display: "Rp450,000.00" },
                    durationMinutes: 60
                },
                {
                    code: "FL-EXTENDED",
                    name: "Extended Treatment",
                    price: { minorUnits: 65_000_000, currency: "IDR", display: "Rp650,000.00" },
                    durationMinutes: 90
                }
            ],
            extras: [
                {
                    code: "FL-SCALP",
                    name: "Scalp Add-on",
                    price: { minorUnits: 12_000_000, currency: "IDR", display: "Rp120,000.00" },
                    extraDurationMinutes: 15
                }
            ]
        },
        commerce: {
            paymentActive: false,
            paymentPolicy: "PAY_ON_SERVICE",
            dynamicPricingActive: false
        },
        experience: {
            mobileFirst: true,
            regionSelection: "REQUIRED",
            preferredTimeSelection: "CHIPS",
            whatsappCoordinationEnabled: true
        },
        provenance: {
            configurationVersion: 2,
            configurationChecksum: "fixture-checksum-0000000000000000",
            schemaVersion: "scp.tenant.configuration.v2",
            canonicalMarketId: "bali",
            tenantId: "freshline-uat",
            environment: "uat"
        }
    };
}
