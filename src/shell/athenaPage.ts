// C5 / UAT-R1 — the Athena demand surface.
//
// Its input is a `ProjectionEnvelope<DemandPayload>` — the same contract the
// Freshline LIVE provider produces. That is the 1:MANY proof: two materially
// different surfaces, one Shell-facing contract, and no tenant branch anywhere in
// Core. Everything that differs is on one of three lines: the Brand Experience
// Profile, the projection payload, or the composition below.
//
// UAT-R1 made it functional rather than merely rendered. Every control is a plain
// link carrying bounded state in the query string, so the journey works with no
// client JavaScript, no session store and no canonical write — and stays a pure
// function that tests can drive without a browser.
//
// It renders semantics rather than optimism, which is where most demo UIs lie:
//
//   RECOMMENDATION ≠ OFFER      a suggestion is labelled as one and cannot change
//                               the payable amount — `deriveJourney` ignores it.
//   AVAILABLE ≠ ELIGIBLE        an ineligible window stays visible and selectable,
//                               and then blocks commitment with a stated reason.
//   ELIGIBILITY ≠ COMMITMENT    the commit control follows the derived posture, and
//                               when it is off the reason is printed, not hidden.
//   FIXTURE ≠ LIVE              the banner says FIXTURE and the result says
//                               "nothing has been reserved".
//
// Language changes words only. Every label comes from the shared dictionary, every
// amount from `formatMoney(minorUnits, currency, locale)`, and the amount itself is
// never recomputed — so EN and FR differ in presentation and in nothing else.

import { escapeHtml } from "../host/page";
import type { BrandExperienceProfile } from "../host/brandProfile";
import { translate } from "../localization/translate";
import { formatMoney } from "./money";
import {
    deriveJourney,
    fixtureResultReference,
    journeyHref,
    parseSelection,
    type AthenaJourney,
    type AthenaSelection
} from "./athenaInteraction";
import type { DemandPayload, ProjectionEnvelope } from "./contract";

export interface AthenaPageOptions {
    envelope: ProjectionEnvelope<DemandPayload>;
    profile: BrandExperienceProfile;
    /** Where the provenance inspector lives, linked from the source banner. */
    inspectorPath: string;
    /** This surface's own path, for building control links. */
    basePath: string;
    /** The request's query string, which carries the bounded UAT state. */
    params: URLSearchParams;
    /** Locales this surface offers. Index 0 is primary. */
    locales: readonly string[];
}

/** Dictionary shorthand, bound to the active locale. */
function makeT(locale: string): (key: string) => string {
    return (key) => translate("athena", key, locale);
}

const POSTURE_KEY: Readonly<Record<string, string>> = {
    CAN_COMMIT: "posture_can_commit",
    CAN_REQUEST: "posture_can_request",
    NOT_ELIGIBLE: "posture_not_eligible",
    NO_VALID_CAPACITY: "posture_no_capacity",
    REQUIRES_AUTHORITY: "posture_not_determined",
    NOT_DETERMINED: "posture_not_determined"
};

function sourceBanner(
    envelope: ProjectionEnvelope<DemandPayload>,
    inspectorPath: string,
    t: (key: string) => string
): string {
    const p = envelope.provenance;
    const isFixture = p.sourceType === "FIXTURE";
    const version = p.fixtureVersion ?? p.sourceVersion ?? "unversioned";
    return `<aside class="src ${isFixture ? "src-fixture" : "src-live"}">
      <span class="src-dot"></span>
      <span>${escapeHtml(t("sim_notice"))}</span>
      <a class="src-link" href="${escapeHtml(inspectorPath)}">${escapeHtml(t("sim_details"))}</a>
    </aside>`;
}

function languageSwitch(
    options: AthenaPageOptions,
    selection: AthenaSelection,
    t: (key: string) => string
): string {
    const links = options.locales
        .map((code) => {
            // Only `lang` changes. Every other selection rides through untouched,
            // which is what makes UAT-R1-05 structural rather than aspirational.
            const href = journeyHref(options.basePath, selection, { locale: code });
            const on = code === selection.locale;
            return `<a class="lang${on ? " lang-on" : ""}" href="${escapeHtml(href)}" hreflang="${escapeHtml(code)}">${escapeHtml(code.toUpperCase())}</a>`;
        })
        .join("");
    return `<nav class="langs" aria-label="${escapeHtml(t("lang_switch"))}">
      <span class="lang-label">${escapeHtml(t("lang_switch"))}</span>${links}
    </nav>`;
}

