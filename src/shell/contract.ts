// C1 — SCP-SHELL-04A-EXE-01A — the Shell-facing projection contract.
//
// This is the ONLY thing the Experience Lab Shell is allowed to know about. It is
// deliberately not a domain model: it carries no catalogue rule, no pricing rule,
// no availability rule, no qualification rule and no commitment rule. Every value
// in an envelope was decided upstream by SCP or by an explicitly-marked fixture,
// and the Shell's whole job is to render what it is given.
//
// The contract exists because two tenants must be renderable from two completely
// different truth sources — Freshline from live governed SCP behaviour, Athena
// from deterministic fixtures — without the Shell being able to tell the
// difference *structurally*, and without either tenant getting its own fork of
// the contract. What must differ is `provenance`, loudly and always.
//
// Why the envelope carries authority separately from actions: VISIBILITY IS NOT
// AUTHORITY and SEEING IS NOT DOING. A Shell that derived "can commit" from the
// presence of a commit button would be manufacturing authority out of layout.

/** A governed tenant lineage identifier, e.g. `freshline-uat`. */
export type TenantId = string;

/**
 * Which face of the business this projection is for. ROLE ≠ PERSPECTIVE: an owner
 * may look at DEMAND, and doing so does not make them a customer.
 */
export type Perspective = "DEMAND" | "SUPPLY" | "OPERATE";

export interface Actor {
    /** Null for an anonymous demand-side visitor. */
    actorId: string | null;
    role: string;
}

/**
 * What the actor may actually do, as decided upstream. The Shell reads these; it
 * never computes them, and it must not infer one from another.
 */
export interface Authority {
    canRequest: boolean;
    canCommit: boolean;
    requiresAuthority: boolean;
    /** Free-form grant names, for the inspector rather than for logic. */
    grants: readonly string[];
}

/** A pointer back to canonical truth, so any projection can be traced to source. */
export interface CanonicalRef {
    kind: string;
    id: string | null;
}

/**
 * An experience state. `code` is the canonical state name where one exists —
 * never a prettier synonym, because the label is where semantic inflation starts.
 */
export interface ExperienceState {
    code: string;
    label: string;
    terminal: boolean;
}

export type ExperienceActionKind = "REQUEST" | "COMMIT" | "NAVIGATE" | "INSPECT" | "NONE";

export interface ExperienceAction {
    id: string;
    label: string;
    kind: ExperienceActionKind;
    enabled: boolean;
    /** Why an action is unavailable. Rendered honestly rather than hidden. */
    reason?: string;
}

export type SourceType = "LIVE" | "FIXTURE";

/**
 * FIXTURE ≠ LIVE, and this is the type that guarantees the difference survives
 * all the way to the screen. A projection that cannot say where it came from is
 * not usable in the Experience Lab.
 */
export interface ProjectionProvenance {
    sourceType: SourceType;
    /** Provider name, e.g. `scp-live` or `athena-fixture`. */
    provider: string;
    /** Set for LIVE: the governed configuration version behind the projection. */
    sourceVersion?: string;
    /** Set for FIXTURE: the fixture set version. Never both. */
    fixtureVersion?: string;
    generatedAt: string;
    correlationId?: string | null;
    /**
     * Optional lifecycle position from SHELL-04A §6. Present only where it means
     * something; no lifecycle machinery is built for it in this gate.
     */
    maturity?: "CONTRACT_PROVEN" | "LIVE_SHADOW" | "LIVE_AUTHORITATIVE";
}

export interface ProjectionEnvelope<TPayload> {
    tenant: TenantId;
    actor: Actor;
    perspective: Perspective;
    authority: Authority;
    canonicalRef: CanonicalRef;
    state: ExperienceState;
    actions: readonly ExperienceAction[];
    provenance: ProjectionProvenance;
    payload: TPayload;
}

// ---------------------------------------------------------------------------
// Payloads
//
// Kept as narrow as the two journeys actually need. A field absent from a
// payload means the source does not carry that semantic — which is a truthful
// statement and must not be repaired by the Shell inventing a value.
// ---------------------------------------------------------------------------

export interface Money {
    minorUnits: number;
    currency: string;
    /** Preformatted for display, because formatting is market configuration. */
    display: string;
}

export interface ShellService {
    code: string;
    name: string;
    description?: string;
    price: Money;
    durationMinutes: number;
    /** Merchandising emphasis, expression only — never an eligibility signal. */
    featured?: boolean;
}

export interface ShellOffer {
    code: string;
    label: string;
    description?: string;
    price: Money;
    /** RECOMMENDATION ≠ OFFER: an offer the source only suggests says so here. */
    kind: "OFFER" | "RECOMMENDATION";
}

