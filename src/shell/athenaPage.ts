// C5 — the Athena demand surface.
//
// This renderer's input is a `ProjectionEnvelope<DemandPayload>` — the same
// contract the Freshline LIVE provider produces. That is the 1:MANY proof: two
// materially different surfaces, one Shell-facing contract, and no tenant branch
// anywhere in Core. Everything that differs between Athena and Freshline is on
// one of three lines: the Brand Experience Profile, the projection payload, or
// the composition below.
//
// It also renders semantics rather than optimism, which is where most demo UIs
// quietly lie:
//
//   RECOMMENDATION ≠ OFFER      a recommendation is labelled and priced as a
//                               suggestion, never as an authorised price.
//   AVAILABLE ≠ ELIGIBLE        a window with `eligible: false` is shown as
//                               present-but-unavailable-to-you, not hidden and
//                               not silently bookable.
//   ELIGIBILITY ≠ COMMITMENT    the commit control's enabled state comes from
//                               `authority.canCommit`, and when it is off the
//                               reason is printed rather than the button removed.
//
// And it says out loud, on the page, when it is looking at fixture data. An
// Experience Lab surface that cannot be told apart from production truth is worse
// than no surface at all.

import { escapeHtml } from "../host/page";
import type { BrandExperienceProfile } from "../host/brandProfile";
import type { DemandPayload, ProjectionEnvelope } from "./contract";

export interface AthenaPageOptions {
    envelope: ProjectionEnvelope<DemandPayload>;
    profile: BrandExperienceProfile;
    /** Where the provenance inspector lives, linked from the source banner. */
    inspectorPath: string;
}

function money(display: string): string {
    return escapeHtml(display);
}

/**
 * The source banner. Deliberately not subtle and deliberately not dismissible:
 * FIXTURE ≠ LIVE has to survive someone screenshotting the page.
 */
function sourceBanner(envelope: ProjectionEnvelope<DemandPayload>, inspectorPath: string): string {
    const p = envelope.provenance;
    const isFixture = p.sourceType === "FIXTURE";
    const version = p.fixtureVersion ?? p.sourceVersion ?? "unversioned";
    return `<aside class="src ${isFixture ? "src-fixture" : "src-live"}">
      <span class="src-dot"></span>
      <span><strong>${escapeHtml(p.sourceType)}</strong> · ${escapeHtml(p.provider)} · ${escapeHtml(version)}</span>
      <a class="src-link" href="${escapeHtml(inspectorPath)}">inspect projection</a>
    </aside>`;
}

function serviceCard(service: DemandPayload["services"][number]): string {
    return `<article class="svc${service.featured === true ? " svc-featured" : ""}">
      <div class="svc-head">
        <h3>${escapeHtml(service.name)}</h3>
        <p class="svc-price">${money(service.price.display)}</p>
      </div>
      ${service.description === undefined ? "" : `<p class="svc-copy">${escapeHtml(service.description)}</p>`}
      <p class="svc-meta">${service.durationMinutes} minutes · ${escapeHtml(service.code)}</p>
    </article>`;
}

function offerRow(offer: DemandPayload["offers"][number]): string {
    const isRecommendation = offer.kind === "RECOMMENDATION";
    return `<li class="offer ${isRecommendation ? "offer-rec" : "offer-authorised"}">
      <span class="offer-kind">${isRecommendation ? "Suggestion" : "Offer"}</span>
      <span class="offer-label">${escapeHtml(offer.label)}</span>
      <span class="offer-price">${money(offer.price.display)}</span>
      ${offer.description === undefined ? "" : `<span class="offer-copy">${escapeHtml(offer.description)}</span>`}
      ${
          isRecommendation
              ? `<span class="offer-caveat">A recommendation, not an authorised price for you.</span>`
              : ""
      }
    </li>`;
}