function serviceCard(
    service: DemandPayload["services"][number],
    options: AthenaPageOptions,
    journey: AthenaJourney,
    t: (key: string) => string
): string {
    const chosen = journey.service?.code === service.code;
    const href = `${journeyHref(options.basePath, journey.selection, {
        service: chosen ? null : service.code,
        submitted: null
    })}#${service.code}`;
    const price = formatMoney(
        service.price.minorUnits,
        service.price.currency,
        journey.selection.locale
    );

    return `<a id="${escapeHtml(service.code)}" class="svc${service.featured === true ? " svc-featured" : ""}${chosen ? " svc-chosen" : ""}"
       href="${escapeHtml(href)}" aria-pressed="${chosen ? "true" : "false"}">
      <div class="svc-head">
        <h3>${escapeHtml(service.name)}</h3>
        <p class="svc-price">${escapeHtml(price)}</p>
      </div>
      ${service.description === undefined ? "" : `<p class="svc-copy">${escapeHtml(service.description)}</p>`}
      <p class="svc-meta">${service.durationMinutes} ${escapeHtml(t("svc_minutes"))}</p>
      <span class="btn${chosen ? " btn-on" : ""}">${escapeHtml(chosen ? t("svc_chosen") : t("svc_choose"))}</span>
    </a>`;
}

function offerRow(
    offer: DemandPayload["offers"][number],
    options: AthenaPageOptions,
    journey: AthenaJourney,
    t: (key: string) => string
): string {
    const isRecommendation = offer.kind === "RECOMMENDATION";
    const applied = journey.offer?.code === offer.code;
    const href = `${journeyHref(options.basePath, journey.selection, {
        offer: applied ? null : offer.code,
        submitted: null
    })}#offers`;
    const price = formatMoney(offer.price.minorUnits, offer.price.currency, journey.selection.locale);

    return `<li class="offer ${isRecommendation ? "offer-rec" : "offer-authorised"}${applied ? " offer-on" : ""}">
      <span class="offer-kind">${escapeHtml(isRecommendation ? t("offer_kind_sugg") : t("offer_kind_offer"))}</span>
      <span class="offer-label">${escapeHtml(offer.label)}</span>
      <span class="offer-price">${escapeHtml(price)}</span>
      ${offer.description === undefined ? "" : `<span class="offer-copy">${escapeHtml(offer.description)}</span>`}
      ${isRecommendation ? `<span class="offer-caveat">${escapeHtml(t("offer_caveat"))}</span>` : ""}
      <a class="offer-act" href="${escapeHtml(href)}" aria-pressed="${applied ? "true" : "false"}">${escapeHtml(applied ? t("offer_applied") : t("offer_apply"))}</a>
    </li>`;
}

function availabilityRow(
    window: DemandPayload["availability"][number],
    index: number,
    options: AthenaPageOptions,
    journey: AthenaJourney,
    t: (key: string) => string
): string {
    const status =
        window.eligible === undefined
            ? `<span class="av-unknown">${escapeHtml(t("av_not_determined"))}</span>`
            : window.eligible
              ? `<span class="av-ok">${escapeHtml(t("av_eligible"))}</span>`
              : `<span class="av-blocked">${escapeHtml(t("av_not_eligible"))}</span>`;

    const selected = journey.selection.windowIndex === index;
    // Selectable even when ineligible: hiding it would misrepresent supply, and the
    // block belongs at commitment where the reason can be stated.
    const href = `${journeyHref(options.basePath, journey.selection, {
        window: selected ? null : String(index),
        submitted: null
    })}#when`;

    return `<li class="av${window.eligible === false ? " av-off" : ""}${selected ? " av-on" : ""}">
      <a class="av-link" href="${escapeHtml(href)}" aria-pressed="${selected ? "true" : "false"}">
        <span class="av-label">${escapeHtml(window.label)}</span>
        ${status}
        <span class="av-act">${escapeHtml(selected ? t("av_selected") : t("av_select"))}</span>
      </a>
    </li>`;
}

