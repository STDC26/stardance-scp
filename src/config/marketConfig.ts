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
import saigon from "../../config/saigon.market.json";
import penang from "../../config/penang.market.json";

export type MarketId = "bali" | "bangkok" | "saigon" | "penang";
export type MarketStatus = "ACTIVE" | "PRE_LAUNCH" | "SUSPENDED";

/**
 * G3: which fulfillment topology a market operates. Topology changes which
 * constraints apply, never the kernel or the commitment model.
 */
export type FulfillmentTopology = "MOBILE" | "INSTORE" | "HYBRID";

export interface MarketConfig {
    marketId: string;
    /**
     * G3: the tenant this market belongs to. Capacity, offers and holds are
     * tenant-scoped; a cross-tenant reference is refused rather than resolved.
     */
    tenantId: string;
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
    /** G3: topologies this market is permitted to sell through. */
    topology: {
        supported: FulfillmentTopology[];
        default: FulfillmentTopology;
    };
    /** G3: bookable-window policy. A request outside it is not sellable. */
    bookingWindow: {
        minLeadMinutes: number;
        maxAdvanceDays: number;
    };
    /** G3: how long a SellableOffer and its CapacityHold stay valid. */
    offer: {
        validityMinutes: number;
        capacityHoldTtlMinutes: number;
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
    bangkok: bangkok as MarketConfig,
    saigon: saigon as MarketConfig,
    penang: penang as MarketConfig
};

const REQUIRED_TOP_LEVEL_FIELDS: Array<keyof MarketConfig> = [
    "marketId",
    "tenantId",
    "status",
    "countryCode",
    "timezone",
    "locale",
    "currency",
    "billing",
    "operatingHours",
    "dispatch",
    "topology",
    "bookingWindow",
    "offer",
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
    // G3: a market must be able to sell through its own declared default.
    if (!config.topology.supported.includes(config.topology.default)) {
        throw new Error(
            `Market config "${config.marketId}" declares default topology ${config.topology.default} which is not in supported [${config.topology.supported.join(", ")}]`
        );
    }
}

/**
 * G3: whether this market may sell through a topology. Fails closed — an
 * unlisted topology is refused, never inferred from another market.
 */
export function marketSupportsTopology(
    config: MarketConfig,
    topology: FulfillmentTopology
): boolean {
    if (config.topology.supported.includes("HYBRID")) {
        // HYBRID means the market is configured for both concrete topologies.
        return topology === "MOBILE" || topology === "INSTORE" || topology === "HYBRID";
    }
    return config.topology.supported.includes(topology);
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
 * The market a local development process gets when it says nothing at all.
 *
 * SCP-DEPLOY-ID-01: this is a developer convenience and NOT a deployment
 * contract. A governed runtime must pass `requireExplicit`, which turns the
 * absence of the signal into a refusal — because a missing market selection is
 * not the same statement as selecting the default market.
 */
export const DEVELOPMENT_DEFAULT_MARKET: MarketId = "bali";

export type MarketSelectionRefusalCode = "MISSING_ACTIVE_MARKET" | "UNKNOWN_MARKET";

/**
 * Carries a machine-readable reason so a caller can distinguish "you did not
 * choose" from "you chose something that does not exist". A bare Error forces
 * callers to match on message text, which is how refusal semantics rot.
 */
export class MarketSelectionError extends Error {
    public readonly code: MarketSelectionRefusalCode;

    public constructor(code: MarketSelectionRefusalCode, message: string) {
        super(message);
        this.name = "MarketSelectionError";
        this.code = code;
    }
}

export interface MarketSelectionOptions {
    /**
     * Require the market-selection signal to be present. Governed deployments —
     * UAT, staging, production — set this. Absence then refuses instead of
     * resolving through the development default.
     */
    requireExplicit?: boolean;
}

/**
 * Resolves the active market from the ACTIVE_MARKET environment variable.
 * This is the single sanctioned entry point core services should use — see
 * AGENTS.md — and the only place in the codebase that interprets that signal.
 *
 * SCP-DEPLOY-ID-01 strengthened this function rather than adding a second
 * reader beside it. There is still exactly one registry, one parse, and one
 * validation; `requireExplicit` only changes what the ABSENCE of the signal
 * means, which is the whole ambiguity being removed.
 */
export function getActiveMarketConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: MarketSelectionOptions = {}
): MarketConfig {
    const signal = env["ACTIVE_MARKET"];

    if (signal === undefined) {
        if (options.requireExplicit === true) {
            throw new MarketSelectionError(
                "MISSING_ACTIVE_MARKET",
                "ACTIVE_MARKET is not set. A governed deployment must select its market explicitly; " +
                    "the absence of a market-selection signal is not a selection of the default market."
            );
        }
        return loadMarketConfig(DEVELOPMENT_DEFAULT_MARKET);
    }

    const marketId = signal as MarketId;
    if (!Object.prototype.hasOwnProperty.call(REGISTRY, marketId)) {
        throw new MarketSelectionError(
            "UNKNOWN_MARKET",
            `ACTIVE_MARKET="${marketId}" is not a recognized market id. Known markets: ${Object.keys(REGISTRY).join(", ")}`
        );
    }
    return loadMarketConfig(marketId);
}
