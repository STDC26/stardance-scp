// SCP-G5-E — the Freshline Partner portal, rendered from governed configuration.
//
// Server-rendered, like the customer surface. Every role code, service, region,
// operating hour, locale and brand colour comes from the effective
// configuration the runtime resolved. There is not one Freshline constant in
// this file.
//
// Two things the page is careful NOT to do:
//
//   * It never displays a Partner ID it made up. The field renders whatever the
//     server returned, and until Owner approval that is nothing.
//   * It never implies approval. Saving a profile, submitting a card and sending
//     a week each say plainly what they did and did not do, because the
//     temptation to render "You're live!" is exactly what the gate is about.
//
// Apply-to-all is a button that copies Monday into the other six inputs before
// submission. The wire always carries seven explicit days, so there is one
// canonical schedule representation and the convenience cannot become a second
// truth model.

import strings from "../localization/strings.json";
import { loadMarketConfig, type MarketId } from "../config/marketConfig";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { escapeHtml } from "./page";

type LocalizedEntry = Record<string, string>;

function t(section: string, key: string, locale: string): string {
    const table = (strings as unknown as Record<string, Record<string, LocalizedEntry>>)[section];
    const entry = table?.[key];
    return entry?.[locale] ?? entry?.["en"] ?? "";
}

export interface PartnerRoleOption {
    code: string;
    label: string;
}

export interface PartnerServiceOption {
    code: string;
    name: string;
    durationMinutes: number;
}

export interface PartnerProjection {
    /** Always false. This view is a projection, never a source of truth. */
    authoritative: false;
    brand: {
        publicName: string;
        marketDescriptor: string;
        tagline: string;
        colors: Record<string, string>;
        headingFont: string;
        bodyFont: string;
        /** Freshline's experience word for a Provider. It grants no aggregate. */
        experienceTerm: string;
    };
    market: {
        marketId: string;
        timezone: string;
        localeDefault: string;
        supportedLocales: string[];
        operatingHours: { open: string; close: string };
        regions: string[];
    };
    roles: PartnerRoleOption[];
    services: PartnerServiceOption[];
    /** Both false in G5-E. Rendered so the surface cannot imply otherwise. */
    commerce: {
        ratingCommissionState: string;
        ratingCommissionActive: boolean;
        paymentActive: boolean;
        dynamicPricingActive: boolean;
    };
    provenance: {
        configurationVersion: number;
        configurationChecksum: string;
        canonicalMarketId: string;
        tenantId: string;
        environment: string;
    };
}

export function buildPartnerProjection(configuration: EffectiveConfiguration): PartnerProjection {
    // Loaded for the market's own presentation values; the resolver already
    // established that this is the canonical market for this tenant.
    loadMarketConfig(configuration.provenance.canonicalMarketId as MarketId);
    const experience = configuration.experience.providerExperience;

    return {
        authoritative: false,
        brand: {
            publicName: configuration.brand.publicName,
            marketDescriptor: configuration.brand.marketDescriptor,
            tagline: configuration.brand.tagline,
            colors: { ...configuration.brand.design.colors },
            headingFont: configuration.brand.design.headingFont,
            bodyFont: configuration.brand.design.bodyFont,
            experienceTerm: experience.tenantExperienceTerm
        },
        market: {
            marketId: configuration.identity.marketId,
            timezone: configuration.timezone.value,
            localeDefault: configuration.locales.default,
            supportedLocales: [...configuration.locales.supported],
            operatingHours: configuration.operatingHours.value,
            regions: [...configuration.coverage.regions]
        },
        roles: Object.entries(experience.displayIdPrefixes)
            .map(([code, label]) => ({ code, label }))
            .sort((a, b) => a.code.localeCompare(b.code)),
        services: configuration.catalogue.services
            .filter((s) => s.active)
            .map((s) => ({ code: s.code, name: s.name, durationMinutes: s.durationMinutes })),
        commerce: {
            // G5A-G10: reported from configuration exactly as it stands.
            // UNRESOLVED / inactive is a fact about the business, not a default.
            ratingCommissionState: experience.ratingCommission.state,
            ratingCommissionActive: experience.ratingCommission.active,
            paymentActive: configuration.commerce.payment.active,
            dynamicPricingActive: configuration.commerce.locationDynamicPricing.active
        },
        provenance: {
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            canonicalMarketId: configuration.provenance.canonicalMarketId,
            tenantId: configuration.identity.tenantId,
            environment: configuration.identity.environment
        }
    };
}

export interface PartnerPageOptions {
    projection: PartnerProjection;
    locale: string;
}

