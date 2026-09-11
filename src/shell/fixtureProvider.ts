// C3 — the FIXTURE projection provider.
//
// Fixtures exist so an experience can be built and judged before the capability
// behind it is authoritative. They are legitimate only while they are impossible
// to mistake for truth, so every fixture here is:
//
//   deterministic   — no clock, no randomness in the VALUES. The only non-constant
//                     field is `generatedAt`, which is metadata about the read and
//                     not part of the projection's content.
//   tenant-scoped   — a fixture set is looked up by tenant and a miss is a refusal,
//                     never a fallback to another tenant's data.
//   provenance-marked — sourceType FIXTURE and a fixtureVersion, always.
//   inert           — this module imports no pool, no client and no command. It
//                     cannot write to canonical truth because it has no way to.
//
// It also cannot impersonate LIVE authority: `sourceType` is a literal, and the
// envelopes below never claim LIVE maturity.
//
// Athena exercises eligibility deliberately — that is the one semantic SCP cannot
// yet produce, and showing it as FIXTURE is how the Lab demonstrates the shape of
// the future primitive without pretending it exists. EXE-01A §3.4 authorizes
// exactly this, on condition the provenance says FIXTURE. It does.

import {
    type Committable,
    type DemandPayload,
    type OperatePayload,
    type ProjectionEnvelope,
    type ProjectionProvider,
    type ProjectionRequest,
    type ShellAvailabilityWindow,
    type ShellOffer,
    type ShellService
} from "./contract";
import { formatMoney } from "./money";
import { resolveLocale } from "../localization/translate";

/**
 * UAT-R1 bumped this from v1: the commercial content changed from IDR to EUR and
 * gained French copy. A fixture whose content changes silently under a stable
 * version string is a fixture nobody can reason about.
 */
export const ATHENA_FIXTURE_VERSION = "athena-uat.fixtures.v2";

/** Athena presents EUR. It is a `bali` tenant; market identity does not pick currency. */
export const ATHENA_CURRENCY = "EUR";

/** Primary then secondary. Order matters: index 0 is the default. */
export const ATHENA_LOCALES: readonly string[] = ["en", "fr"];
export const FIXTURE_PROVIDER_NAME = "athena-fixture";

/** Fixed instants so availability labels are stable across runs. */
const FIXTURE_DAY = "2026-09-18";

type Localized = Readonly<Record<string, string>>;

function pick(entry: Localized, locale: string): string {
    return entry[locale] ?? entry["en"] ?? "";
}

interface ServiceSeed {
    code: string;
    name: Localized;
    description: Localized;
    minorUnits: number;
    durationMinutes: number;
    featured?: boolean;
}

/**
 * Amounts are in EUR minor units and are the SAME number in every locale. Only the
 * words beside them change.
 */
const ATHENA_SERVICE_SEEDS: readonly ServiceSeed[] = [
    {
        code: "ATH-SIGNATURE-RITUAL",
        name: { en: "Signature Athena Ritual", fr: "Rituel Signature Athena" },
        description: {
            en: "Ninety minutes. Warm oil, slow pressure, and a therapist who has read your notes before you arrive.",
            fr: "Quatre-vingt-dix minutes. Huile tiède, pression lente, et une praticienne qui a lu vos notes avant votre arrivée."
        },
        minorUnits: 18_500,
        durationMinutes: 90,
        featured: true
    },
    {
        code: "ATH-RESTORATIVE-DEEP",
        name: { en: "Restorative Deep Tissue", fr: "Massage Profond Réparateur" },
        description: {
            en: "Sixty focused minutes for shoulders, neck and the places a laptop leaves behind.",
            fr: "Soixante minutes ciblées pour les épaules, la nuque et tout ce que laisse un ordinateur portable."
        },
        minorUnits: 12_500,
        durationMinutes: 60
    },
    {
        code: "ATH-COUPLES-PAVILION",
        name: { en: "Pavilion for Two", fr: "Pavillon pour Deux" },
        description: {
            en: "Two therapists, one open-air pavilion, and no clock in the room.",
            fr: "Deux praticiennes, un pavillon à ciel ouvert, et aucune horloge dans la pièce."
        },
        minorUnits: 34_000,
        durationMinutes: 120
    }
];

