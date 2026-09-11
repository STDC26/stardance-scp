// EXE-R1-F02/F03 — the explicit Athena fixture interaction handler.
//
// Until now, invalid Athena states were impossible because the UI never offered
// them: `deriveJourney` simply did not produce a commit control unless the
// selection was complete and eligible. That is reachability, not validation, and
// the specification is right to distinguish them — a URL is typed by hand as
// easily as it is clicked, and "the button wasn't there" is not a refusal.
//
// So this module refuses. Every one of the ten required conditions is checked
// against the projection that is actually in hand, and a failure returns a coded
// refusal rather than a repaired state. Nothing here silently fixes anything:
// an unknown service is refused, not defaulted; an ineligible window is refused,
// not swapped for the next eligible one.
//
// It performs ZERO canonical writes, and cannot: it imports no pool, no client,
// no repository and no command. That is not a promise, it is the module's import
// list, and a test asserts it.
//
// LOCK: FIXTURE RESULT ≠ CANONICAL CONFIRMATION. The result below carries an
// explicit `sourceType: "FIXTURE"`, a `status` that says SIMULATED, and a
// `resultId` prefixed so it cannot be mistaken for a canonical SCP object id
// (which is a UUID).

import type { DemandPayload, ProjectionEnvelope } from "./contract";

/** The tenant this handler will act for. Any other tenant is refused. */
export const ATHENA_TENANT = "athena-uat";

/** Semantic action id for the one bounded UAT interaction. */
export const ATHENA_FIXTURE_ACTION = "ATHENA_FIXTURE_REQUEST";

/**
 * The deterministic, explicitly non-authoritative outcome of a fixture action.
 *
 * `status` is deliberately verbose. "ACCEPTED" alone would read as a booking;
 * "SIMULATED_REQUEST_ACCEPTED" cannot.
 */
export interface AthenaFixtureResult {
    resultId: string;
    sourceType: "FIXTURE";
    fixtureVersion: string;
    status: "SIMULATED_REQUEST_ACCEPTED";
    selectedServiceId: string;
    selectedAvailabilityId: string;
    commercialChoiceId?: string;
    generatedAt: string;
}

export type AthenaRefusalCode =
    | "WRONG_TENANT"
    | "NOT_FIXTURE_SOURCE"
    | "UNKNOWN_SERVICE"
    | "UNKNOWN_AVAILABILITY"
    | "AVAILABILITY_NOT_AVAILABLE"
    | "AVAILABILITY_NOT_ELIGIBLE"
    | "INVALID_COMMERCIAL_CHOICE"
    | "INVALID_INTERACTION_STATE";

export interface AthenaRefusal {
    ok: false;
    code: AthenaRefusalCode;
    /** Dictionary key for customer-facing copy, or null when internal-only. */
    messageKey: string | null;
    detail: string;
}

export type AthenaFixtureOutcome = { ok: true; result: AthenaFixtureResult } | AthenaRefusal;

export interface AthenaFixtureActionInput {
    action: string;
    envelope: ProjectionEnvelope<DemandPayload>;
    serviceCode: string | null;
    /** Index into the projection's availability list. */
    availabilityIndex: number | null;
    offerCode: string | null;
    /** The interaction stage the caller believes it is in. */
    stage: string;
}

function refuse(code: AthenaRefusalCode, detail: string, messageKey: string | null): AthenaRefusal {
    return { ok: false, code, messageKey, detail };
}

/**
 * A stable id for the availability window.
 *
 * The projection's windows are positional, so the index plus the window's own
 * instant is what identifies one. Using the instant rather than the localized
 * label keeps the id identical in English and French — a result must not change
 * because the page was being read in another language.
 */
export function availabilityIdFor(window: { startsAt: string }, index: number): string {
    return `slot-${index}-${window.startsAt}`;
}

/**
 * Derives the result id deterministically from the selection.
 *
 * The same journey always yields the same id, so a UAT observation is
 * reproducible — and the `FIXTURE-` prefix is load-bearing: a canonical SCP
 * object id is a UUID, so this shape cannot be mistaken for one.
 */
export function fixtureResultId(
    serviceCode: string,
    availabilityIndex: number,
    offerCode: string | null
): string {
    return `FIXTURE-${serviceCode}-${availabilityIndex}-${offerCode ?? "NO-OFFER"}`;
}