function checkChip(name: string, value: string, label: string, sub: string | null): string {
    return `<label class="chip">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}">
        <span class="chip-body"><span class="chip-label">${escapeHtml(label)}</span>${
            sub ? `<span class="chip-sub">${escapeHtml(sub)}</span>` : ""
        }</span>
    </label>`;
}

export function renderPartnerPage(options: PartnerPageOptions): string {
    const p = options.projection;
    const locale = p.market.supportedLocales.includes(options.locale)
        ? options.locale
        : p.market.localeDefault;
    const colors = p.brand.colors;
    const black = colors["primaryBlack"] ?? "#0B0D0E";
    const teal = colors["freshlineTeal"] ?? "#00AFA5";
    const tealHover = colors["tealHover"] ?? teal;
    const silver = colors["silver"] ?? "#E7ECEF";
    const white = colors["white"] ?? "#FFFFFF";

    const roleOptions = p.roles
        .map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`)
        .join("");

    const serviceChips = p.services
        .map((s) => checkChip("serviceCodes", s.code, s.name, `${s.durationMinutes} min`))
        .join("\n");

    const languageLinks = p.market.supportedLocales
        .map(
            (code) =>
                `<a class="lang${code === locale ? " lang-on" : ""}" href="?lang=${escapeHtml(code)}">${escapeHtml(
                    code.toUpperCase()
                )}</a>`
        )
        .join("");

    const regionChecks = (day: number): string =>
        p.market.regions
            .map(
                (region) =>
                    `<label class="mini"><input type="checkbox" data-day="${day}" name="regions-${day}" value="${escapeHtml(
                        region
                    )}"><span>${escapeHtml(region)}</span></label>`
            )
            .join("");

    const days = [1, 2, 3, 4, 5, 6, 7]
        .map(
            (day) => `<fieldset class="day" data-day="${day}">
    <legend>${escapeHtml(t("partner", `day_${day}`, locale))}</legend>
    <label class="toggle">
      <input type="checkbox" name="available-${day}" data-day="${day}"${day <= 5 ? " checked" : ""}>
      <span>${escapeHtml(t("partner", "label_available", locale))}</span>
    </label>
    <div class="times">
      <label><span>${escapeHtml(t("partner", "label_from", locale))}</span>
        <input type="time" name="start-${day}" data-day="${day}" value="${escapeHtml(
            p.market.operatingHours.open
        )}"></label>
      <label><span>${escapeHtml(t("partner", "label_to", locale))}</span>
        <input type="time" name="end-${day}" data-day="${day}" value="${escapeHtml(
            p.market.operatingHours.close
        )}"></label>
    </div>
    <p class="areas-label">${escapeHtml(t("partner", "label_areas", locale))}</p>
    <div class="regions">${regionChecks(day)}</div>
  </fieldset>`
        )
        .join("\n");

    return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(p.brand.publicName)} ${escapeHtml(t("partner", "portal_title", locale))}</title>
<style>
:root{
  --black:${black};--teal:${teal};--teal-hover:${tealHover};--silver:${silver};--white:${white};
  --heading:${escapeHtml(p.brand.headingFont)},"Oswald",system-ui,sans-serif;
  --body:${escapeHtml(p.brand.bodyFont)},"DM Sans",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--black);color:var(--white);font-family:var(--body);font-size:16px;line-height:1.5}