interface OfferSeed {
    code: string;
    label: Localized;
    description: Localized;
    minorUnits: number;
    kind: "OFFER" | "RECOMMENDATION";
}

const ATHENA_OFFER_SEEDS: readonly OfferSeed[] = [
    {
        code: "ATH-OFFER-RESIDENT",
        label: { en: "Resident rate", fr: "Tarif résident" },
        description: {
            en: "Verified residency, applied at review rather than promised upfront.",
            fr: "Résidence vérifiée, appliquée au récapitulatif plutôt que promise d'avance."
        },
        minorUnits: 14_800,
        kind: "OFFER"
    },
    {
        code: "ATH-REC-PAIRING",
        label: { en: "Often paired with a scalp ritual", fr: "Souvent associé à un rituel du cuir chevelu" },
        description: {
            en: "A suggestion from prior guests, not a price we have authorised for you.",
            fr: "Une suggestion d'anciens clients, et non un prix que nous vous avons accordé."
        },
        minorUnits: 4_500,
        // RECOMMENDATION ≠ OFFER, in both languages.
        kind: "RECOMMENDATION"
    }
];

interface WindowSeed {
    id: string;
    label: Localized;
    startsAt: string;
    endsAt: string;
    eligible: boolean;
}

/**
 * Three eligible windows and one that is AVAILABLE but NOT ELIGIBLE — UAT-R1 §7
 * requires at least two eligible options plus one visible ineligible one.
 */
const ATHENA_WINDOW_SEEDS: readonly WindowSeed[] = [
    { id: "w-0900", label: { en: "Morning · 09:00", fr: "Matin · 09h00" }, startsAt: `${FIXTURE_DAY}T09:00:00+08:00`, endsAt: `${FIXTURE_DAY}T10:30:00+08:00`, eligible: true },
    { id: "w-1230", label: { en: "Midday · 12:30", fr: "Midi · 12h30" }, startsAt: `${FIXTURE_DAY}T12:30:00+08:00`, endsAt: `${FIXTURE_DAY}T14:00:00+08:00`, eligible: true },
    { id: "w-1600", label: { en: "Late afternoon · 16:00", fr: "Fin d'après-midi · 16h00" }, startsAt: `${FIXTURE_DAY}T16:00:00+08:00`, endsAt: `${FIXTURE_DAY}T17:30:00+08:00`, eligible: false },
    { id: "w-1900", label: { en: "Evening · 19:00", fr: "Soirée · 19h00" }, startsAt: `${FIXTURE_DAY}T19:00:00+08:00`, endsAt: `${FIXTURE_DAY}T20:30:00+08:00`, eligible: true }
];

/** Stable ids so a selection survives a language switch. */
export function athenaWindowIds(): readonly string[] {
    return ATHENA_WINDOW_SEEDS.map((w) => w.id);
}

function servicesFor(locale: string): readonly ShellService[] {
    return ATHENA_SERVICE_SEEDS.map((seed) => ({
        code: seed.code,
        name: pick(seed.name, locale),
        description: pick(seed.description, locale),
        price: {
            minorUnits: seed.minorUnits,
            currency: ATHENA_CURRENCY,
            display: formatMoney(seed.minorUnits, ATHENA_CURRENCY, locale)
        },
        durationMinutes: seed.durationMinutes,
        ...(seed.featured === true ? { featured: true } : {})
    }));
}

function offersFor(locale: string): readonly ShellOffer[] {
    return ATHENA_OFFER_SEEDS.map((seed) => ({
        code: seed.code,
        label: pick(seed.label, locale),
        description: pick(seed.description, locale),
        price: {
            minorUnits: seed.minorUnits,
            currency: ATHENA_CURRENCY,
            display: formatMoney(seed.minorUnits, ATHENA_CURRENCY, locale)
        },
        kind: seed.kind
    }));
}

function availabilityFor(locale: string): readonly ShellAvailabilityWindow[] {
    return ATHENA_WINDOW_SEEDS.map((seed) => ({
        label: pick(seed.label, locale),
        startsAt: seed.startsAt,
        endsAt: seed.endsAt,
        eligible: seed.eligible
    }));
}

