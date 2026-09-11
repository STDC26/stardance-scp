// EXE-R1 CLOSE-01 — qualification for the bounded forward delta.
//
// The previous gate proved that invalid Athena states were unreachable through
// the UI. That is a statement about layout, not about the system: a URL is typed
// as easily as it is clicked. These tests therefore drive the handler directly
// with states the UI would never offer, and require a refusal each time.
//
// Everything runs without a database, which is also the point: the zero-write
// claim is proven from the module's own import surface rather than from the
// absence of rows after a run that happened to take no action.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DemandPayload, ProjectionEnvelope } from "../../src/shell/contract";
import {
    ATHENA_FIXTURE_ACTION,
    ATHENA_TENANT,
    availabilityIdFor,
    executeAthenaFixtureAction,
    fixtureResultId
} from "../../src/shell/athenaFixtureHandler";
import {
    createFixtureProjectionProvider,
    ATHENA_LOCALES
} from "../../src/shell/fixtureProvider";
import { deriveJourney, journeyHref, parseSelection } from "../../src/shell/athenaInteraction";
import { renderAthenaPage } from "../../src/shell/athenaPage";
import { ATHENA_PROFILE } from "../../src/host/brandProfile";
import { translate } from "../../src/localization/translate";

const provider = createFixtureProjectionProvider();
const ANON = { actorId: null, role: "VISITOR" } as const;

const SERVICE = "ATH-SIGNATURE-RITUAL";
const ELIGIBLE_SLOT = 0;
const INELIGIBLE_SLOT = 2;
const OFFER = "ATH-OFFER-RESIDENT";

const FROZEN = () => "2026-09-10T00:00:00.000Z";

async function athenaDemand(locale = "en"): Promise<ProjectionEnvelope<DemandPayload>> {
    return provider.demand({ tenant: ATHENA_TENANT, actor: ANON, locale });
}

function action(
    envelope: ProjectionEnvelope<DemandPayload>,
    overrides: Partial<Parameters<typeof executeAthenaFixtureAction>[0]> = {}
) {
    return executeAthenaFixtureAction(
        {
            action: ATHENA_FIXTURE_ACTION,
            envelope,
            serviceCode: SERVICE,
            availabilityIndex: ELIGIBLE_SLOT,
            offerCode: null,
            stage: "SUBMITTING",
            ...overrides
        },
        FROZEN
    );
}

function athenaHtml(envelope: ProjectionEnvelope<DemandPayload>, query: string): string {
    return renderAthenaPage({
        envelope,
        profile: ATHENA_PROFILE,
        inspectorPath: "/labs/_inspect",
        basePath: "/labs/athena",
        params: new URLSearchParams(query),
        locales: ATHENA_LOCALES
    });
}

/** The committed, eligible selection — the only state that may produce a result. */
const COMMITTABLE = `svc=${SERVICE}&slot=${ELIGIBLE_SLOT}`;

// ---------------------------------------------------------------------------
// F01 — SUBMITTING is interaction state, and it is not a canonical state
// ---------------------------------------------------------------------------

