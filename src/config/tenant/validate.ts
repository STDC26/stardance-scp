// SCP Tenant Configuration — validation.
//
// Every rule the G5-B contract enumerates, made executable. A configuration
// that fails any of these cannot be activated, so the guarantees below are
// structural rather than procedural:
//
//   * an inactive capability cannot carry active machinery
//   * a tenant cannot configure away a canonical SCP invariant
//   * measurement lineage cannot be switched off
//   * no CLAD-specific inferred state may enter Core configuration
//   * legacy `appointments` may never be named as canonical authority
//
// CORR-01: the PRIMARY semantic control is now the closed schema in schema.ts —
// an allowlist, so an undeclared field is rejected regardless of what it is
// called. The prohibited-token scan below is retained only as defense-in-depth.
// CORR-02: every load-bearing OPERATIONS authority flag is an executable
// invariant; it must be present AND true, and the closed schema prevents an
// alternate field or path being used to override it.

import {
    CONFIGURATION_PLANES,
    TENANT_CONFIG_SCHEMA_VERSION,
    type TenantConfigurationBundle
} from "./contract";
import { checkAgainstSchema } from "./schema";

export interface ValidationFinding {
    code: string;
    path: string;
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    findings: ValidationFinding[];
}

const ISO_CURRENCY = /^[A-Z]{3}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
const COUNTRY = /^[A-Z]{2}$/;
const CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Field names that would introduce CLAD-specific inferred state or
 * psychological profiling into Core configuration. Presence anywhere in the
 * bundle is a hard failure — SCP records Service-Commerce truth; CLAD
 * interprets from that truth and never writes into it.
 */
const FORBIDDEN_FIELD_TOKENS = [
    "clad",
    "psychologic",
    "personality",
    "sentimentprofile",
    "inferredstate",
    "inferredintent",
    "propensity",
    "psychograph"
];

/** Configuration may never name the legacy surface as canonical authority. */
const FORBIDDEN_AUTHORITY_TOKENS = ["appointments"];

