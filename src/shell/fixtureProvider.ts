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

export const ATHENA_FIXTURE_VERSION = "athena-uat.fixtures.v1";
export const FIXTURE_PROVIDER_NAME = "athena-fixture";

/** Fixed instants so availability labels are stable across runs. */
const FIXTURE_DAY = "2026-09-18";

const ATHENA_SERVICES: readonly ShellService[] = [
    {
        code: "ATH-SIGNATURE-RITUAL",
        name: "Signature Athena Ritual",
        description:
            "Ninety minutes. Warm oil, slow pressure, and a therapist who has read your notes before you arrive.",
        price: { minorUnits: 185_000_000, currency: "IDR", display: "Rp 1.850.000" },
        durationMinutes: 90,
        featured: true
    },
    {
        code: "ATH-RESTORATIVE-DEEP",
        name: "Restorative Deep Tissue",
        description: "Sixty focused minutes for shoulders, neck and the places a laptop leaves behind.",
        price: { minorUnits: 125_000_000, currency: "IDR", display: "Rp 1.250.000" },
        durationMinutes: 60
    },
    {
        code: "ATH-COUPLES-PAVILION",
        name: "Pavilion for Two",
        description: "Two therapists, one open-air pavilion, and no clock in the room.",
        price: { minorUnits: 340_000_000, currency: "IDR", display: "Rp 3.400.000" },
        durationMinutes: 120
    }
];

const ATHENA_OFFERS: readonly ShellOffer[] = [
    {
        code: "ATH-OFFER-RESIDENT",
        label: "Resident rate",
        description: "Verified residency, applied at review rather than promised upfront.",
        price: { minorUnits: 148_000_000, currency: "IDR", display: "Rp 1.480.000" },
        kind: "OFFER"
    },
    {
        code: "ATH-REC-PAIRING",
        label: "Often paired with a scalp ritual",
        description: "A suggestion from prior guests, not a price we have authorised for you.",
        price: { minorUnits: 45_000_000, currency: "IDR", display: "Rp 450.000" },
        // RECOMMENDATION ≠ OFFER. The Shell must render this differently, and the
        // kind field is what forces that rather than trusting copy.
        kind: "RECOMMENDATION"
    }
];

const ATHENA_AVAILABILITY: readonly ShellAvailabilityWindow[] = [
    { label: "Morning · 09:00", startsAt: `${FIXTURE_DAY}T09:00:00+08:00`, endsAt: `${FIXTURE_DAY}T10:30:00+08:00`, eligible: true },
    { label: "Midday · 12:30", startsAt: `${FIXTURE_DAY}T12:30:00+08:00`, endsAt: `${FIXTURE_DAY}T14:00:00+08:00`, eligible: true },
    // Available and NOT eligible — the distinction this fixture exists to prove.
    { label: "Late afternoon · 16:00", startsAt: `${FIXTURE_DAY}T16:00:00+08:00`, endsAt: `${FIXTURE_DAY}T17:30:00+08:00`, eligible: false },
    { label: "Evening · 19:00", startsAt: `${FIXTURE_DAY}T19:00:00+08:00`, endsAt: `${FIXTURE_DAY}T20:30:00+08:00`, eligible: true }
];

const ATHENA_COMMITTABLE: Committable = {
    posture: "CAN_COMMIT",
    reason:
        "Service, authorised price, eligibility and capacity are all resolved in this fixture set. " +
        "This posture is FIXTURE-sourced and asserts nothing about live SCP capability.",
    resolved: { service: true, price: true, eligibility: true, capacity: true }
};

const ATHENA_BRAND: DemandPayload["brand"] = {
    name: "athena",
    publicName: "Athena",
    tagline: "Unhurried treatment, arranged around you.",
    marketDescriptor: "Ubud · by appointment",
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

const ATHENA_MARKET: DemandPayload["market"] = {
    marketId: "bali",
    timezone: "Asia/Makassar",
    currency: "IDR",
    regions: ["Ubud Centre", "Sayan", "Penestanan", "Tegallalang"],
    operatingHours: { open: "09:00", close: "21:00" }
};

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
    brand: DemandPayload["brand"];
    market: DemandPayload["market"];
    services: readonly ShellService[];
    offers: readonly ShellOffer[];
    availability: readonly ShellAvailabilityWindow[];
    committable: Committable;
    operate: OperatePayload;
}

/**
 * Registry keyed by tenant. Small on purpose — a generic fixture platform is
 * explicitly out of scope, and a lookup miss must refuse rather than degrade.
 */
const FIXTURES: Readonly<Record<string, FixtureSet>> = {
    "athena-uat": {
        brand: ATHENA_BRAND,
        market: ATHENA_MARKET,
        services: ATHENA_SERVICES,
        offers: ATHENA_OFFERS,
        availability: ATHENA_AVAILABILITY,
        committable: ATHENA_COMMITTABLE,
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
            return {
                tenant: request.tenant,
                actor: request.actor,
                perspective: "DEMAND",
                authority: {
                    canRequest: true,
                    canCommit: set.committable.posture === "CAN_COMMIT",
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
                        enabled: set.committable.posture === "CAN_COMMIT",
                        ...(set.committable.posture === "CAN_COMMIT"
                            ? {}
                            : { reason: set.committable.reason })
                    }
                ],
                provenance: {
                    sourceType: "FIXTURE",
                    provider: FIXTURE_PROVIDER_NAME,
                    fixtureVersion: ATHENA_FIXTURE_VERSION,
                    generatedAt: new Date().toISOString(),
                    correlationId: request.correlationId ?? null
                },
                payload: {
                    brand: set.brand,
                    market: set.market,
                    services: set.services,
                    offers: set.offers,
                    availability: set.availability,
                    committable: set.committable
                }
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