function reviewRow(label: string, value: string, extraClass = ""): string {
    return `<div class="rev-row ${extraClass}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function reviewSection(
    options: AthenaPageOptions,
    journey: AthenaJourney,
    envelope: ProjectionEnvelope<DemandPayload>,
    t: (key: string) => string
): string {
    const locale = journey.selection.locale;
    const none = t("review_none");
    const payable =
        journey.payable === null
            ? none
            : formatMoney(journey.payable.minorUnits, journey.payable.currency, locale);

    const eligibility =
        journey.window === null
            ? none
            : journey.window.eligible === undefined
              ? t("av_not_determined")
              : journey.window.eligible
                ? t("av_eligible")
                : t("av_not_eligible");

    const postureKey = POSTURE_KEY[journey.posture] ?? "posture_not_determined";

    const requestHref = `${journeyHref(options.basePath, journey.selection, { submitted: "1" })}#review`;
    const commitHref = `${journeyHref(options.basePath, journey.selection, { submitted: "1" })}#review`;
    const restartHref = journeyHref(options.basePath, journey.selection, {
        service: null,
        offer: null,
        window: null,
        submitted: null
    });

    if (journey.selection.submitted && journey.reviewReady && journey.canCommit) {
        // Deterministic fixture result. Explicitly simulated, with no canonical id.
        return `<section class="review result" id="review">
          <h2>${escapeHtml(t("section_review"))}</h2>
          <p class="posture">${escapeHtml(t("result_title"))}</p>
          <p class="posture-reason">${escapeHtml(t("result_body"))}</p>
          <dl class="rev">
            ${reviewRow(t("review_service"), journey.service?.name ?? none)}
            ${reviewRow(t("review_price"), payable)}
            ${reviewRow(t("review_time"), journey.window?.label ?? none)}
            ${reviewRow(t("review_currency"), journey.payable?.currency ?? none)}
            ${reviewRow(t("result_reference"), fixtureResultReference(journey))}
            ${reviewRow(t("review_source"), t("review_source_value"))}
          </dl>
          <div class="actions">
            <a class="btn" href="${escapeHtml(restartHref)}">${escapeHtml(t("action_restart"))}</a>
          </div>
        </section>`;
    }

    return `<section class="review" id="review">
      <h2>${escapeHtml(t("section_review"))}</h2>
      <p class="posture">${escapeHtml(t(postureKey))}</p>
      <dl class="rev">
        ${reviewRow(t("review_service"), journey.service?.name ?? none)}
        ${reviewRow(t("review_price"), payable)}
        ${reviewRow(t("review_offer"), journey.offerApplied ? journey.offer?.label ?? none : none)}
        ${reviewRow(t("review_time"), journey.window?.label ?? none)}
        ${reviewRow(t("review_eligibility"), eligibility)}
        ${reviewRow(t("review_currency"), journey.payable?.currency ?? none)}
        ${reviewRow(t("review_source"), t("review_source_value"))}
      </dl>
      <div class="actions">
        ${
            journey.reviewReady
                ? `<a class="btn" href="${escapeHtml(requestHref)}">${escapeHtml(t("action_request"))}</a>`
                : `<span class="btn btn-off" aria-disabled="true">${escapeHtml(t("action_request"))}</span>`
        }
        ${
            journey.canCommit
                ? `<a class="btn btn-primary" href="${escapeHtml(commitHref)}">${escapeHtml(t("action_commit"))}</a>`
                : `<span class="btn btn-primary btn-off" aria-disabled="true">${escapeHtml(t("action_commit"))}</span>`
        }
        ${
            journey.blockedReasonKey === null
                ? ""
                : `<p class="action-reason">${escapeHtml(t(journey.blockedReasonKey))}</p>`
        }
      </div>
    </section>`;
}


/**
 * UAT-R2 — the next action, stated where the customer is looking.
 *
 * The founder could not complete the journey even though every control worked. The
 * guidance that said what to do next lived in the Review section at the bottom of a
 * long page, so a selection produced no visible progress at the point of attention.
 * This strip is that feedback, above the fold, updating on every step.
 */
/**
 * UAT-R2 — the projection's state label, in the customer's language.
 *
 * The envelope carries an English label because a projection is not a renderer.
 * The Shell localizes it by the state CODE, which is the canonical part, and falls
 * back to the envelope's own label when a state has no entry — so a new state
 * degrades to English rather than to a blank.
 */
function stateLabel(
    envelope: ProjectionEnvelope<DemandPayload>,
    t: (key: string) => string
): string {
    return t(`state_${envelope.state.code}`) || envelope.state.label;
}

function stepStrip(journey: AthenaJourney, t: (key: string) => string): string {
    const postureKey = POSTURE_KEY[journey.posture] ?? "posture_not_determined";
    const done = (journey.service === null ? 0 : 1) + (journey.window === null ? 0 : 1);

    return `<aside class="steps" aria-live="polite">
      <span class="steps-dots">${[0, 1].map((i) => `<span class="dot${i < done ? " dot-on" : ""}"></span>`).join("")}</span>
      <span class="steps-posture">${escapeHtml(t(postureKey))}</span>
    </aside>`;
}