const ATHENA_COMMITTABLE: Committable = {
    posture: "CAN_COMMIT",
    // Technical English on purpose: this string is inspector copy, not customer
    // copy. What the visitor reads comes from the localization dictionary, so a
    // translation gap can never change a commercial posture.
    reason:
        "Service, authorised price, eligibility and capacity are all resolved in this fixture set. " +
        "This posture is FIXTURE-sourced and asserts nothing about live SCP capability.",
    resolved: { service: true, price: true, eligibility: true, capacity: true }
};

const ATHENA_TAGLINE: Localized = {
    en: "Unhurried treatment, arranged around you.",
    fr: "Un soin sans hâte, organisé autour de vous."
};

const ATHENA_DESCRIPTOR: Localized = {
    en: "Ubud · by appointment",
    fr: "Ubud · sur rendez-vous"
};

function brandFor(locale: string): DemandPayload["brand"] {
    return {
        name: "athena",
        publicName: "Athena",
        tagline: pick(ATHENA_TAGLINE, locale),
        marketDescriptor: pick(ATHENA_DESCRIPTOR, locale),
        colors: {
            ink: "#1A1714",
            parchment: "#F7F3EC",
            bronze: "#8C6A43",
            sage: "#5A6B5D",
            line: "#DED5C7"
        },
        headingFont: "'Cormorant Garamond', 'Iowan Old Style', Georgia, serif",
        bodyFont: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    };
}

/**
 * MARKET ≠ CURRENCY. Athena's market identity is `bali` and its commercial
 * currency is EUR — this field previously said IDR, which was the market leaking
 * into the commercial plane, and UAT-R1 §4 exists to forbid exactly that.
 */
const ATHENA_MARKET: DemandPayload["market"] = {
    marketId: "bali",
    timezone: "Asia/Makassar",
    currency: ATHENA_CURRENCY,
    regions: ["Ubud Centre", "Sayan", "Penestanan", "Tegallalang"],
    operatingHours: { open: "09:00", close: "21:00" }
};

/** Operator-facing fixture state. Technical vocabulary; this feeds the inspector. */
const ATHENA_OPERATE: OperatePayload = {
    items: [
        {
            canonicalRef: { kind: "SERVICE_REQUEST", id: "ath-fixture-req-0001" },
            stage: "AWAITING_CUSTOMER_CONFIRMATION",
            attention: "JUDGMENT_REQUIRED",
            qualification: "QUALIFIED",
            capacity: "PROVIDER_ACCEPTED",
            assignment: "ASSIGNED",
            // ASSIGNED ≠ CONFIRMED, held apart even in a fixture.
            confirmation: "NOT_CONFIRMED",
            fulfillment: "NOT_STARTED",
            exception: null,
            occurredAt: `${FIXTURE_DAY}T08:12:00+08:00`
        },
        {
            canonicalRef: { kind: "SERVICE_REQUEST", id: "ath-fixture-req-0002" },
            stage: "CLARIFICATION_REQUIRED",
            attention: "JUDGMENT_REQUIRED",
            qualification: "CLARIFICATION_REQUIRED",
            capacity: null,
            assignment: "NOT_ASSIGNED",
            confirmation: "NOT_CONFIRMED",
            fulfillment: "NOT_STARTED",
            exception: "Guest requested a therapist who is not on the Sayan roster.",
            occurredAt: `${FIXTURE_DAY}T07:41:00+08:00`
        },
        {
            canonicalRef: { kind: "SERVICE_REQUEST", id: "ath-fixture-req-0003" },
            stage: "CONFIRMED_AWAITING_FULFILLMENT",
            attention: "NORMAL",
            qualification: "QUALIFIED",
            capacity: "PROVIDER_ACCEPTED",
            assignment: "ASSIGNED",
            confirmation: "CONFIRMED",
            // ACCEPTED ≠ FULFILLED, likewise.
            fulfillment: "NOT_STARTED",
            exception: null,
            occurredAt: `${FIXTURE_DAY}T06:55:00+08:00`
        }
    ]
};

interface FixtureSet {
    locales: readonly string[];
    currency: string;
    demand(locale: string): DemandPayload;
    operate: OperatePayload;
}

/**
 * Registry keyed by tenant. Small on purpose — a generic fixture platform is
 * explicitly out of scope, and a lookup miss must refuse rather than degrade.
 */
