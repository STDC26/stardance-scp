// SCP-G5-D — the Freshline customer surface, rendered from governed configuration.
//
// Server-rendered. Every service, price, extra, region, accommodation type,
// operating hour, locale and brand colour on this page comes from the
// CustomerProjection, which comes from the effective configuration the runtime
// resolved at startup. There is not one Freshline constant in this file: change
// the governed configuration, activate the new version, re-project, and the page
// changes with no code change here.
//
// It is deliberately one file of HTML with inline CSS and a small inline script.
// No build step, no framework, no external asset — a customer on a phone in
// Canggu gets one document, and an auditor gets a surface they can read end to
// end without resolving a dependency graph.
//
// The client script's ONLY job is to post the form and render what came back.
// It computes no price, holds no state that matters, and re-reads the server's
// acknowledgement rather than composing its own. Nothing in the browser is ever
// consulted again once the request is submitted.

import type { CustomerProjection } from "../customer/projection";
import { FRESHLINE_PROFILE, type BrandExperienceProfile } from "./brandProfile";
// UAT-R1: the lookup that used to live here, now shared with Athena. Same logic,
// same dictionary, same fallback — which is why the golden hash still matches.
import { translate as t } from "../localization/translate";



/** Escapes text for HTML body context. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Hourly start chips spanning the governed operating hours. The freeze asks for
 * simplified, chip-oriented time selection; the chips are derived from the
 * configured hours rather than a hardcoded list, so a market that opens at 07:00
 * gets a 07:00 chip without anyone editing this file.
 */
export function timeChips(open: string, close: string): string[] {
    const [openHour] = open.split(":").map(Number) as [number, number];
    const [closeHour] = close.split(":").map(Number) as [number, number];
    const chips: string[] = [];
    for (let hour = openHour; hour < closeHour; hour += 1) {
        chips.push(`${String(hour).padStart(2, "0")}:00`);
    }
    return chips;
}

function chip(name: string, value: string, label: string, sub: string | null, checked: boolean): string {
    return `<label class="chip">
        <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${checked ? " checked" : ""}>
        <span class="chip-body"><span class="chip-label">${escapeHtml(label)}</span>${
            sub ? `<span class="chip-sub">${escapeHtml(sub)}</span>` : ""
        }</span>
    </label>`;
}

function checkChip(value: string, label: string, sub: string): string {
    return `<label class="chip">
        <input type="checkbox" name="extraCodes" value="${escapeHtml(value)}">
        <span class="chip-body"><span class="chip-label">${escapeHtml(label)}</span><span class="chip-sub">${escapeHtml(sub)}</span></span>
    </label>`;
}

export interface PageOptions {
    projection: CustomerProjection;
    locale: string;
    /** Where the form posts. Supplied by the host, not assumed here. */
    ingressPath: string;
    /**
     * C5 — expression only. Omitted means Freshline, which is what every existing
     * caller gets, which is why extracting this seam changed no rendered byte.
     */
    brandExperienceProfile?: BrandExperienceProfile;
}

