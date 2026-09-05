// Freshline Studio Bali — Multi-Market Configuration Plane
//
// Enforces the architecture invariant from AGENTS.md: ONE codebase serves
// MANY markets (1:MANY INSIDE), but each market's parameters are isolated
// to exactly ONE config file with no cross-market fallback or field
// borrowing (1:1 OUTSIDE). Core services must obtain market-specific values
// (timezone, closing ceiling, billing prefix, currency, feature flags)
// exclusively through `getActiveMarketConfig()` — never by importing a
// `config/*.market.json` file directly, and never by hardcoding a market's
// value inline. See AGENTS.md for the enforced rule this module exists to
// support.

import bali from "../../config/bali.market.json";
import bangkok from "../../config/bangkok.market.json";

export type MarketId = "bali" | "bangkok";
export type MarketStatus = "ACTIVE" | "PRE_LAUNCH" | "SUSPENDED";

export interface MarketConfig {
    marketId: string;
    displayName: string;
    status: MarketStatus;
    countryCode: string;
    region: string;
    timezone: string;
    locale: string;
    supportedLocales: string[];
    currency: {
        code: string;
        symbol: string;
        decimalDigits: number;
    };
    billing: {
        codePrefix: string;
        codePattern: string;
    };
    operatingHours: {
        openingHour: number;
        closingHour: number;
        closingMinute: number;
    };
    dispatch: {
        acceptanceTimeoutMinutes: number;
    };
    featureFlags: {
        whatsappParserEnabled: boolean;
        autoTimeoutRecoveryEnabled: boolean;
        autoDispatchEnabled: boolean;
        requireManualReviewOnAmbiguousIntent: boolean;
        killSwitch: boolean;
    };
}

const REGISTRY: Record<MarketId, MarketConfig> = {
    bali: bali as MarketConfig,
    bangkok: bangkok as MarketConfig
};

const REQUIRED_TOP_LEVEL_FIELDS: Array<keyof MarketConfig> = [
    "marketId",
    "status",
    "countryCode",
    "timezone",
    "locale",
    "currency",
    "billing",
    "operatingHours",
    "dispatch",
    "featureFlags"
];

/**
 * Minimal structural check that a market config wasn't hand-edited into an
 * incomplete/broken shape. Intentionally dependency-free (no schema
 * library) — this is a guard rail, not full validation.
 */
export function assertValidMarketConfig(config: MarketConfig): void {
    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
        if (config[field] === undefined || config[field] === null) {
            throw new Error(
                `Market config "${config.marketId ?? "<unknown>"}" is missing required field "${String(field)}"`
            );
        }
    }
    if (!/^\^.*\$$/.test(config.billing.codePattern)) {
        throw new Error(
            `Market config "${config.marketId}" has a suspicious billing.codePattern that is not anchored (^...$): ${config.billing.codePattern}`
        );
    }
}

/**
 * Loads a specific market's config by id. Throws on an unknown id rather
 * than silently falling back to another market — falling back would
 * violate the 1:1-outside isolation invariant (e.g. a Bangkok request
 * silently getting Bali's Asia/Makassar closing ceiling).
 */
export function loadMarketConfig(marketId: MarketId): MarketConfig {
    const config = REGISTRY[marketId];
    if (!config) {
        throw new Error(`Unknown marketId "${marketId}". Known markets: ${Object.keys(REGISTRY).join(", ")}`);
    }
    assertValidMarketConfig(config);
    return config;
}

/**
 * Resolves the active market from the ACTIVE_MARKET environment variable.
 * This is the single sanctioned entry point core services should use — see
 * AGENTS.md.
 */
export function getActiveMarketConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
    const marketId = (env["ACTIVE_MARKET"] ?? "bali") as MarketId;
    if (marketId !== "bali" && marketId !== "bangkok") {
        throw new Error(
            `ACTIVE_MARKET="${marketId}" is not a recognized market id. Known markets: ${Object.keys(REGISTRY).join(", ")}`
        );
    }
    return loadMarketConfig(marketId);
}
