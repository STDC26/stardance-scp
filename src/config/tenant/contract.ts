// SCP Tenant Configuration — the governed contract.
//
// G5-B expresses a tenant's accepted behavior as CONFIGURATION, so that
// Freshline-specific brand, market, catalogue, commerce, operations and
// experience requirements never become reusable Core logic. Nothing in this
// file is imported by src/core, src/kernel or src/lifecycle: the configuration
// plane sits beside Core, not inside it.
//
// The six planes are explicit top-level keys rather than an implied shape, so
// "all six planes are present" is a fact a validator and a reviewer can both
// check without interpretation.

export const CONFIGURATION_PLANES = [
    "BRAND",
    "MARKET",
    "CATALOGUE",
    "COMMERCE",
    "OPERATIONS",
    "EXPERIENCE"
] as const;

export type ConfigurationPlane = (typeof CONFIGURATION_PLANES)[number];

export const TENANT_CONFIG_SCHEMA_VERSION = "scp.tenant.configuration.v1" as const;

/**
 * G5-C schema v2 — retires R18.
 *
 * v1 let the tenant plane restate values the canonical SCP market plane already
 * owns (timezone, currency, operating hours), and they drifted: Core declared a
 * 09:00 opening while the tenant bundle declared 08:00. Two independently
 * authoritative values for one runtime semantic is precisely the failure mode
 * R18 named.
 *
 * v2 removes those fields from the tenant plane entirely, so a duplicate is not
 * merely rejected — it is unrepresentable. The tenant plane REFERENCES the
 * canonical market and may state bounded, explicit APPROVED OVERRIDES. The
 * runtime resolves one effective configuration from the two.
 */
export const TENANT_CONFIG_SCHEMA_VERSION_V2 = "scp.tenant.configuration.v2" as const;

export type TenantConfigSchemaVersion =
    | typeof TENANT_CONFIG_SCHEMA_VERSION
    | typeof TENANT_CONFIG_SCHEMA_VERSION_V2;

/** Lifecycle of a configuration bundle version. */
export const CONFIGURATION_STATES = [
    "DRAFT",
    "VALIDATED",
    "APPROVED",
    "ACTIVE",
    "SUPERSEDED",
    "REJECTED"
] as const;

export type ConfigurationState = (typeof CONFIGURATION_STATES)[number];

export interface BrandPlane {
    name: string;
    publicName: string;
    marketDescriptor: string;
    tagline: string;
    design: {
        headingFont: string;
        bodyFont: string;
        colors: Record<string, string>;
    };
}

export interface MarketPlane {
    id: string;
    country: string;
    timezone: string;
    localeDefault: string;
    supportedLocales: string[];
    currency: {
        price: string;
        display: string;
    };
    operatingHours: {
        daily: { open: string; close: string };
    };
    coverage: {
        regions: string[];
        customerContext: {
            accommodationTypes: string[];
        };
    };
}

/**
 * v2 market plane. Deliberately carries NO timezone, currency or operating
 * hours: those belong to the canonical SCP market configuration referenced by
 * `marketConfigurationRef`.
 */
export interface MarketPlaneV2 {
    id: string;
    country: string;
    localeDefault: string;
    supportedLocales: string[];
    /** The canonical SCP market whose configuration is authoritative. */
    marketConfigurationRef: string;
    /** Bounded, explicit divergence from the canonical market. */
    approvedOverrides: {
        operatingHours: { daily: { open: string; close: string } } | null;
    };
    coverage: {
        regions: string[];
        customerContext: { accommodationTypes: string[] };
    };
}

/** v2 commerce plane: price/display currency are derived, not restated. */
export interface CommercePlaneV2 {
    locationDynamicPricing: CommercePlane["locationDynamicPricing"];
    payment: {
        capability: PaymentCapability;
        active: boolean;
        policy: PaymentPolicy;
        processorAdapter: { configured: boolean; contractReserved: boolean };
        platformFeePolicy: { shapeReserved: boolean; active: boolean };
        currencies: {
            /** Payment-specific only. Null while payment is inactive. */
            chargeCurrency: string | null;
            settlementCurrency: string | null;
        };
        financialAuditBoundary: { required: boolean };
    };
}

export interface TenantConfigurationBundleV2
    extends Omit<TenantConfigurationBundle, "schemaVersion" | "planes"> {
    schemaVersion: typeof TENANT_CONFIG_SCHEMA_VERSION_V2;
    planes: {
        BRAND: BrandPlane;
        MARKET: MarketPlaneV2;
        CATALOGUE: CataloguePlane;
        COMMERCE: CommercePlaneV2;
        OPERATIONS: OperationsPlane;
        EXPERIENCE: ExperiencePlane;
    };
}

export type AnyTenantConfigurationBundle =
    | TenantConfigurationBundle
    | TenantConfigurationBundleV2;

export interface CataloguePrice {
    amount: number;
    currency: string;
}

export interface CatalogueService {
    /** Stable internal identity. Display names are never authoritative. */
    code: string;
    name: string;
    price: CataloguePrice;
    /** Required for exclusive-capacity semantics (G5A-G09). */
    durationMinutes: number;
    active: boolean;
}