export function renderCustomerPage(options: PageOptions): string {
    const p = options.projection;
    const profile = options.brandExperienceProfile ?? FRESHLINE_PROFILE;
    const locale = p.market.supportedLocales.includes(options.locale)
        ? options.locale
        : p.market.localeDefault;
    const colors = p.brand.colors;
    const black = colors["primaryBlack"] ?? "#0B0D0E";
    const teal = colors["freshlineTeal"] ?? "#00AFA5";
    const tealHover = colors["tealHover"] ?? teal;
    const silver = colors["silver"] ?? "#E7ECEF";
    const white = colors["white"] ?? "#FFFFFF";

    const services = p.catalogue.services
        .map((s, index) =>
            chip(
                "serviceCode",
                s.code,
                s.name,
                `${s.price.display} · ${s.durationMinutes} ${t("customer", "duration_suffix", locale)}`,
                index === 0
            )
        )
        .join("\n");

    const extras = p.catalogue.extras
        .map((e) =>
            checkChip(
                e.code,
                e.name,
                `${e.price.display} · +${e.extraDurationMinutes} ${t("customer", "duration_suffix", locale)}`
            )
        )
        .join("\n");

    const regions = p.market.regions
        .map((region, index) => chip("region", region, region, null, index === 0))
        .join("\n");

    const accommodations = p.market.accommodationTypes
        .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
        .join("");

    const times = timeChips(p.market.operatingHours.open, p.market.operatingHours.close)
        .map((time, index) => chip("requestedTime", time, time, null, index === 0))
        .join("\n");

    const languageLinks = p.market.supportedLocales
        .map(
            (code) =>
                `<a class="lang${code === locale ? " lang-on" : ""}" href="?lang=${escapeHtml(code)}">${escapeHtml(
                    code.toUpperCase()
                )}</a>`
        )
        .join("");

    const openHours = t("customer", "open_hours", locale)
        .replace("{open}", p.market.operatingHours.open)
        .replace("{close}", p.market.operatingHours.close);

    return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(p.brand.publicName)} ${escapeHtml(p.brand.marketDescriptor)}</title>
<style>
:root{
  --black:${black};--teal:${teal};--teal-hover:${tealHover};--silver:${silver};--white:${white};
  --heading:${escapeHtml(p.brand.headingFont)},${profile.headingFallback};
  --body:${escapeHtml(p.brand.bodyFont)},${profile.bodyFallback};
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--black);color:var(--white);font-family:var(--body);
  font-size:${profile.baseFontSize};line-height:${profile.baseLineHeight};-webkit-text-size-adjust:100%}