const FIXTURES: Readonly<Record<string, FixtureSet>> = {
    "athena-uat": {
        locales: ATHENA_LOCALES,
        currency: ATHENA_CURRENCY,
        demand: (locale) => ({
            brand: brandFor(locale),
            market: ATHENA_MARKET,
            services: servicesFor(locale),
            offers: offersFor(locale),
            availability: availabilityFor(locale),
            committable: ATHENA_COMMITTABLE
        }),
        operate: ATHENA_OPERATE
    }
};

export class FixtureNotFoundError extends Error {
    public constructor(tenant: string) {
        super(
            `No fixture set is registered for tenant "${tenant}". A fixture provider refuses rather ` +
                `than serving another tenant's data.`
        );
        this.name = "FixtureNotFoundError";
    }
}

/** Names of tenants with a registered fixture set. Used by the inspector. */
export function fixtureTenants(): readonly string[] {
    return Object.keys(FIXTURES);
}

/** What locales a fixture tenant actually supports. */
export function fixtureLocales(tenant: string): readonly string[] {
    return Object.prototype.hasOwnProperty.call(FIXTURES, tenant)
        ? FIXTURES[tenant]?.locales ?? []
        : [];
}

export function createFixtureProjectionProvider(): ProjectionProvider {
    const resolve = (tenant: string): FixtureSet => {
        const set = Object.prototype.hasOwnProperty.call(FIXTURES, tenant)
            ? FIXTURES[tenant]
            : undefined;
        if (set === undefined) {
            throw new FixtureNotFoundError(tenant);
        }
        return set;
    };

    return {
        name: FIXTURE_PROVIDER_NAME,
        sourceType: "FIXTURE",

        async demand(request: ProjectionRequest): Promise<ProjectionEnvelope<DemandPayload>> {
            const set = resolve(request.tenant);
            const locale = resolveLocale(request.locale, set.locales);
            const payload = set.demand(locale);

            return {
                tenant: request.tenant,
                actor: request.actor,
                perspective: "DEMAND",
                authority: {
                    canRequest: true,
                    canCommit: payload.committable.posture === "CAN_COMMIT",
                    requiresAuthority: false,
                    grants: ["DEMAND_SUBMIT", "DEMAND_COMMIT_FIXTURE"]
                },
                canonicalRef: { kind: "FIXTURE_SET", id: ATHENA_FIXTURE_VERSION },
                state: { code: "DEMAND_OPEN", label: "Accepting requests", terminal: false },
                actions: [
                    { id: "submit-demand", label: "Request this time", kind: "REQUEST", enabled: true },
                    {
                        id: "commit",
                        label: "Reserve",
                        kind: "COMMIT",
                        enabled: payload.committable.posture === "CAN_COMMIT",
                        ...(payload.committable.posture === "CAN_COMMIT"
                            ? {}
                            : { reason: payload.committable.reason })
                    }
                ],
                provenance: {
                    sourceType: "FIXTURE",
                    provider: FIXTURE_PROVIDER_NAME,
                    fixtureVersion: ATHENA_FIXTURE_VERSION,
                    generatedAt: new Date().toISOString(),
                    correlationId: request.correlationId ?? null
                },
                payload
            };
        },

        async operate(request: ProjectionRequest): Promise<ProjectionEnvelope<OperatePayload>> {
            const set = resolve(request.tenant);
            const items = set.operate.items;
            return {
                tenant: request.tenant,
                actor: request.actor,
                perspective: "OPERATE",
                authority: {
                    canRequest: false,
                    canCommit: false,
                    requiresAuthority: true,
                    grants: ["OPERATE_VIEW"]
                },
                canonicalRef: { kind: "FIXTURE_SET", id: ATHENA_FIXTURE_VERSION },
                state: {
                    code: items.length === 0 ? "QUEUE_EMPTY" : "QUEUE_ACTIVE",
                    label: items.length === 0 ? "No operator work" : `${items.length} in queue`,
                    terminal: false
                },
                actions: [],
                provenance: {
                    sourceType: "FIXTURE",
                    provider: FIXTURE_PROVIDER_NAME,
                    fixtureVersion: ATHENA_FIXTURE_VERSION,
                    generatedAt: new Date().toISOString(),
                    correlationId: request.correlationId ?? null
                },
                payload: set.operate
            };
        }
    };
}