.wrap{width:100%;max-width:640px;margin:0 auto;padding:20px 16px 96px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
h1{font-family:var(--heading);font-weight:700;font-size:1.5rem;margin:0}
h1 .mkt{color:var(--teal)}
.sub{color:var(--silver);opacity:.75;font-size:.9rem;margin:2px 0 18px}
.lang{color:var(--silver);opacity:.55;text-decoration:none;font-size:.8rem;
  min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}
.lang-on{color:var(--teal);opacity:1;font-weight:600}
h2{font-family:var(--heading);font-weight:700;font-size:1rem;text-transform:uppercase;
  letter-spacing:.08em;color:var(--silver);margin:28px 0 10px}
label.field{display:block;margin:14px 0}
label.field>span{display:block;font-size:.85rem;color:var(--silver);opacity:.75;margin-bottom:6px}
input[type=text],input[type=tel],input[type=date],input[type=time],select,textarea{
  width:100%;min-width:0;min-height:48px;padding:12px 14px;font:inherit;color:var(--white);
  background:rgba(231,236,239,.06);border:1px solid rgba(231,236,239,.22);border-radius:12px}
textarea{min-height:96px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--teal);outline-offset:1px;border-color:var(--teal)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{flex:1 1 100%}
.chip input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.chip-body{display:flex;flex-direction:column;gap:2px;min-height:44px;justify-content:center;
  padding:10px 14px;border:1px solid rgba(231,236,239,.22);border-radius:12px;cursor:pointer}
.chip input:checked+.chip-body{border-color:var(--teal);background:rgba(0,175,165,.12)}
.chip input:focus-visible+.chip-body{outline:2px solid var(--teal);outline-offset:2px}
.chip-label{font-weight:600}
.chip-sub{font-size:.85rem;color:var(--silver);opacity:.7}
.day{border:1px solid rgba(231,236,239,.18);border-radius:12px;margin:10px 0;padding:12px;
  min-width:0}
.day legend{font-family:var(--heading);letter-spacing:.06em;text-transform:uppercase;font-size:.8rem;
  color:var(--silver);padding:0 6px}
.toggle{display:flex;align-items:center;gap:10px;min-height:44px}
.toggle input{width:22px;height:22px;accent-color:var(--teal)}
.times{display:flex;flex-wrap:wrap;gap:10px}
.times label{flex:1 1 130px;min-width:0}
.times span{display:block;font-size:.8rem;color:var(--silver);opacity:.7;margin-bottom:4px}
.areas-label{font-size:.8rem;color:var(--silver);opacity:.7;margin:10px 0 0}
.regions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.mini{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:4px 10px;
  border:1px solid rgba(231,236,239,.2);border-radius:999px;font-size:.85rem}
.mini input{accent-color:var(--teal)}
.notice{border-left:2px solid var(--teal);padding:8px 0 8px 12px;margin:12px 0;
  color:var(--silver);opacity:.78;font-size:.85rem}
button{width:100%;min-height:52px;margin-top:18px;font:inherit;font-weight:700;
  font-family:var(--heading);letter-spacing:.04em;text-transform:uppercase;
  color:var(--black);background:var(--teal);border:0;border-radius:12px;cursor:pointer}
button.secondary{background:transparent;color:var(--teal);border:1px solid var(--teal)}
button:hover:not(:disabled){background:var(--teal-hover)}
button.secondary:hover:not(:disabled){background:rgba(0,175,165,.12)}
button:disabled{opacity:.55;cursor:progress}
.card{margin-top:16px;padding:18px;border:1px solid var(--teal);border-radius:14px;
  background:rgba(0,175,165,.08)}
.card h3{font-family:var(--heading);font-size:1.2rem;margin:0 0 4px}
.card .pid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--teal);font-size:.9rem}
.card .stage{color:var(--silver);opacity:.85;font-size:.9rem;margin-top:8px}
.errors{margin-top:16px;padding:16px;border:1px solid #E4572E;border-radius:14px;
  background:rgba(228,87,46,.08)}
.errors h3{font-family:var(--heading);font-size:1rem;margin:0 0 8px}
.errors ul{margin:0;padding-left:18px;font-size:.9rem;color:var(--silver)}
[hidden]{display:none !important}
@media (min-width:520px){
  .wrap{padding:32px 24px 96px}
  h1{font-size:1.9rem}
  .chip{flex:1 1 calc(50% - 4px)}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(p.brand.publicName)} <span class="mkt">${escapeHtml(
      t("partner", "portal_title", locale)
  )}</span></h1>
  <nav aria-label="${escapeHtml(t("partner", "language", locale))}">${languageLinks}</nav>
</header>
<p class="sub">${escapeHtml(p.brand.marketDescriptor)} · ${escapeHtml(
        p.brand.experienceTerm
    )} · ${escapeHtml(p.market.operatingHours.open)}–${escapeHtml(p.market.operatingHours.close)}</p>

<section class="card" id="status">
  <h3 id="status-name">—</h3>
  <p class="pid" id="status-pid">${escapeHtml(t("partner", "notice_id_assigned", locale))}</p>
  <p class="stage" id="status-stage">${escapeHtml(
      t("partner", "stage_profile_not_submitted", locale)
  )}</p>
</section>

<form id="profile">
  <h2>${escapeHtml(t("partner", "heading_about", locale))}</h2>
  <label class="field"><span>${escapeHtml(t("partner", "label_legal_name", locale))}</span>
    <input type="text" name="legalName" autocomplete="name" required></label>
  <label class="field"><span>${escapeHtml(t("partner", "label_display_name", locale))}</span>
    <input type="text" name="displayName" required></label>
  <label class="field"><span>${escapeHtml(t("partner", "label_contact", locale))}</span>
    <input type="tel" name="contactHandle" inputmode="tel" autocomplete="tel"
           placeholder="+62 812 3456 7890" required></label>
  <label class="field"><span>${escapeHtml(t("partner", "label_role", locale))}</span>
    <select name="roleCode" required>${roleOptions}</select></label>

  <h2>${escapeHtml(t("partner", "label_services", locale))}</h2>
  <div class="chips">