export function validateTenantConfiguration(
    bundle: TenantConfigurationBundle
): ValidationResult {
    const findings: ValidationFinding[] = [];
    const fail = (code: string, path: string, message: string) =>
        findings.push({ code, path, message });

    // --- closed schema: undeclared fields are rejected anywhere, at any depth
    for (const violation of checkAgainstSchema(bundle)) {
        fail(violation.code, violation.path, violation.message);
    }

    // --- schema envelope ---------------------------------------------------
    if (bundle.schemaVersion !== TENANT_CONFIG_SCHEMA_VERSION) {
        fail("SCHEMA_VERSION_UNSUPPORTED", "schemaVersion", `expected ${TENANT_CONFIG_SCHEMA_VERSION}`);
    }
    if (!Number.isInteger(bundle.configurationVersion) || bundle.configurationVersion < 1) {
        fail("CONFIGURATION_VERSION_INVALID", "configurationVersion", "must be an integer >= 1");
    }
    if (!bundle.environment || typeof bundle.environment !== "string") {
        fail("ENVIRONMENT_REQUIRED", "environment", "environment is required");
    }

    // --- tenant identity ---------------------------------------------------
    const tenant = bundle.tenant;
    if (!tenant || typeof tenant.id !== "string" || tenant.id.trim() === "") {
        fail("TENANT_REQUIRED", "tenant.id", "tenant id is required");
    }
    for (const field of ["organization", "brand", "market", "status"] as const) {
        if (!tenant || typeof tenant[field] !== "string" || tenant[field].trim() === "") {
            fail("TENANT_FIELD_REQUIRED", `tenant.${field}`, `tenant ${field} is required`);
        }
    }

    // --- all six planes present -------------------------------------------
    const planes = bundle.planes ?? ({} as TenantConfigurationBundle["planes"]);
    for (const plane of CONFIGURATION_PLANES) {
        if (!planes[plane] || typeof planes[plane] !== "object") {
            fail("PLANE_MISSING", `planes.${plane}`, `configuration plane ${plane} is required`);
        }
    }
    if (findings.some((f) => f.code === "PLANE_MISSING")) {
        return { valid: false, findings };
    }

    // --- MARKET -------------------------------------------------------------
    const market = planes.MARKET;
    if (!market.id || market.id !== tenant.market) {
        fail("MARKET_INVALID", "planes.MARKET.id", "market id must match tenant.market");
    }
    if (!COUNTRY.test(market.country ?? "")) {
        fail("MARKET_INVALID", "planes.MARKET.country", "country must be an ISO 3166-1 alpha-2 code");
    }
    if (!market.timezone || !market.timezone.includes("/")) {
        fail("MARKET_INVALID", "planes.MARKET.timezone", "timezone must be an IANA zone");
    }
    if (!LOCALE.test(market.localeDefault ?? "")) {
        fail("LOCALE_INVALID", "planes.MARKET.localeDefault", "default locale is malformed");
    }
    if (!Array.isArray(market.supportedLocales) || market.supportedLocales.length === 0) {
        fail("LOCALE_INVALID", "planes.MARKET.supportedLocales", "at least one locale is required");
    } else {
        for (const locale of market.supportedLocales) {
            if (!LOCALE.test(locale)) {
                fail("LOCALE_INVALID", "planes.MARKET.supportedLocales", `malformed locale ${locale}`);
            }
        }
        if (!market.supportedLocales.includes(market.localeDefault)) {
            fail(
                "LOCALE_INVALID",
                "planes.MARKET.localeDefault",
                "default locale must be among supported locales"
            );
        }
    }
    for (const key of ["price", "display"] as const) {
        if (!ISO_CURRENCY.test(market.currency?.[key] ?? "")) {
            fail("CURRENCY_INVALID", `planes.MARKET.currency.${key}`, "must be an ISO 4217 code");
        }
    }
    const hours = market.operatingHours?.daily;
    if (!hours || !HHMM.test(hours.open ?? "") || !HHMM.test(hours.close ?? "")) {
        fail("OPERATING_HOURS_INVALID", "planes.MARKET.operatingHours.daily", "times must be HH:MM");
    } else if (toMinutes(hours.close) <= toMinutes(hours.open)) {
        fail(
            "OPERATING_HOURS_INVALID",
            "planes.MARKET.operatingHours.daily",
            "close must be after open"
        );
    }
    if (!Array.isArray(market.coverage?.regions) || market.coverage.regions.length === 0) {
        fail("REGIONS_REQUIRED", "planes.MARKET.coverage.regions", "at least one region is required");
    }

    // --- CATALOGUE ----------------------------------------------------------
    const catalogue = planes.CATALOGUE;
    validateCodedItems(
        catalogue.services ?? [],
        "planes.CATALOGUE.services",
        "SERVICE",
        market.currency?.price,
        fail
    );
    validateCodedItems(
        catalogue.extras ?? [],
        "planes.CATALOGUE.extras",
        "EXTRA",
        market.currency?.price,
        fail
    );
    for (const [index, service] of (catalogue.services ?? []).entries()) {
        if (!Number.isInteger(service.durationMinutes) || service.durationMinutes <= 0) {
            fail(
                "SERVICE_DURATION_INVALID",
                `planes.CATALOGUE.services[${index}].durationMinutes`,
                "a positive duration is required for exclusive-capacity semantics"
            );
        }
    }
    for (const [index, extra] of (catalogue.extras ?? []).entries()) {
        if (!Number.isInteger(extra.extraDurationMinutes) || extra.extraDurationMinutes < 0) {
            fail(
                "EXTRA_DURATION_INVALID",
                `planes.CATALOGUE.extras[${index}].extraDurationMinutes`,
                "extra duration must be a non-negative integer"
            );
        }
    }

    // --- COMMERCE -----------------------------------------------------------
    const commerce = planes.COMMERCE;
    const payment = commerce.payment;
    if (payment.active && payment.policy === "OFFLINE") {
        fail(
            "PAYMENT_POLICY_INCOHERENT",
            "planes.COMMERCE.payment",
            "an OFFLINE policy cannot be active"
        );
    }
    if (payment.active && !payment.processorAdapter.configured) {
        fail(
            "PAYMENT_POLICY_INCOHERENT",
            "planes.COMMERCE.payment",
            "payment cannot be active without a configured processor adapter"
        );
    }
    if (!payment.active && payment.processorAdapter.configured) {
        fail(
            "INACTIVE_PAYMENT_NOT_INERT",
            "planes.COMMERCE.payment.processorAdapter",
            "an inactive payment capability must not carry a configured processor"
        );
    }
    if (!payment.active && payment.platformFeePolicy.active) {
        fail(
            "INACTIVE_PAYMENT_NOT_INERT",
            "planes.COMMERCE.payment.platformFeePolicy",
            "platform fee policy cannot be active while payment is inactive"
        );
    }
    if (!payment.active) {
        for (const key of ["chargeCurrency", "settlementCurrency"] as const) {
            if (payment.currencies[key] !== null) {
                fail(
                    "INACTIVE_PAYMENT_NOT_INERT",
                    `planes.COMMERCE.payment.currencies.${key}`,
                    "must be null while payment is inactive"
                );
            }
        }
    }
    for (const key of ["priceCurrency", "displayCurrency"] as const) {
        if (!ISO_CURRENCY.test(payment.currencies[key] ?? "")) {
            fail("CURRENCY_INVALID", `planes.COMMERCE.payment.currencies.${key}`, "must be ISO 4217");
        }
    }
    if (payment.currencies.priceCurrency !== market.currency?.price) {
        fail(
            "CURRENCY_INVALID",
            "planes.COMMERCE.payment.currencies.priceCurrency",
            "price currency must agree with the market plane"
        );
    }
    if (!payment.financialAuditBoundary.required) {
        fail(
            "AUDIT_BOUNDARY_REQUIRED",
            "planes.COMMERCE.payment.financialAuditBoundary",
            "the financial audit boundary is mandatory"
        );
    }
    const dynamic = commerce.locationDynamicPricing;
    if (!dynamic.active && Array.isArray(dynamic.rules) && dynamic.rules.length > 0) {
        fail(
            "INACTIVE_PRICING_NOT_INERT",
            "planes.COMMERCE.locationDynamicPricing.rules",
            "inactive dynamic pricing cannot contain pricing rules"
        );
    }

    // --- OPERATIONS: canonical invariants may not be configured away -------
    //
    // CORR-02. Every one of these is load-bearing, and each must be present and
    // true. The previous validator enforced only a subset, so DTS was able to
    // set ownerConfirmedAvailabilityRequired=false and have it accepted;
    // strictEligibilityRequired had no rule at all.
    const operations = planes.OPERATIONS;
    const REQUIRED_AUTHORITY_INVARIANTS: Array<{ path: string; value: unknown; why: string }> = [
        {
            path: "planes.OPERATIONS.provider.approvalRequired",
            value: operations.provider?.approvalRequired,
            why: "submitted provider profile is never approved supply"
        },
        {
            path: "planes.OPERATIONS.provider.ownerConfirmedAvailabilityRequired",
            value: operations.provider?.ownerConfirmedAvailabilityRequired,
            why: "submitted availability is never owner-confirmed availability"
        },
        {
            path: "planes.OPERATIONS.provider.strictEligibilityRequired",
            value: operations.provider?.strictEligibilityRequired,
            why: "eligibility is strict; it may not be relaxed by configuration"
        },
        {
            path: "planes.OPERATIONS.lifecycle.providerAcceptanceDoesNotAssign",
            value: operations.lifecycle?.providerAcceptanceDoesNotAssign,
            why: "provider acceptance is never owner assignment"
        },
        {
            path: "planes.OPERATIONS.lifecycle.ownerAssignmentRequired",
            value: operations.lifecycle?.ownerAssignmentRequired,
            why: "owner assignment is a required distinct gate"
        },
        {
            path: "planes.OPERATIONS.lifecycle.customerConfirmationSeparate",
            value: operations.lifecycle?.customerConfirmationSeparate,
            why: "owner assignment is never customer confirmation"
        },
        {
            path: "planes.OPERATIONS.scheduling.nonOverlapRequired",
            value: operations.scheduling?.nonOverlapRequired,
            why: "exclusive-capacity non-overlap is not optional"
        },
        {
            path: "planes.OPERATIONS.recovery.amendmentRequiredForCustomerCommitmentChange",
            value: operations.recovery?.amendmentRequiredForCustomerCommitmentChange,
            why: "a customer-facing commitment change requires a canonical Amendment"
        }
    ];
    for (const invariant of REQUIRED_AUTHORITY_INVARIANTS) {
        if (invariant.value !== true) {
            fail(
                "CANONICAL_AUTHORITY_CONTRADICTION",
                invariant.path,
                `must be true — ${invariant.why}`
            );
        }
    }

    // --- EXPERIENCE: channel carries intent, never state --------------------
    const experience = planes.EXPERIENCE;
    if (experience.channels.whatsapp.authoritativeStateOwner) {
        fail(
            "CANONICAL_AUTHORITY_CONTRADICTION",
            "planes.EXPERIENCE.channels.whatsapp.authoritativeStateOwner",
            "WhatsApp carries intent; SCP owns state"
        );
    }
    if (experience.channels.whatsapp.enabled && !experience.channels.whatsapp.adapterRequired) {
        fail(
            "CHANNEL_POLICY_INCOHERENT",
            "planes.EXPERIENCE.channels.whatsapp.adapterRequired",
            "an enabled channel must go through a bounded adapter"
        );
    }
    if (experience.providerExperience.canonicalAggregateTerm !== "PROVIDER") {
        fail(
            "CANONICAL_AUTHORITY_CONTRADICTION",
            "planes.EXPERIENCE.providerExperience.canonicalAggregateTerm",
            "PROVIDER is the canonical supply aggregate"
        );
    }
    if (
        experience.providerExperience.ratingCommission.state === "UNRESOLVED" &&
        experience.providerExperience.ratingCommission.active
    ) {
        fail(
            "INACTIVE_CAPABILITY_NOT_INERT",
            "planes.EXPERIENCE.providerExperience.ratingCommission",
            "an unresolved capability cannot be active"
        );
    }

    // --- MEASUREMENT --------------------------------------------------------
    const measurement = bundle.measurement;
    if (!measurement) {
        fail("MEASUREMENT_REQUIRED", "measurement", "measurement configuration is required");
    } else {
        if (measurement.canonicalSource !== "SCP_EVENTS_AND_RECORDS") {
            fail(
                "MEASUREMENT_SOURCE_INVALID",
                "measurement.canonicalSource",
                "SCP events and records are the canonical source"
            );
        }
        if (!measurement.lineage?.tenantRequired || !measurement.lineage?.marketRequired) {
            fail(
                "MEASUREMENT_LINEAGE_DISABLED",
                "measurement.lineage",
                "tenant and market lineage cannot be disabled"
            );
        }
        if (measurement.reporting?.mayOwnBusinessTruth) {
            fail(
                "PROJECTION_AUTHORITY_VIOLATION",
                "measurement.reporting.mayOwnBusinessTruth",
                "a projection may never own business truth"
            );
        }
        const clad = measurement.cladConstraints;
        if (
            clad?.cladSpecificInferredStatesInScpCore ||
            clad?.psychologicalProfileFields ||
            clad?.transactionalAuthority
        ) {
            fail(
                "CLAD_CONSTRAINT_VIOLATION",
                "measurement.cladConstraints",
                "CLAD may interpret SCP evidence but never write into or bind Core"
            );
        }
    }

    // --- forbidden content anywhere in the bundle ---------------------------
    scanForbidden(bundle, "", fail);

    return { valid: findings.length === 0, findings };
}

function toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":");
    return Number(h) * 60 + Number(m);
}

function validateCodedItems(
    items: Array<{ code: string; name: string; price: { amount: number; currency: string } }>,
    path: string,
    kind: "SERVICE" | "EXTRA",
    marketPriceCurrency: string | undefined,
    fail: (code: string, path: string, message: string) => void
): void {
    if (!Array.isArray(items) || items.length === 0) {
        fail(`${kind}_REQUIRED`, path, `at least one ${kind.toLowerCase()} is required`);
        return;
    }
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
        const at = `${path}[${index}]`;
        if (!CODE.test(item.code ?? "")) {
            fail(`${kind}_CODE_INVALID`, `${at}.code`, "codes must be UPPER_SNAKE and stable");
        }
        if (seen.has(item.code)) {
            fail(`DUPLICATE_${kind}_CODE`, `${at}.code`, `duplicate code ${item.code}`);
        }
        seen.add(item.code);
        if (!item.name || typeof item.name !== "string") {
            fail(`${kind}_NAME_REQUIRED`, `${at}.name`, "a display name is required");
        }
        if (!Number.isFinite(item.price?.amount) || item.price.amount < 0) {
            fail("PRICE_INVALID", `${at}.price.amount`, "price must be non-negative");
        }
        if (!ISO_CURRENCY.test(item.price?.currency ?? "")) {
            fail("PRICE_INVALID", `${at}.price.currency`, "price must be currency-bound (ISO 4217)");
        } else if (marketPriceCurrency && item.price.currency !== marketPriceCurrency) {
            fail(
                "PRICE_CURRENCY_MISMATCH",
                `${at}.price.currency`,
                `must match the market price currency ${marketPriceCurrency}`
            );
        }
    }
}