export function renderAthenaPage(options: AthenaPageOptions): string {
    const { envelope, profile, inspectorPath } = options;
    const d = envelope.payload;
    const selection = parseSelection(options.params, options.locales);
    const journey = deriveJourney(selection, d);
    const t = makeT(selection.locale);

    const ink = d.brand.colors["ink"] ?? "#1A1714";
    const parchment = d.brand.colors["parchment"] ?? "#F7F3EC";
    const bronze = d.brand.colors["bronze"] ?? "#8C6A43";
    const sage = d.brand.colors["sage"] ?? "#5A6B5D";
    const line = d.brand.colors["line"] ?? "#DED5C7";

    return `<!doctype html>
<html lang="${escapeHtml(selection.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(d.brand.publicName)} — ${escapeHtml(d.brand.marketDescriptor)}</title>
<style>
:root{
  --ink:${ink};--parchment:${parchment};--bronze:${bronze};--sage:${sage};--line:${line};
  --heading:${d.brand.headingFont},${profile.headingFallback};
  --body:${d.brand.bodyFont},${profile.bodyFallback};
  --radius:${profile.radius};
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
.svc,h2[id],section[id]{scroll-margin-top:96px}
body{background:var(--parchment);color:var(--ink);font-family:var(--body);
  font-size:${profile.baseFontSize};line-height:${profile.baseLineHeight};-webkit-text-size-adjust:100%}
.wrap{width:100%;max-width:${profile.contentMaxWidth};margin:0 auto;padding:${profile.contentPadding}}

.masthead{border-bottom:1px solid var(--line);padding-bottom:36px}
h1{font-family:var(--heading);font-weight:${profile.h1Weight};font-size:${profile.h1Size};
  letter-spacing:${profile.h1LetterSpacing};line-height:1.05;margin:0 0 18px}
.tagline{font-family:var(--heading);font-size:1.35rem;font-style:italic;color:var(--sage);margin:0 0 10px}
.locale{font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--bronze);margin:0}
h2{font-family:var(--body);font-size:.75rem;font-weight:600;
  text-transform:${profile.h2Transform};letter-spacing:${profile.h2LetterSpacing};
  color:var(--bronze);margin:${profile.sectionMargin}}

.langs{display:flex;align-items:center;gap:6px;margin:0 0 20px}
.lang-label{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sage);margin-right:6px}
.lang{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;
  padding:0 12px;text-decoration:none;color:var(--sage);border:1px solid var(--line);border-radius:var(--radius);
  font-size:.78rem;letter-spacing:.12em}
.lang-on{background:var(--ink);color:var(--parchment);border-color:var(--ink)}

.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 26px;
  border:1px solid var(--ink);border-radius:var(--radius);text-decoration:none;color:var(--ink);
  font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;background:transparent}
.btn-primary{background:var(--ink);color:var(--parchment)}
.btn-on{background:var(--sage);color:#fff;border-color:var(--sage)}
.btn-off{opacity:.38;cursor:not-allowed}

.steps{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin:0 0 26px;padding:14px 18px;
  border:1px solid var(--line);border-radius:var(--radius);background:#fff}
.steps-dots{display:inline-flex;gap:6px}
.dot{width:9px;height:9px;border-radius:50%;border:1px solid var(--sage)}
.dot-on{background:var(--sage)}
.steps-posture{font-family:var(--heading);font-size:1.1rem}
.steps-next{color:var(--sage);font-style:italic;font-size:.9rem}

.svcs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:${profile.chipGap}}
.svc{border:1px solid var(--line);border-radius:var(--radius);padding:28px;background:rgba(255,255,255,.55);
  display:flex;flex-direction:column;gap:0;text-decoration:none;color:inherit;cursor:pointer}
.svc:hover{border-color:var(--bronze)}
.svc .btn{pointer-events:none}
.svc-featured{border-color:var(--bronze);background:#fff}
.svc-chosen{outline:2px solid var(--sage);outline-offset:-2px}
.svc-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.svc h3{font-family:var(--heading);font-weight:400;font-size:1.5rem;margin:0}
.svc-price{font-family:var(--heading);font-size:1.25rem;color:var(--bronze);margin:0;white-space:nowrap}
.svc-copy{margin:14px 0 0;color:#4A443D}
.svc-meta{margin:18px 0 20px;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:var(--sage)}
.svc .btn{align-self:flex-start;margin-top:auto}

.offers{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.offer{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:baseline;
  padding:18px 0;border-bottom:1px solid var(--line)}
.offer-on{background:rgba(140,106,67,.07)}
.offer-kind{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.offer-authorised .offer-kind{background:var(--bronze);color:#fff}
.offer-rec .offer-kind{background:transparent;border:1px dashed var(--sage);color:var(--sage)}
.offer-label{font-family:var(--heading);font-size:1.2rem}
.offer-price{font-family:var(--heading);color:var(--bronze)}
.offer-copy,.offer-caveat{grid-column:1 / -1;font-size:.9rem;color:#4A443D;margin:0}
.offer-caveat{color:var(--sage);font-style:italic}
.offer-act{grid-column:1 / -1;justify-self:start;font-size:.78rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink);min-height:44px;display:inline-flex;align-items:center}

.avs{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.av{background:rgba(255,255,255,.55);border:1px solid var(--line)}
.av-link{display:flex;justify-content:space-between;align-items:center;gap:20px;
  padding:16px 20px;text-decoration:none;color:inherit;cursor:pointer}
.av:hover{border-color:var(--bronze)}
.av-off{background:transparent;opacity:.78}
.av-on{outline:2px solid var(--sage);outline-offset:-2px}
.av-label{font-family:var(--heading);font-size:1.15rem}
.av-ok{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--sage)}
.av-blocked{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:#9A5B3C}
.av-unknown{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--bronze)}
.av-act{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);
  min-height:44px;display:inline-flex;align-items:center}

.review{margin-top:${profile.sectionMargin};border:1px solid var(--line);
  border-radius:var(--radius);padding:32px;background:#fff}
.result{border-color:var(--sage)}
.posture{font-family:var(--heading);font-size:1.6rem;margin:0 0 12px}
.posture-reason{margin:0 0 22px;color:#4A443D}
.rev{margin:0 0 26px;padding:0}
.rev-row{display:flex;justify-content:space-between;gap:20px;padding:12px 0;border-bottom:1px solid var(--line)}
.rev-row dt{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--sage);margin:0}
.rev-row dd{margin:0;font-family:var(--heading);font-size:1.05rem;text-align:right}
.actions{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.action-reason{flex:1 1 260px;font-size:.85rem;color:#9A5B3C;font-style:italic;margin:0}

.src{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 28px;
  padding:12px 16px;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;border-radius:var(--radius)}
.src-fixture{background:#F3E6D2;color:#7A4E17;border:1px solid #DFC79C}
.src-live{background:#E4EDE5;color:#2F5133;border:1px solid #BBD2BE}
.src-dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.src-link{color:inherit}
.state{font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--sage);margin:0 0 8px}

@media (max-width:833px){
  .wrap{padding:32px 20px 96px}
  h1{font-size:2.35rem}
  .svcs{grid-template-columns:1fr;gap:16px}
  .svc{padding:22px}
  .offer{grid-template-columns:auto 1fr;row-gap:6px}
  .offer-price{grid-column:2;justify-self:start}
  .av{flex-wrap:wrap;gap:8px}
  .rev-row{flex-direction:column;gap:4px}
  .rev-row dd{text-align:left}
}
@media (max-width:400px){
  .wrap{padding:24px 16px 88px}
  h1{font-size:1.95rem}
  .tagline{font-size:1.1rem}
  .btn{width:100%}
}
</style>
</head>
<body>
<div class="wrap">
${sourceBanner(envelope, inspectorPath, t)}
${languageSwitch(options, selection, t)}
${stepStrip(journey, t)}

<header class="masthead">
  <p class="state">${escapeHtml(stateLabel(envelope, t))}</p>
  <h1>${escapeHtml(d.brand.publicName)}</h1>
  <p class="tagline">${escapeHtml(d.brand.tagline)}</p>
  <p class="locale">${escapeHtml(d.brand.marketDescriptor)} · ${escapeHtml(d.market.operatingHours.open)}–${escapeHtml(d.market.operatingHours.close)}</p>
</header>

<h2>${escapeHtml(t("section_services"))}</h2>
<div class="svcs">
${d.services.map((service) => serviceCard(service, options, journey, t)).join("\n")}
</div>

${
    d.offers.length === 0
        ? ""
        : `<h2 id="offers">${escapeHtml(t("section_offers"))}</h2><ul class="offers">
${d.offers.map((offer) => offerRow(offer, options, journey, t)).join("\n")}
</ul>`
}

${
    d.availability.length === 0
        ? ""
        : `<h2 id="when">${escapeHtml(t("section_when"))}</h2><ul class="avs">
${d.availability.map((window, index) => availabilityRow(window, index, options, journey, t)).join("\n")}
</ul>`
}

${reviewSection(options, journey, envelope, t)}
</div>
</body>
</html>`;
}