${serviceChips}
  </div>

  <h2>${escapeHtml(t("partner", "heading_work", locale))}</h2>
  <label class="field"><span>${escapeHtml(t("partner", "label_how_you_work", locale))}</span>
    <textarea name="howYouWork" maxlength="2000"></textarea></label>
  <label class="field"><span>${escapeHtml(t("partner", "label_about_me", locale))}</span>
    <textarea name="aboutMe" maxlength="2000"></textarea></label>
  <label class="field"><span>${escapeHtml(t("partner", "label_portrait", locale))}</span>
    <input type="file" name="portrait" accept="image/png,image/jpeg,image/webp"></label>

  <p class="notice">${escapeHtml(t("partner", "notice_not_approved", locale))}</p>
  <button type="submit">${escapeHtml(t("partner", "submit_profile", locale))}</button>
</form>

<h2>${escapeHtml(t("partner", "heading_card", locale))}</h2>
<p class="notice">${escapeHtml(t("partner", "notice_id_assigned", locale))}</p>
<button class="secondary" id="submit-card" type="button">${escapeHtml(
        t("partner", "submit_card", locale)
    )}</button>

<form id="availability">
  <h2>${escapeHtml(t("partner", "heading_week", locale))}</h2>
  <label class="field"><span>${escapeHtml(t("partner", "label_week_start", locale))}</span>
    <input type="date" name="weekStartDate" required></label>
  <button class="secondary" id="apply-all" type="button">${escapeHtml(
      t("partner", "apply_to_all", locale)
  )}</button>
${days}
  <p class="notice">${escapeHtml(t("partner", "notice_not_confirmed", locale))}</p>
  <p class="notice">${escapeHtml(t("partner", "notice_no_assignment", locale))}</p>
  <button type="submit">${escapeHtml(t("partner", "submit_week", locale))}</button>
</form>

<section class="errors" id="errors" hidden></section>
</div>