/**
 * Executes the one authorized Athena fixture action, or refuses.
 *
 * `generatedAt` is the only non-deterministic field, and it is metadata about
 * the read rather than part of the result's content.
 */
export function executeAthenaFixtureAction(
    input: AthenaFixtureActionInput,
    now: () => string = () => new Date().toISOString()
): AthenaFixtureOutcome {
    const { envelope } = input;

    // 8 — the action must be the one this handler exists for, in a stage that can
    // legitimately submit. Checked first so a malformed call cannot be read as a
    // commentary on the customer's selection.
    if (input.action !== ATHENA_FIXTURE_ACTION) {
        return refuse("INVALID_INTERACTION_STATE", `unknown action ${input.action}`, null);
    }
    if (input.stage !== "SUBMITTING") {
        return refuse(
            "INVALID_INTERACTION_STATE",
            `action requires SUBMITTING, saw ${input.stage}`,
            null
        );
    }

    // 1 — tenant.
    if (envelope.tenant !== ATHENA_TENANT) {
        return refuse("WRONG_TENANT", `tenant ${envelope.tenant} is not ${ATHENA_TENANT}`, null);
    }

    // 2 — provenance. A LIVE projection must never reach a fixture handler.
    if (envelope.provenance.sourceType !== "FIXTURE") {
        return refuse(
            "NOT_FIXTURE_SOURCE",
            `sourceType ${envelope.provenance.sourceType} is not FIXTURE`,
            null
        );
    }

    // 3 — the service must exist in the projection actually in hand.
    const service =
        input.serviceCode === null
            ? undefined
            : envelope.payload.services.find((candidate) => candidate.code === input.serviceCode);
    if (service === undefined) {
        return refuse("UNKNOWN_SERVICE", `service ${input.serviceCode ?? "<none>"} not in fixture`, "reason_no_service");
    }

    // 4 — the availability must exist.
    const index = input.availabilityIndex;
    const window = index === null ? undefined : envelope.payload.availability[index];
    if (window === undefined) {
        return refuse(
            "UNKNOWN_AVAILABILITY",
            `availability index ${index ?? "<none>"} not in fixture`,
            "reason_no_time"
        );
    }

    // 5 — presence in the availability list IS availability in this contract;
    // there is no separate `available` flag to consult, and inventing one would
    // be a contract change rather than a validation.
    // 6 — eligibility, which is a DIFFERENT question and is asked separately.
    if (window.eligible !== true) {
        return refuse(
            "AVAILABILITY_NOT_ELIGIBLE",
            `availability ${index} is eligible=${String(window.eligible)}`,
            "reason_ineligible"
        );
    }

    // 7 — a commercial choice, when supplied, must be a real one. The raw
    // selection is validated, not the renderer's view of it: silently dropping a
    // code the fixture does not carry would be a repair, and repairs are exactly
    // what this handler exists to refuse.
    //
    // Only an applied OFFER becomes a commercial choice on the result, though. A
    // RECOMMENDATION is selectable and changes nothing it is owed — OFFER ≠
    // SUGGESTION — so recording it as the choice would overstate it.
    let commercialChoiceId: string | null = null;
    if (input.offerCode !== null) {
        const offer = envelope.payload.offers.find((candidate) => candidate.code === input.offerCode);
        if (offer === undefined) {
            return refuse(
                "INVALID_COMMERCIAL_CHOICE",
                `offer ${input.offerCode} not in fixture`,
                "reason_invalid_offer"
            );
        }
        commercialChoiceId = offer.kind === "OFFER" ? offer.code : null;
    }

    // 9 — emitted as FIXTURE. 10 — zero canonical writes: there is nothing in
    // this module's scope capable of one.
    const result: AthenaFixtureResult = {
        resultId: fixtureResultId(service.code, index as number, commercialChoiceId),
        sourceType: "FIXTURE",
        fixtureVersion: envelope.provenance.fixtureVersion ?? "unversioned",
        status: "SIMULATED_REQUEST_ACCEPTED",
        selectedServiceId: service.code,
        selectedAvailabilityId: availabilityIdFor(window, index as number),
        ...(commercialChoiceId === null ? {} : { commercialChoiceId }),
        generatedAt: now()
    };

    return { ok: true, result };
}