describe("EXE-R1-F01 SUBMITTING", () => {
    it("is derived as an interaction stage from the URL, not stored anywhere", async () => {
        const envelope = await athenaDemand();
        const selection = parseSelection(new URLSearchParams(`${COMMITTABLE}&submit=1`), ATHENA_LOCALES);
        expect(selection.submitting).toBe(true);
        expect(selection.submitted).toBe(false);
        expect(deriveJourney(selection, envelope.payload).stage).toBe("SUBMITTING");
    });

    it("renders progress and states that the request must not be sent again", async () => {
        const html = athenaHtml(await athenaDemand(), `${COMMITTABLE}&submit=1`);
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain('role="progressbar"');
        expect(html).toContain(translate("athena", "loading", "en"));
        expect(html).toContain(translate("athena", "loading_note", "en"));
    });

    it("offers no submit control while submitting, so the action cannot be repeated", async () => {
        const html = athenaHtml(await athenaDemand(), `${COMMITTABLE}&submit=1`);
        // The commit and request controls are the only ways to submit, and both
        // are absent from this stage.
        expect(html).not.toContain(translate("athena", "action_commit", "en"));
        expect(html).not.toContain(translate("athena", "action_request", "en"));
    });

    it("is unreachable for a selection that cannot commit, however the URL is typed", async () => {
        const envelope = await athenaDemand();
        const ineligible = parseSelection(
            new URLSearchParams(`svc=${SERVICE}&slot=${INELIGIBLE_SLOT}&submit=1&done=1`),
            ATHENA_LOCALES
        );
        const journey = deriveJourney(ineligible, envelope.payload);
        expect(journey.stage).toBe("REVIEW");
        expect(journey.canCommit).toBe(false);
        expect(journey.blockedReasonKey).toBe("reason_ineligible");
    });

    it("keeps the approved ineligible semantic: visible, selectable, reviewable, not committable", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, `svc=${SERVICE}&slot=${INELIGIBLE_SLOT}`);
        // Visible and selectable.
        expect(html).toContain(envelope.payload.availability[INELIGIBLE_SLOT]!.label);
        expect(html).toContain(translate("athena", "av_selected", "en"));
        // Reviewable, with the refusal stated rather than the row removed.
        expect(html).toContain(translate("athena", "av_not_eligible", "en"));
        expect(html).toContain(translate("athena", "reason_ineligible", "en"));
        // Not committable.
        expect(html).toContain('aria-disabled="true"');
    });
});

// ---------------------------------------------------------------------------
// F02 — the typed result
// ---------------------------------------------------------------------------