export interface CatalogueExtra {
    code: string;
    name: string;
    price: CataloguePrice;
    /** Additional exclusive capacity this extra consumes. */
    extraDurationMinutes: number;
    active: boolean;
}

export interface CataloguePlane {
    services: CatalogueService[];
    extras: CatalogueExtra[];
}

export type PaymentCapability = "READY" | "NOT_READY";
export type PaymentPolicy = "OFFLINE" | "ONLINE" | "DEFERRED";

export interface CommercePlane {
    locationDynamicPricing: {
        prepared: boolean;
        active: boolean;
        /** Must be empty while inactive. */
        rules: unknown[];
    };
    payment: {
        capability: PaymentCapability;
        active: boolean;
        policy: PaymentPolicy;
        processorAdapter: {
            configured: boolean;
            contractReserved: boolean;
        };
        platformFeePolicy: {
            shapeReserved: boolean;
            active: boolean;
        };
        currencies: {
            priceCurrency: string;
            displayCurrency: string;
            /** Null while payment is inactive. */
            chargeCurrency: string | null;
            settlementCurrency: string | null;
        };
        financialAuditBoundary: {
            required: boolean;
        };
    };
}

export interface OperationsPlane {
    provider: {
        approvalRequired: boolean;
        ownerConfirmedAvailabilityRequired: boolean;
        strictEligibilityRequired: boolean;
    };
    lifecycle: {
        ownerQualificationRequired: boolean;
        providerAcceptanceDoesNotAssign: boolean;
        ownerAssignmentRequired: boolean;
        customerConfirmationSeparate: boolean;
    };
    scheduling: {
        weekStartsOn: string;
        nonOverlapRequired: boolean;
    };
    recovery: {
        noMatchRecoveryEnabled: boolean;
        reassignmentSupported: boolean;
        amendmentRequiredForCustomerCommitmentChange: boolean;
    };
}

export interface ExperiencePlane {
    providerExperience: {
        canonicalAggregateTerm: "PROVIDER";
        /** Experience vocabulary only. It grants no aggregate of its own. */
        tenantExperienceTerm: string;
        displayIdPrefixes: Record<string, string>;
        ratingCommission: {
            state: "UNRESOLVED" | "RESOLVED";
            active: boolean;
        };
    };
    customer: {
        mobileFirst: boolean;
        regionSelection: string;
        preferredTimeSelection: string;
        whatsappEnabled: boolean;
    };
    provider: {
        bilingual: { default: string; supported: string[] };
        cognitionChips: boolean;
        availabilityChips: boolean;
        vicinityChips: boolean;
        applyToAllDays: boolean;
    };
    owner: {
        approvalWorkflows: boolean;
        coverageView: boolean;
        lifecycleCommandView: boolean;
    };
    channels: {
        whatsapp: {
            enabled: boolean;
            /** Must be false: WhatsApp carries intent, SCP owns state. */
            authoritativeStateOwner: boolean;
            adapterRequired: boolean;
        };
    };
}

export interface MeasurementConfiguration {
    canonicalSource: "SCP_EVENTS_AND_RECORDS";
    lineage: {
        /** Neither may be disabled. */
        tenantRequired: boolean;
        marketRequired: boolean;
    };
    reporting: {
        mayCreateProjections: boolean;
        /** Must be false: projections never own business truth. */
        mayOwnBusinessTruth: boolean;
    };
    projectionBoundaries: Record<string, string>;
    cladConstraints: {
        /** All three must be false. */
        cladSpecificInferredStatesInScpCore: boolean;
        psychologicalProfileFields: boolean;
        transactionalAuthority: boolean;
    };
}

export interface TenantIdentity {
    id: string;
    organization: string;
    brand: string;
    market: string;
    status: string;
}

/**
 * Human-facing provenance carried inside the bundle. It PARTICIPATES in the
 * checksum deliberately: `ccSuppliedValues` declares which values are
 * engineering assumptions rather than confirmed business facts, so changing
 * that declaration is a real configuration change, not a comment edit.
 */
export interface BundleMeta {
    artifact: string;
    purpose: string;
    ccSuppliedValues: string[];
    notCarriedForward: string[];
}

export interface TenantConfigurationBundle {
    _meta?: BundleMeta;
    schemaVersion: typeof TENANT_CONFIG_SCHEMA_VERSION;
    configurationVersion: number;
    environment: string;
    tenant: TenantIdentity;
    planes: {
        BRAND: BrandPlane;
        MARKET: MarketPlane;
        CATALOGUE: CataloguePlane;
        COMMERCE: CommercePlane;
        OPERATIONS: OperationsPlane;
        EXPERIENCE: ExperiencePlane;
    };
    measurement: MeasurementConfiguration;
}

/** Provenance recorded alongside every persisted bundle version. */
export interface ConfigurationProvenance {
    configurationVersion: number;
    schemaVersion: string;
    createdAt: Date;
    activatedAt: Date | null;
    actorOrAuthority: string;
    sourceReference: string;
    predecessorVersion: number | null;
    checksum: string;
    environment: string;
    tenantId: string;
    marketId: string;
}