<script>
(function(){
  var COPY = ${JSON.stringify({
      errorHeading: t("partner", "error_heading", locale),
      errorGeneric: t("partner", "error_generic", locale),
      idNotice: t("partner", "notice_id_assigned", locale),
      stages: {
          PROFILE_NOT_SUBMITTED: t("partner", "stage_profile_not_submitted", locale),
          PROFILE_SUBMITTED: t("partner", "stage_profile_submitted", locale),
          OWNER_REVIEW_REQUIRED: t("partner", "stage_owner_review", locale),
          AWAITING_SCHEDULE_CONFIRMATION: t("partner", "stage_awaiting_schedule", locale),
          APPROVED_SUPPLY: t("partner", "stage_approved_supply", locale)
      }
  })};
  var LOCALE = ${JSON.stringify(locale)};
  var errors = document.getElementById('errors');

  // The session token lives in memory for this page view only. Nothing about a
  // partner's standing is ever read back out of the browser: /api/partner/me is
  // the only source, and it reads authoritative persistence every time.
  var session = null;

  function text(el, value){ el.textContent = value; return el; }
  function showErrors(list){
    errors.innerHTML = '';
    var h = document.createElement('h3'); text(h, COPY.errorHeading); errors.appendChild(h);
    var ul = document.createElement('ul');
    list.forEach(function(line){ var li = document.createElement('li'); text(li, line); ul.appendChild(li); });
    errors.appendChild(ul); errors.hidden = false;
  }
  function clearErrors(){ errors.hidden = true; }

  function send(path, payload, method){
    var headers = { 'content-type': 'application/json' };
    if (session) { headers['x-partner-session'] = session; }
    return fetch(path, {
      method: method || 'POST', headers: headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, json: j }; }); });
  }

  function reportFailure(res){
    var lines = [];
    if (res.json.findings && res.json.findings.length) {
      res.json.findings.forEach(function(f){ lines.push(f.field + ': ' + f.message); });
    } else if (res.json.message) { lines.push(res.json.message); }
    else { lines.push(COPY.errorGeneric); }
    showErrors(lines);
  }

  function refreshStatus(){
    if (!session) { return Promise.resolve(); }
    return send('/api/partner/me', undefined, 'GET').then(function(res){
      if (res.status !== 200) { return; }
      var me = res.json;
      text(document.getElementById('status-name'),
           (me.profile && me.profile.displayName) || '—');
      text(document.getElementById('status-pid'), me.publicId || COPY.idNotice);
      text(document.getElementById('status-stage'), COPY.stages[me.stage] || me.stage);
    });
  }

  function ensureSession(contactHandle, displayName){
    if (session) { return Promise.resolve(true); }
    return send('/api/partner/session', { contactHandle: contactHandle, displayName: displayName })
      .then(function(res){
        if (res.status === 201) { session = res.json.sessionToken; return true; }
        reportFailure(res); return false;
      });
  }

  document.getElementById('profile').addEventListener('submit', function(event){
    event.preventDefault();
    clearErrors();
    var data = new FormData(event.target);
    var payload = {
      legalName: (data.get('legalName') || '').trim(),
      displayName: (data.get('displayName') || '').trim(),
      contactHandle: (data.get('contactHandle') || '').trim(),
      roleCode: data.get('roleCode') || '',
      serviceCodes: data.getAll('serviceCodes'),
      howYouWork: (data.get('howYouWork') || '').trim() || null,
      aboutMe: (data.get('aboutMe') || '').trim() || null,
      locale: LOCALE
    };
    ensureSession(payload.contactHandle, payload.displayName).then(function(ok){
      if (!ok) { return; }
      var portrait = data.get('portrait');
      var upload = (portrait && portrait.size)
        ? fetch('/api/partner/portrait', {
            method: 'POST',
            headers: { 'content-type': portrait.type || 'application/octet-stream',
                       'x-partner-session': session },
            body: portrait
          }).then(function(r){ return r.json(); }).then(function(j){ return j.mediaId || null; })
        : Promise.resolve(null);

      // The portrait is uploaded first so the profile can reference it. Bytes
      // are stored behind the server; the browser never holds a credential.
      return upload.then(function(mediaId){
        if (mediaId) { payload.portraitMediaId = mediaId; }
        return send('/api/partner/profile', payload);
      }).then(function(res){
        if (res.status >= 200 && res.status < 300) { return refreshStatus(); }
        reportFailure(res);
      });
    }).catch(function(){ showErrors([COPY.errorGeneric]); });
  });

  document.getElementById('submit-card').addEventListener('click', function(){
    clearErrors();
    if (!session) { showErrors([COPY.errorGeneric]); return; }
    send('/api/partner/card', {}).then(function(res){
      if (res.status >= 200 && res.status < 300) { return refreshStatus(); }
      reportFailure(res);
    }).catch(function(){ showErrors([COPY.errorGeneric]); });
  });

  // Apply-to-all copies Monday into every other day IN THE FORM. The request
  // still carries seven explicit days, so the canonical schedule is identical
  // to typing the same week out by hand.
  document.getElementById('apply-all').addEventListener('click', function(){
    var available = document.querySelector('input[name="available-1"]').checked;
    var start = document.querySelector('input[name="start-1"]').value;
    var end = document.querySelector('input[name="end-1"]').value;
    var regions = Array.prototype.slice
      .call(document.querySelectorAll('input[name="regions-1"]:checked'))
      .map(function(el){ return el.value; });
    for (var day = 2; day <= 7; day++) {
      document.querySelector('input[name="available-' + day + '"]').checked = available;
      document.querySelector('input[name="start-' + day + '"]').value = start;
      document.querySelector('input[name="end-' + day + '"]').value = end;
      Array.prototype.slice
        .call(document.querySelectorAll('input[name="regions-' + day + '"]'))
        .forEach(function(el){ el.checked = regions.indexOf(el.value) !== -1; });
    }
  });

  document.getElementById('availability').addEventListener('submit', function(event){
    event.preventDefault();
    clearErrors();
    if (!session) { showErrors([COPY.errorGeneric]); return; }
    var days = [];
    for (var day = 1; day <= 7; day++) {
      var available = document.querySelector('input[name="available-' + day + '"]').checked;
      var entry = { isoDay: day, available: available };
      if (available) {
        entry.startTime = document.querySelector('input[name="start-' + day + '"]').value;
        entry.endTime = document.querySelector('input[name="end-' + day + '"]').value;
        entry.regions = Array.prototype.slice
          .call(document.querySelectorAll('input[name="regions-' + day + '"]:checked'))
          .map(function(el){ return el.value; });
      }
      days.push(entry);
    }
    send('/api/partner/availability', {
      weekStartDate: document.querySelector('input[name="weekStartDate"]').value,
      days: days
    }).then(function(res){
      if (res.status >= 200 && res.status < 300) { return refreshStatus(); }
      reportFailure(res);
    }).catch(function(){ showErrors([COPY.errorGeneric]); });
  });
})();
</script>
</body>
</html>
`;
}