describe("EXE-R1-F02 typed fixture result", () => {
    it("produces a typed result for a valid action", async () => {
        const outcome = action(await athenaDemand());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.result).toEqual({
            resultId: fixtureResultId(SERVICE, ELIGIBLE_SLOT, null),
            sourceType: "FIXTURE",
            fixtureVersion: "athena-uat.fixtures.v2",
            status: "SIMULATED_REQUEST_ACCEPTED",
            selectedServiceId: SERVICE,
            selectedAvailabilityId: availabilityIdFor(
                (await athenaDemand()).payload.availability[ELIGIBLE_SLOT]!,
                ELIGIBLE_SLOT
            ),
            generatedAt: FROZEN()
        });
    });

    it("marks the source as FIXTURE and the status as simulated", async () => {
        const outcome = action(await athenaDemand());
        if (!outcome.ok) throw new Error("expected success");
        expect(outcome.result.sourceType).toBe("FIXTURE");
        expect(outcome.result.status).toBe("SIMULATED_REQUEST_ACCEPTED");
    });

    it("carries the commercial choice only when one was actually made", async () => {
        const withOffer = action(await athenaDemand(), { offerCode: OFFER });
        const without = action(await athenaDemand());
        if (!withOffer.ok || !without.ok) throw new Error("expected success");
        expect(withOffer.result.commercialChoiceId).toBe(OFFER);
        expect(without.result).not.toHaveProperty("commercialChoiceId");
    });

    it("gives a result id that cannot be mistaken for a canonical SCP id", async () => {
        const outcome = action(await athenaDemand());
        if (!outcome.ok) throw new Error("expected success");
        expect(outcome.result.resultId.startsWith("FIXTURE-")).toBe(true);
        expect(outcome.result.resultId).not.toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it("is deterministic, and identical in English and French", async () => {
        const en = action(await athenaDemand("en"));
        const fr = action(await athenaDemand("fr"));
        if (!en.ok || !fr.ok) throw new Error("expected success");
        expect(fr.result).toEqual(en.result);
    });
});

// ---------------------------------------------------------------------------
// F03 — the handler refuses; it never repairs
// ---------------------------------------------------------------------------

describe("EXE-R1-F03 explicit validation", () => {
    it("refuses a wrong tenant", async () => {
        const envelope = { ...(await athenaDemand()), tenant: "freshline-uat" };
        const outcome = action(envelope);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("WRONG_TENANT");
    });

    it("refuses a LIVE projection", async () => {
        const base = await athenaDemand();
        const envelope = {
            ...base,
            provenance: { ...base.provenance, sourceType: "LIVE" as const }
        };
        const outcome = action(envelope);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NOT_FIXTURE_SOURCE");
    });

    it("refuses an unknown service rather than defaulting to the first one", async () => {
        const outcome = action(await athenaDemand(), { serviceCode: "ATH-DOES-NOT-EXIST" });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("UNKNOWN_SERVICE");
    });

    it("refuses a missing service", async () => {
        const outcome = action(await athenaDemand(), { serviceCode: null });
        if (outcome.ok) throw new Error("expected refusal");
        expect(outcome.code).toBe("UNKNOWN_SERVICE");
    });

    it("refuses an unknown availability rather than clamping the index", async () => {
        for (const index of [99, -1, null]) {
            const outcome = action(await athenaDemand(), { availabilityIndex: index });
            if (outcome.ok) throw new Error(`expected refusal for index ${String(index)}`);
            expect(outcome.code).toBe("UNKNOWN_AVAILABILITY");
        }
    });

    it("refuses an ineligible window rather than substituting an eligible one", async () => {
        const outcome = action(await athenaDemand(), { availabilityIndex: INELIGIBLE_SLOT });
        if (outcome.ok) throw new Error("expected refusal");
        expect(outcome.code).toBe("AVAILABILITY_NOT_ELIGIBLE");
        expect(outcome.messageKey).toBe("reason_ineligible");
    });

    it("refuses an invalid commercial choice rather than dropping it", async () => {
        const outcome = action(await athenaDemand(), { offerCode: "ATH-OFFER-IMAGINARY" });
        if (outcome.ok) throw new Error("expected refusal");
        expect(outcome.code).toBe("INVALID_COMMERCIAL_CHOICE");
        expect(outcome.messageKey).toBe("reason_invalid_offer");
    });

    it("refuses an unknown action and any stage that is not SUBMITTING", async () => {
        const envelope = await athenaDemand();
        const wrongAction = action(envelope, { action: "ATHENA_CANCEL" });
        const wrongStage = action(envelope, { stage: "REVIEW" });
        if (wrongAction.ok || wrongStage.ok) throw new Error("expected refusal");
        expect(wrongAction.code).toBe("INVALID_INTERACTION_STATE");
        expect(wrongStage.code).toBe("INVALID_INTERACTION_STATE");
    });

    it("never returns a partial result alongside a refusal", async () => {
        const outcome = action(await athenaDemand(), { availabilityIndex: INELIGIBLE_SLOT });
        expect(outcome).not.toHaveProperty("result");
        expect(Object.keys(outcome).sort()).toEqual(["code", "detail", "messageKey", "ok"]);
    });
});

// ---------------------------------------------------------------------------
// F03 — the refusal reaches the customer as a recoverable failure
// ---------------------------------------------------------------------------

describe("EXE-R1-F03 failure surface", () => {
    it("shows an error and a retry instead of a fabricated result", async () => {
        const envelope = await athenaDemand();
        // An offer code the fixture does not carry, on an otherwise valid,
        // committable selection: reachable only by editing the URL.
        const html = athenaHtml(envelope, `${COMMITTABLE}&offer=ATH-OFFER-IMAGINARY&done=1`);
        expect(html).toContain(translate("athena", "error", "en"));
        expect(html).toContain(translate("athena", "retry", "en"));
        expect(html).toContain(translate("athena", "change", "en"));
        expect(html).toContain('role="alert"');
        expect(html).not.toContain(translate("athena", "result_title", "en"));
    });

    it("lets retry resume from the selection the customer already has", async () => {
        const envelope = await athenaDemand();
        const html = athenaHtml(envelope, `${COMMITTABLE}&offer=ATH-OFFER-IMAGINARY&done=1`);
        // Retry returns to review with the selection intact and the in-flight
        // flags cleared — not to a blank journey, and not back into the failure.
        const retryHref = [...html.matchAll(/href="([^"]+)"[^>]*>Try again</g)][0]?.[1] ?? "";
        expect(retryHref).toContain(`svc=${SERVICE}`);
        expect(retryHref).toContain(`slot=${ELIGIBLE_SLOT}`);
        expect(retryHref).not.toContain("done=1");
        expect(retryHref).not.toContain("submit=1");
        expect(retryHref.endsWith("#review")).toBe(true);
    });

    it("renders the result only once the handler has accepted the action", async () => {
        const html = athenaHtml(await athenaDemand(), `${COMMITTABLE}&done=1`);
        expect(html).toContain(translate("athena", "result_title", "en"));
        expect(html).toContain(fixtureResultId(SERVICE, ELIGIBLE_SLOT, null));
        expect(html).toContain(translate("athena", "review_source_value", "en"));
    });
});

// ---------------------------------------------------------------------------
// F04 — zero canonical writes, proven from the import surface
// ---------------------------------------------------------------------------

describe("EXE-R1-F04 zero canonical writes", () => {
    const source = readFileSync("src/shell/athenaFixtureHandler.ts", "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    it("imports nothing that could write", () => {
        const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
        expect(imports).toEqual(["./contract"]);
    });

    it("names no persistence primitive anywhere in its body", () => {
        for (const forbidden of [
            "pg",
            "Pool",
            "client",
            "query(",
            "INSERT",
            "UPDATE",
            "DELETE",
            "transaction",
            "repository",
            "commandBus",
            "startRuntime"
        ]) {
            expect(code).not.toContain(forbidden);
        }
    });

    it("imports only a type from the contract, so it holds no runtime handle at all", () => {
        expect(code).toContain('import type { DemandPayload, ProjectionEnvelope } from "./contract"');
    });
});

