// SCP-SHELL-04A-UAT-R1 — bounded Athena UAT interaction state.
//
// LOCK: FIXTURE INTERACTION STATE ≠ CANONICAL SCP STATE.
//
// This module is how that lock is kept structurally rather than by discipline. The
// entire interaction lives in the URL's query string: there is no session store, no
// cookie, no table, no module-level mutable variable, and no second persistent
// commerce system. Deriving state is a pure function of `URLSearchParams` and the
// projection payload, which is why every claim below is unit-testable without a
// browser or a database — and why a fixture interaction *cannot* write to canonical
// truth. It has nothing to write with.
//
// It is also why a language switch cannot change business semantics: switching
// language changes one query parameter, and every other parameter — and therefore
// every selection, eligibility verdict and posture — is carried through untouched.
// UAT-R1-05 is a property of this design, not a behaviour bolted onto it.

import {
    type CommitmentPosture,
    type DemandPayload,
    type ShellAvailabilityWindow,
    type ShellOffer,
    type ShellService
} from "./contract";

/** Query parameter names. Short because they end up in a shared URL. */
export const PARAM = {
    locale: "lang",
    service: "svc",
    offer: "offer",
    window: "slot",
    submitted: "done"
} as const;

export interface AthenaSelection {
    locale: string;
    serviceCode: string | null;
    offerCode: string | null;
    /** Index into the availability list. Stable across locales by construction. */
    windowIndex: number | null;
    submitted: boolean;
}

export interface AthenaJourney {
    selection: AthenaSelection;
    service: ShellService | null;
    offer: ShellOffer | null;
    window: ShellAvailabilityWindow | null;
    /**
     * The amount that would actually apply: the offer's price when an OFFER is
     * applied, otherwise the service's.
     *
     * A RECOMMENDATION never replaces the service price. OFFER ≠ SUGGESTION is not
     * a labelling convention here — a suggestion is structurally incapable of
     * changing what is owed, because this is the only place the payable amount is
     * decided and it ignores them.
     */
    payable: { minorUnits: number; currency: string } | null;
    /** True when an applied OFFER changed the amount. */
    offerApplied: boolean;
    posture: CommitmentPosture;
    /** Dictionary key for why commit is unavailable, or null when it is available. */
    blockedReasonKey: string | null;
    reviewReady: boolean;
    canCommit: boolean;
}

/** Reads the bounded state out of a URL. Unknown values are treated as absent. */
export function parseSelection(
    params: URLSearchParams,
    supportedLocales: readonly string[]
): AthenaSelection {
    const rawLocale = params.get(PARAM.locale);
    const locale =
        rawLocale !== null && supportedLocales.includes(rawLocale.trim().toLowerCase())
            ? rawLocale.trim().toLowerCase()
            : (supportedLocales[0] ?? "en");

    const rawWindow = params.get(PARAM.window);
    const parsedWindow = rawWindow === null ? Number.NaN : Number.parseInt(rawWindow, 10);

    return {
        locale,
        serviceCode: emptyToNull(params.get(PARAM.service)),
        offerCode: emptyToNull(params.get(PARAM.offer)),
        windowIndex: Number.isInteger(parsedWindow) ? parsedWindow : null,
        submitted: params.get(PARAM.submitted) === "1"
    };
}

function emptyToNull(value: string | null): string | null {
    if (value === null) {
        return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

/**
 * Derives the journey from a selection and the projection.
 *
 * The posture is computed from what is actually resolved, in the order the
 * commercial law requires: no service means nothing else matters; an ineligible
 * window is NOT_ELIGIBLE however available it is; and only a complete, eligible
 * selection reaches CAN_COMMIT. ELIGIBILITY ≠ COMMITMENT is enforced by requiring
 * BOTH an eligible window and the payload's own CAN_COMMIT posture.
 */
export function deriveJourney(
    selection: AthenaSelection,
    payload: DemandPayload
): AthenaJourney {
    const service =
        payload.services.find((candidate) => candidate.code === selection.serviceCode) ?? null;

    const offerCandidate =
        payload.offers.find((candidate) => candidate.code === selection.offerCode) ?? null;
    // A suggestion may be "selected" in the UI, but it is never an applied offer.
    const offer = offerCandidate;
    const offerApplied = offerCandidate !== null && offerCandidate.kind === "OFFER";

    const window =
        selection.windowIndex === null
            ? null
            : payload.availability[selection.windowIndex] ?? null;

    const payable =
        service === null
            ? null
            : offerApplied && offerCandidate !== null
              ? { minorUnits: offerCandidate.price.minorUnits, currency: offerCandidate.price.currency }
              : { minorUnits: service.price.minorUnits, currency: service.price.currency };

    let posture: CommitmentPosture;
    let blockedReasonKey: string | null;

    if (service === null) {
        posture = "NOT_DETERMINED";
        blockedReasonKey = "reason_no_service";
    } else if (window === null) {
        // A chosen service with no time is a request the source can accept, but not
        // a commitment — CAN_REQUEST is the honest posture, not a weaker CAN_COMMIT.
        posture = "CAN_REQUEST";
        blockedReasonKey = "reason_no_time";
    } else if (window.eligible === false) {
        posture = "NOT_ELIGIBLE";
        blockedReasonKey = "reason_ineligible";
    } else if (payload.committable.posture === "CAN_COMMIT") {
        posture = "CAN_COMMIT";
        blockedReasonKey = null;
    } else {
        posture = payload.committable.posture;
        blockedReasonKey = "reason_no_time";
    }

    return {
        selection,
        service,
        offer,
        window,
        payable,
        offerApplied,
        posture,
        blockedReasonKey,
        reviewReady: service !== null && window !== null,
        canCommit: posture === "CAN_COMMIT"
    };
}

/**
 * Builds a Lab URL carrying a modified selection.
 *
 * Used for every control on the page, including the language switch — which is
 * exactly why switching language preserves the selection: it rewrites one key of
 * the same state and leaves the rest alone.
 */
export function journeyHref(
    basePath: string,
    selection: AthenaSelection,
    changes: Partial<Record<keyof typeof PARAM, string | null>>
): string {
    const params = new URLSearchParams();
    const current: Record<keyof typeof PARAM, string | null> = {
        locale: selection.locale,
        service: selection.serviceCode,
        offer: selection.offerCode,
        window: selection.windowIndex === null ? null : String(selection.windowIndex),
        submitted: selection.submitted ? "1" : null
    };

    for (const key of Object.keys(PARAM) as Array<keyof typeof PARAM>) {
        const value = Object.prototype.hasOwnProperty.call(changes, key)
            ? changes[key] ?? null
            : current[key];
        if (value !== null) {
            params.set(PARAM[key], value);
        }
    }

    const query = params.toString();
    return query === "" ? basePath : `${basePath}?${query}`;
}

/**
 * The deterministic fixture result reference.
 *
 * Derived from the selection rather than generated, so the same journey always
 * yields the same reference and a UAT observation is reproducible. The `FIXTURE-`
 * prefix is load-bearing: nobody should be able to mistake this for a canonical
 * request id, which is a UUID.
 */
export function fixtureResultReference(journey: AthenaJourney): string {
    const service = journey.service?.code ?? "NO-SERVICE";
    const slot = journey.selection.windowIndex ?? "NO-SLOT";
    const offer = journey.offerApplied ? journey.offer?.code ?? "NO-OFFER" : "NO-OFFER";
    return `FIXTURE-${service}-${slot}-${offer}`;
}