function availabilityRow(window: DemandPayload["availability"][number]): string {
    // Three distinct renderings for three distinct facts, including "we do not
    // model eligibility", which is not the same as "not eligible".
    const status =
        window.eligible === undefined
            ? `<span class="av-unknown">eligibility not determined</span>`
            : window.eligible
              ? `<span class="av-ok">available to you</span>`
              : `<span class="av-blocked">available, not eligible for you</span>`;

    return `<li class="av${window.eligible === false ? " av-off" : ""}">
      <span class="av-label">${escapeHtml(window.label)}</span>
      ${status}
    </li>`;
}

export function renderAthenaPage(options: AthenaPageOptions): string {
    const { envelope, profile, inspectorPath } = options;
    const d = envelope.payload;
    const c = d.committable;

    const ink = d.brand.colors["ink"] ?? "#1A1714";
    const parchment = d.brand.colors["parchment"] ?? "#F7F3EC";
    const bronze = d.brand.colors["bronze"] ?? "#8C6A43";
    const sage = d.brand.colors["sage"] ?? "#5A6B5D";
    const line = d.brand.colors["line"] ?? "#DED5C7";

    const commit = envelope.actions.find((action) => action.kind === "COMMIT");
    const request = envelope.actions.find((action) => action.kind === "REQUEST");

    return `<!doctype html>
<html lang="en">
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
body{background:var(--parchment);color:var(--ink);font-family:var(--body);
  font-size:${profile.baseFontSize};line-height:${profile.baseLineHeight};-webkit-text-size-adjust:100%}
.wrap{width:100%;max-width:${profile.contentMaxWidth};margin:0 auto;padding:${profile.contentPadding}}

/* Editorial masthead — a wide measure and a large serif display face, where
   Freshline uses a 560px column and condensed uppercase. */
.masthead{border-bottom:1px solid var(--line);padding-bottom:36px}
h1{font-family:var(--heading);font-weight:${profile.h1Weight};font-size:${profile.h1Size};
  letter-spacing:${profile.h1LetterSpacing};line-height:1.05;margin:0 0 18px}
.tagline{font-family:var(--heading);font-size:1.35rem;font-style:italic;color:var(--sage);margin:0 0 10px}
.locale{font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--bronze);margin:0}

h2{font-family:var(--body);font-size:.75rem;font-weight:600;
  text-transform:${profile.h2Transform};letter-spacing:${profile.h2LetterSpacing};
  color:var(--bronze);margin:${profile.sectionMargin}}

/* Merchandising as cards with generous gutters, not a dense chip list. */
.svcs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:${profile.chipGap}}
.svc{border:1px solid var(--line);border-radius:var(--radius);padding:28px;background:rgba(255,255,255,.55)}
.svc-featured{border-color:var(--bronze);background:#fff}
.svc-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.svc h3{font-family:var(--heading);font-weight:400;font-size:1.5rem;margin:0}
.svc-price{font-family:var(--heading);font-size:1.25rem;color:var(--bronze);margin:0;white-space:nowrap}
.svc-copy{margin:14px 0 0;color:#4A443D}
.svc-meta{margin:18px 0 0;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:var(--sage)}

.offers{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.offer{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:baseline;
  padding:18px 0;border-bottom:1px solid var(--line)}
.offer-kind{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.offer-authorised .offer-kind{background:var(--bronze);color:#fff}
.offer-rec .offer-kind{background:transparent;border:1px dashed var(--sage);color:var(--sage)}
.offer-label{font-family:var(--heading);font-size:1.2rem}
.offer-price{font-family:var(--heading);color:var(--bronze)}
.offer-copy,.offer-caveat{grid-column:1 / -1;font-size:.9rem;color:#4A443D;margin:0}
.offer-caveat{color:var(--sage);font-style:italic}

.avs{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.av{display:flex;justify-content:space-between;align-items:center;gap:20px;
  padding:18px 20px;background:rgba(255,255,255,.55);border:1px solid var(--line)}
.av-off{background:transparent;opacity:.72}
.av-label{font-family:var(--heading);font-size:1.15rem}
.av-ok{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--sage)}
.av-blocked{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:#9A5B3C}
.av-unknown{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--bronze)}

.review{margin-top:${profile.sectionMargin};border:1px solid var(--line);
  border-radius:var(--radius);padding:32px;background:#fff}
.posture{font-family:var(--heading);font-size:1.6rem;margin:0 0 12px}
.posture-reason{margin:0 0 22px;color:#4A443D}
.resolved{list-style:none;margin:0 0 26px;padding:0;display:flex;flex-wrap:wrap;gap:10px}
.resolved li{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;
  padding:6px 12px;border:1px solid var(--line);border-radius:999px}
.resolved .yes{border-color:var(--sage);color:var(--sage)}
.resolved .no{border-color:#C9BCA8;color:#8A7B66}
.actions{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
button{font-family:var(--body);font-size:.95rem;letter-spacing:.06em;text-transform:uppercase;
  min-height:52px;padding:0 30px;border-radius:var(--radius);cursor:pointer;border:1px solid var(--ink)}
button.primary{background:var(--ink);color:var(--parchment)}
button[disabled]{cursor:not-allowed;opacity:.4}
.action-reason{flex:1 1 260px;font-size:.85rem;color:var(--sage);font-style:italic;margin:0}

.src{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 34px;
  padding:12px 16px;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;border-radius:var(--radius)}
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
  .av{flex-direction:column;align-items:flex-start;gap:6px}
}
@media (max-width:400px){
  .wrap{padding:24px 16px 88px}
  h1{font-size:1.95rem}
  .tagline{font-size:1.1rem}
  button{width:100%}
}
</style>
</head>
<body>
<div class="wrap">
${sourceBanner(envelope, inspectorPath)}

<header class="masthead">
  <p class="state">${escapeHtml(envelope.state.label)}</p>
  <h1>${escapeHtml(d.brand.publicName)}</h1>
  <p class="tagline">${escapeHtml(d.brand.tagline)}</p>
  <p class="locale">${escapeHtml(d.brand.marketDescriptor)} · ${escapeHtml(d.market.operatingHours.open)}–${escapeHtml(d.market.operatingHours.close)}</p>
</header>

<h2>The treatments</h2>
<div class="svcs">
${d.services.map(serviceCard).join("\n")}
</div>

${
    d.offers.length === 0
        ? `<h2>Offers</h2><p class="svc-copy">No offers are published for this surface.</p>`
        : `<h2>Offers &amp; suggestions</h2><ul class="offers">
${d.offers.map(offerRow).join("\n")}
</ul>`
}

${
    d.availability.length === 0
        ? `<h2>Availability</h2><p class="svc-copy">Availability is not published by this source. Nothing here should be read as a bookable time.</p>`
        : `<h2>When</h2><ul class="avs">
${d.availability.map(availabilityRow).join("\n")}
</ul>`
}

<section class="review">
  <h2>Review</h2>
  <p class="posture">${escapeHtml(c.posture.replace(/_/g, " ").toLowerCase())}</p>
  <p class="posture-reason">${escapeHtml(c.reason)}</p>
  <ul class="resolved">
    <li class="${c.resolved.service ? "yes" : "no"}">service ${c.resolved.service ? "resolved" : "unresolved"}</li>
    <li class="${c.resolved.price ? "yes" : "no"}">price ${c.resolved.price ? "resolved" : "unresolved"}</li>
    <li class="${c.resolved.eligibility ? "yes" : "no"}">eligibility ${c.resolved.eligibility ? "resolved" : "unresolved"}</li>
    <li class="${c.resolved.capacity ? "yes" : "no"}">capacity ${c.resolved.capacity ? "resolved" : "unresolved"}</li>
  </ul>
  <div class="actions">
    <button type="button" ${request?.enabled === true ? "" : "disabled"}>${escapeHtml(request?.label ?? "Request")}</button>
    <button type="button" class="primary" ${commit?.enabled === true ? "" : "disabled"}>${escapeHtml(commit?.label ?? "Reserve")}</button>
    ${
        commit?.enabled === true || commit?.reason === undefined
            ? ""
            : `<p class="action-reason">${escapeHtml(commit.reason)}</p>`
    }
  </div>
</section>
</div>
</body>
</html>`;
}