// ---------------------------------------------------------------------------
// F05 — the interaction-state language exists in both languages
// ---------------------------------------------------------------------------

describe("EXE-R1-F05 interaction language", () => {
    const KEYS = ["loading", "loading_note", "continue", "error", "retry", "back", "change"] as const;

    for (const locale of ["en", "fr"] as const) {
        it(`defines every interaction-state string in ${locale.toUpperCase()}`, () => {
            for (const key of KEYS) {
                const value = translate("athena", key, locale);
                expect(value.length).toBeGreaterThan(0);
                expect(value).not.toBe(key);
            }
        });
    }

    it("does not leave French falling back to English for these states", () => {
        for (const key of KEYS) {
            expect(translate("athena", key, "fr")).not.toBe(translate("athena", key, "en"));
        }
    });

    it("renders the French submitting state in French", async () => {
        const html = athenaHtml(await athenaDemand("fr"), `lang=fr&${COMMITTABLE}&submit=1`);
        expect(html).toContain(translate("athena", "loading", "fr"));
        expect(html).toContain(translate("athena", "back", "fr"));
    });
});

// ---------------------------------------------------------------------------
// Locale invariance across the new stages
// ---------------------------------------------------------------------------

describe("EXE-R1 locale stability across submit and result", () => {
    it("carries the whole selection through a language switch mid-submit", () => {
        const selection = parseSelection(
            new URLSearchParams(`lang=en&svc=${SERVICE}&slot=${ELIGIBLE_SLOT}&offer=${OFFER}&submit=1`),
            ATHENA_LOCALES
        );
        const href = journeyHref("/labs/athena", selection, { locale: "fr" });
        const switched = parseSelection(new URLSearchParams(href.split("?")[1]), ATHENA_LOCALES);
        expect(switched).toEqual({ ...selection, locale: "fr" });
    });

    it("keeps the result identical when the language changes", async () => {
        const en = athenaHtml(await athenaDemand("en"), `lang=en&${COMMITTABLE}&done=1`);
        const fr = athenaHtml(await athenaDemand("fr"), `lang=fr&${COMMITTABLE}&done=1`);
        const reference = fixtureResultId(SERVICE, ELIGIBLE_SLOT, null);
        expect(en).toContain(reference);
        expect(fr).toContain(reference);
        expect(fr).toContain(translate("athena", "result_title", "fr"));
    });
});