export interface ShellAvailabilityWindow {
    label: string;
    startsAt: string;
    endsAt: string;
    /**
     * AVAILABLE ≠ ELIGIBLE. A window may be available and still not eligible, and
     * `eligible: undefined` means the source does not model eligibility at all —
     * which is the honest answer for LIVE SCP today.
     */
    eligible?: boolean;
}

/**
 * How far the source will actually let a customer go. Deliberately not booleans:
 * "can request" and "can commit" are different commercial statements, and
 * ELIGIBILITY ≠ COMMITMENT.
 */
export type CommitmentPosture =
    | "CAN_REQUEST"
    | "CAN_COMMIT"
    | "REQUIRES_AUTHORITY"
    | "NOT_ELIGIBLE"
    | "NO_VALID_CAPACITY"
    | "NOT_DETERMINED";

export interface Committable {
    posture: CommitmentPosture;
    /** Human-readable justification, shown rather than hidden. */
    reason: string;
    /** Which inputs were actually resolved. Absent input is never assumed valid. */
    resolved: {
        service: boolean;
        price: boolean;
        eligibility: boolean;
        capacity: boolean;
    };
}

export interface DemandPayload {
    brand: {
        name: string;
        publicName: string;
        tagline: string;
        marketDescriptor: string;
        colors: Record<string, string>;
        headingFont: string;
        bodyFont: string;
    };
    market: {
        marketId: string;
        timezone: string;
        currency: string;
        regions: readonly string[];
        operatingHours: { open: string; close: string };
    };
    services: readonly ShellService[];
    offers: readonly ShellOffer[];
    availability: readonly ShellAvailabilityWindow[];
    committable: Committable;
}

export type AttentionLevel =
    | "BLOCKED"
    | "AUTHORITY_REQUIRED"
    | "JUDGMENT_REQUIRED"
    | "EXCEPTION"
    | "MATERIAL_CHANGE"
    | "NORMAL";

/** Highest attention first. Index order IS the precedence, and it is tested. */
export const ATTENTION_PRECEDENCE: readonly AttentionLevel[] = [
    "BLOCKED",
    "AUTHORITY_REQUIRED",
    "JUDGMENT_REQUIRED",
    "EXCEPTION",
    "MATERIAL_CHANGE",
    "NORMAL"
];

export function attentionRank(level: AttentionLevel): number {
    const index = ATTENTION_PRECEDENCE.indexOf(level);
    return index === -1 ? ATTENTION_PRECEDENCE.length : index;
}

/**
 * One unit of operator work.
 *
 * Every status is a nullable string rather than a boolean: "not confirmed" and
 * "we do not know whether it is confirmed" are different operational facts, and
 * collapsing them into `false` is how an operator surface starts lying.
 */
export interface OperateItem {
    canonicalRef: CanonicalRef;
    /** The canonical stage code, verbatim from the source. */
    stage: string;
    attention: AttentionLevel;
    qualification: string | null;
    capacity: string | null;
    assignment: string | null;
    confirmation: string | null;
    fulfillment: string | null;
    exception: string | null;
    occurredAt?: string;
}

export interface OperatePayload {
    items: readonly OperateItem[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProjectionRequest {
    tenant: TenantId;
    actor: Actor;
    /** Correlation id from the transport, so provenance can be traced end to end. */
    correlationId?: string | null;
    /**
     * UAT-R1: the language the projection's own copy should be returned in.
     *
     * Localization belongs at the source, not in the renderer: a real tenant's
     * catalogue is localized in its configuration, so a fixture standing in for one
     * must be too. Only words change with this field — `minorUnits`, eligibility,
     * availability and posture are identical across every locale, which is what the
     * invariance tests assert.
     */
    locale?: string;
}

/**
 * One abstraction, two implementations. The Shell selects a provider per tenant
 * and then cannot tell — from the shape alone — whether it got authoritative or
 * simulated data. It can always tell from `provenance`, which is the point.
 */
export interface ProjectionProvider {
    readonly name: string;
    readonly sourceType: SourceType;
    demand(request: ProjectionRequest): Promise<ProjectionEnvelope<DemandPayload>>;
    operate(request: ProjectionRequest): Promise<ProjectionEnvelope<OperatePayload>>;
}

/** Guard used by the inspector and by tests, so LIVE is never assumed. */
export function isLive(envelope: ProjectionEnvelope<unknown>): boolean {
    return envelope.provenance.sourceType === "LIVE";
}