/**
 * The two blocks where CLAD may legitimately be named: they exist to DECLARE
 * the boundary and switch CLAD off. Their contents are validated explicitly by
 * the measurement rules above, so the blunt token scan skips them rather than
 * flagging a constraint for containing the name of the thing it constrains.
 */
const DECLARED_BOUNDARY_PATHS: ReadonlySet<string> = new Set([
    "measurement.cladConstraints",
    "measurement.projectionBoundaries"
]);

/** Walks every key and string value looking for prohibited content. */
function scanForbidden(
    node: unknown,
    path: string,
    fail: (code: string, path: string, message: string) => void
): void {
    if (node === null || node === undefined) {
        return;
    }
    if (DECLARED_BOUNDARY_PATHS.has(path)) {
        return;
    }
    if (typeof node === "string") {
        const lowered = node.toLowerCase();
        for (const token of FORBIDDEN_AUTHORITY_TOKENS) {
            // Only a claim of canonical authority is forbidden, not the word.
            if (lowered.includes(token) && /authorit|canonical|source of truth/.test(lowered)) {
                fail(
                    "LEGACY_AUTHORITY_REFERENCE",
                    path,
                    "configuration may not name legacy appointments as canonical authority"
                );
            }
        }
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((child, i) => scanForbidden(child, `${path}[${i}]`, fail));
        return;
    }
    if (typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            const childPath = `${path ? `${path}.` : ""}${key}`;
            if (DECLARED_BOUNDARY_PATHS.has(childPath)) {
                continue;
            }
            const lowered = key.toLowerCase();
            for (const token of FORBIDDEN_FIELD_TOKENS) {
                if (lowered.includes(token)) {
                    fail(
                        "CLAD_CONSTRAINT_VIOLATION",
                        childPath,
                        `field ${key} would introduce inferred/profiling state into Core configuration`
                    );
                }
            }
            scanForbidden(value, childPath, fail);
        }
    }
}