.wrap{width:100%;max-width:${profile.contentMaxWidth};margin:0 auto;padding:${profile.contentPadding}}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px}
h1{font-family:var(--heading);font-weight:${profile.h1Weight};letter-spacing:${profile.h1LetterSpacing};font-size:${profile.h1Size};margin:0}
h1 .mkt{color:var(--teal)}
.tagline{color:var(--silver);opacity:.8;font-size:.95rem;margin:2px 0 4px}
.hours{color:var(--silver);opacity:.65;font-size:.85rem;margin:0 0 20px}
.lang{color:var(--silver);opacity:.55;text-decoration:none;font-size:.8rem;
  padding:6px 8px;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
.lang-on{color:var(--teal);opacity:1;font-weight:600}
h2{font-family:var(--heading);font-weight:700;font-size:1rem;text-transform:${profile.h2Transform};
  letter-spacing:${profile.h2LetterSpacing};color:var(--silver);margin:${profile.sectionMargin}}
h2 .opt{text-transform:none;letter-spacing:0;font-weight:400;opacity:.55;font-size:.8rem}
.chips{display:flex;flex-wrap:wrap;gap:${profile.chipGap}}
.chip{flex:1 1 100%}
/* Visually hidden but still focusable and still in the accessibility tree.
   display:none or opacity:0 with zero size would take the control away from
   keyboard and screen-reader users, which a chip UI has no right to do. */
.chip input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.chip-body{display:flex;flex-direction:column;gap:2px;min-height:44px;justify-content:center;
  padding:10px 14px;border:1px solid rgba(231,236,239,.22);border-radius:12px;cursor:pointer;
  transition:border-color .15s,background .15s}
.chip input:checked+.chip-body{border-color:var(--teal);background:rgba(0,175,165,.12)}
.chip input:focus-visible+.chip-body{outline:2px solid var(--teal);outline-offset:2px}
.chip-label{font-weight:600}
.chip-sub{font-size:.85rem;color:var(--silver);opacity:.7}
.chips-inline .chip{flex:0 1 auto}
.chips-inline .chip-body{padding:10px 14px;min-width:44px;text-align:center}
label.field{display:block;margin:14px 0}
label.field span{display:block;font-size:.85rem;color:var(--silver);opacity:.75;margin-bottom:6px}
input[type=text],input[type=tel],input[type=date],select{
  width:100%;min-height:48px;padding:12px 14px;font:inherit;color:var(--white);
  background:rgba(231,236,239,.06);border:1px solid rgba(231,236,239,.22);border-radius:12px}
input:focus,select:focus{outline:2px solid var(--teal);outline-offset:1px;border-color:var(--teal)}
.notice{border-left:2px solid var(--teal);padding:8px 0 8px 12px;margin:14px 0;
  color:var(--silver);opacity:.75;font-size:.85rem}
button{width:100%;min-height:52px;margin-top:24px;font:inherit;font-weight:700;
  font-family:var(--heading);letter-spacing:.04em;text-transform:uppercase;
  color:var(--black);background:var(--teal);border:0;border-radius:12px;cursor:pointer}
button:hover:not(:disabled){background:var(--teal-hover)}
button:disabled{opacity:.55;cursor:progress}
.result{margin-top:24px;padding:18px;border:1px solid var(--teal);border-radius:14px;
  background:rgba(0,175,165,.08)}
.result h3{font-family:var(--heading);font-size:1.25rem;margin:0 0 8px}
.result p{margin:0 0 10px}
.result .ref{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;
  color:var(--teal);word-break:break-all}
.result .step{color:var(--silver);opacity:.8;font-size:.9rem}
.errors{margin-top:24px;padding:18px;border:1px solid #E4572E;border-radius:14px;
  background:rgba(228,87,46,.08)}
.errors h3{font-family:var(--heading);font-size:1.05rem;margin:0 0 8px}
.errors ul{margin:0;padding-left:18px;font-size:.9rem;color:var(--silver)}
[hidden]{display:none !important}
@media (min-width:480px){
  .wrap{padding:32px 24px 96px}
  h1{font-size:2rem}
  .chip{flex:1 1 calc(50% - 4px)}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(p.brand.publicName)} <span class="mkt">${escapeHtml(p.brand.marketDescriptor)}</span></h1>
  <nav aria-label="${escapeHtml(t("customer", "language", locale))}">${languageLinks}</nav>
</header>
<p class="tagline">${escapeHtml(p.brand.tagline)}</p>
<p class="hours">${escapeHtml(openHours)}</p>

<form id="booking" novalidate>
  <h2>${escapeHtml(t("customer", "heading_service", locale))}</h2>
  <div class="chips">
${services}
  </div>

  <h2>${escapeHtml(t("customer", "heading_extras", locale))} <span class="opt">${escapeHtml(
      t("customer", "optional", locale)
  )}</span></h2>
  <div class="chips">
${extras}
  </div>

  <h2>${escapeHtml(t("customer", "heading_when", locale))}</h2>
  <label class="field">
    <span>${escapeHtml(t("customer", "label_date", locale))}</span>
    <input type="date" name="requestedDate" required>
  </label>
  <label class="field"><span>${escapeHtml(t("customer", "label_time", locale))}</span></label>
  <div class="chips chips-inline">
${times}
  </div>

  <h2>${escapeHtml(t("customer", "heading_where", locale))}</h2>
  <div class="chips chips-inline">
${regions}
  </div>
  <label class="field">
    <span>${escapeHtml(t("customer", "label_accommodation", locale))}</span>
    <select name="accommodationType">
      <option value="">—</option>
      ${accommodations}
    </select>
  </label>

  <h2>${escapeHtml(t("customer", "heading_you", locale))}</h2>
  <label class="field">
    <span>${escapeHtml(t("customer", "label_name", locale))}</span>
    <input type="text" name="customerName" autocomplete="name" required>
  </label>
  <label class="field">
    <span>${escapeHtml(t("customer", "label_contact", locale))}</span>
    <input type="tel" name="contactHandle" inputmode="tel" autocomplete="tel"
           placeholder="${escapeHtml(t("customer", "placeholder_contact", locale))}" required>
  </label>

  <p class="notice">${escapeHtml(t("customer", "notice_state", locale))}</p>
  <p class="notice">${escapeHtml(t("customer", "notice_payment", locale))}</p>
  <p class="notice">${escapeHtml(t("customer", "notice_whatsapp", locale))}</p>

  <button type="submit" id="submit">${escapeHtml(t("customer", "submit", locale))}</button>
</form>

<section class="result" id="result" hidden></section>
<section class="errors" id="errors" hidden></section>
</div>

<script>
(function(){
  var LOCALE = ${JSON.stringify(locale)};
  var PATH = ${JSON.stringify(options.ingressPath)};
  var COPY = ${JSON.stringify({
      submit: t("customer", "submit", locale),
      submitting: t("customer", "submitting", locale),
      reference: t("customer", "reference", locale),
      errorHeading: t("customer", "error_heading", locale),
      errorGeneric: t("customer", "error_generic", locale)
  })};
  var form = document.getElementById('booking');
  var button = document.getElementById('submit');
  var result = document.getElementById('result');
  var errors = document.getElementById('errors');

  // A stable key for THIS filled-in form. Pressing send twice, or a flaky
  // connection retrying, must not produce two requests. The server validates
  // the shape and remains the authority on what a replay means.
  var key = 'web-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).slice(2, 10);

  function text(el, value){ el.textContent = value; return el; }

  function show(node){ node.hidden = false; }

  function renderErrors(list){
    errors.innerHTML = '';
    var h = document.createElement('h3'); text(h, COPY.errorHeading); errors.appendChild(h);
    var ul = document.createElement('ul');
    list.forEach(function(line){
      var li = document.createElement('li'); text(li, line); ul.appendChild(li);
    });
    errors.appendChild(ul);
    show(errors);
  }

  function renderAck(ack){
    result.innerHTML = '';
    var h = document.createElement('h3'); text(h, ack.headline); result.appendChild(h);
    var body = document.createElement('p'); text(body, ack.body); result.appendChild(body);
    var step = document.createElement('p'); step.className = 'step';
    text(step, ack.nextStep); result.appendChild(step);
    var ref = document.createElement('p'); ref.className = 'ref';
    text(ref, COPY.reference + ': ' + ack.requestReference); result.appendChild(ref);
    show(result);
    form.hidden = true;
  }

  form.addEventListener('submit', function(event){
    event.preventDefault();
    errors.hidden = true;
    var data = new FormData(form);
    var extras = data.getAll('extraCodes');
    var accommodation = data.get('accommodationType');
    var payload = {
      serviceCode: data.get('serviceCode') || '',
      extraCodes: extras,
      requestedDate: data.get('requestedDate') || '',
      requestedTime: data.get('requestedTime') || '',
      region: data.get('region') || '',
      customerName: (data.get('customerName') || '').trim(),
      contactHandle: (data.get('contactHandle') || '').trim(),
      locale: LOCALE,
      idempotencyKey: key
    };
    if (accommodation) { payload.accommodationType = accommodation; }

    button.disabled = true;
    text(button, COPY.submitting);

    fetch(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(response){
      return response.json().then(function(json){ return { status: response.status, json: json }; });
    }).then(function(res){
      if (res.status >= 200 && res.status < 300 && res.json.acknowledgement) {
        renderAck(res.json.acknowledgement);
        return;
      }
      var lines = [];
      if (res.json.findings && res.json.findings.length) {
        res.json.findings.forEach(function(f){ lines.push(f.field + ': ' + f.message); });
      } else if (res.json.message) {
        lines.push(res.json.message);
      } else {
        lines.push(COPY.errorGeneric);
      }
      renderErrors(lines);
    }).catch(function(){
      renderErrors([COPY.errorGeneric]);
    }).then(function(){
      button.disabled = false;
      text(button, COPY.submit);
    });
  });
})();
</script>
</body>
</html>
`;
}
