// SCP-G5-F — the Freshline Owner console, rendered from governed configuration.
//
// An operating interface, not a system of record. Everything it shows is
// fetched from the canonical projections on demand and thrown away on reload;
// nothing it holds is authoritative, and there is no client-side store for
// anything to become authoritative in.
//
// The console is deliberately explicit about what each action does and does NOT
// do — qualifying is not matching, offering is not acceptance, assigning is not
// confirming — because an operator interface that blurs those is how the
// separations get lost in practice even when the code preserves them.

import strings from "../localization/strings.json";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { escapeHtml } from "./page";

type LocalizedEntry = Record<string, string>;

function t(section: string, key: string, locale: string): string {
    const table = (strings as unknown as Record<string, Record<string, LocalizedEntry>>)[section];
    const entry = table?.[key];
    return entry?.[locale] ?? entry?.["en"] ?? "";
}

export interface OwnerProjection {
    /** Always false. An operating console is never a source of truth. */
    authoritative: false;
    brand: {
        publicName: string;
        marketDescriptor: string;
        colors: Record<string, string>;
        headingFont: string;
        bodyFont: string;
    };
    market: {
        marketId: string;
        timezone: string;
        currency: string;
        operatingHours: { open: string; close: string };
        regions: string[];
    };
    /** Reported from configuration, never invented (G5A-G10). */
    commerce: {
        paymentActive: boolean;
        dynamicPricingActive: boolean;
        ratingCommissionState: string;
        ratingCommissionActive: boolean;
    };
    provenance: {
        configurationVersion: number;
        configurationChecksum: string;
        tenantId: string;
        environment: string;
        canonicalMarketId: string;
    };
}

export function buildOwnerProjection(configuration: EffectiveConfiguration): OwnerProjection {
    const experience = configuration.experience.providerExperience;
    return {
        authoritative: false,
        brand: {
            publicName: configuration.brand.publicName,
            marketDescriptor: configuration.brand.marketDescriptor,
            colors: { ...configuration.brand.design.colors },
            headingFont: configuration.brand.design.headingFont,
            bodyFont: configuration.brand.design.bodyFont
        },
        market: {
            marketId: configuration.identity.marketId,
            timezone: configuration.timezone.value,
            currency: configuration.priceCurrency.value,
            operatingHours: configuration.operatingHours.value,
            regions: [...configuration.coverage.regions]
        },
        commerce: {
            paymentActive: configuration.commerce.payment.active,
            dynamicPricingActive: configuration.commerce.locationDynamicPricing.active,
            ratingCommissionState: experience.ratingCommission.state,
            ratingCommissionActive: experience.ratingCommission.active
        },
        provenance: {
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            tenantId: configuration.identity.tenantId,
            environment: configuration.identity.environment,
            canonicalMarketId: configuration.provenance.canonicalMarketId
        }
    };
}

export function renderOwnerConsole(p: OwnerProjection): string {
    const locale = "en";
    const colors = p.brand.colors;
    const black = colors["primaryBlack"] ?? "#0B0D0E";
    const teal = colors["freshlineTeal"] ?? "#00AFA5";
    const tealHover = colors["tealHover"] ?? teal;
    const silver = colors["silver"] ?? "#E7ECEF";
    const white = colors["white"] ?? "#FFFFFF";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(p.brand.publicName)} Operations</title>
<style>
:root{
  --black:${black};--teal:${teal};--teal-hover:${tealHover};--silver:${silver};--white:${white};
  --heading:${escapeHtml(p.brand.headingFont)},"Oswald",system-ui,sans-serif;
  --body:${escapeHtml(p.brand.bodyFont)},"DM Sans",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--black);color:var(--white);font-family:var(--body);font-size:15px;line-height:1.5}
.wrap{width:100%;max-width:1100px;margin:0 auto;padding:20px 16px 80px}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:10px}
h1{font-family:var(--heading);font-weight:700;font-size:1.4rem;margin:0}
h1 .mkt{color:var(--teal)}
.meta{color:var(--silver);opacity:.7;font-size:.8rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}
input[type=text],input[type=password],select,textarea{
  min-height:44px;padding:10px 12px;font:inherit;color:var(--white);
  background:rgba(231,236,239,.06);border:1px solid rgba(231,236,239,.22);border-radius:10px}
input:focus,select:focus{outline:2px solid var(--teal);outline-offset:1px}
#token{flex:1 1 320px}
button{min-height:44px;padding:10px 16px;font:inherit;font-weight:600;color:var(--black);
  background:var(--teal);border:0;border-radius:10px;cursor:pointer}
button.ghost{background:transparent;color:var(--teal);border:1px solid var(--teal)}
button.warn{background:transparent;color:#E4572E;border:1px solid #E4572E}
button:hover:not(:disabled){background:var(--teal-hover)}
button.ghost:hover:not(:disabled){background:rgba(0,175,165,.12)}
button.warn:hover:not(:disabled){background:rgba(228,87,46,.12)}
button:disabled{opacity:.5;cursor:not-allowed}
.card{border:1px solid rgba(231,236,239,.18);border-radius:12px;padding:14px;margin:12px 0}
.card h3{font-family:var(--heading);font-size:1.05rem;margin:0 0 4px}
.row{display:flex;flex-wrap:wrap;gap:14px;color:var(--silver);font-size:.85rem;opacity:.85}
.stage{display:inline-block;padding:3px 9px;border-radius:999px;font-size:.72rem;font-weight:700;
  letter-spacing:.05em;border:1px solid var(--teal);color:var(--teal)}
.stage.closed{border-color:rgba(231,236,239,.3);color:var(--silver)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
/* SCP-G5-H-UX-CLOSE-03B — the coverage view. Brand tokens only, no
   tenant-specific rule, one column on mobile so 320px never scrolls sideways. */
.cov-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:4px 0 8px}
.cov-count{font-family:var(--heading);font-weight:700;font-size:1.1rem;color:var(--teal)}
.cov-regions{color:var(--silver);opacity:.8;font-size:.85rem;min-width:0;word-break:break-word}
.cov-row{border:1px solid rgba(231,236,239,.18);border-radius:12px;padding:12px;margin:8px 0;min-width:0}
.cov-name{font-family:var(--heading);font-weight:700;letter-spacing:.03em;margin:0 0 4px}
.cov-meta{color:var(--silver);opacity:.75;font-size:.85rem;margin:0 0 6px;word-break:break-word}
.cov-days{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.cov-day{border:1px solid rgba(231,236,239,.22);border-radius:999px;padding:3px 10px;
  font-size:.78rem;color:var(--silver);min-width:0}
.cov-day.on{border-color:var(--teal);color:var(--teal)}
.cov-empty{color:var(--silver);opacity:.75;font-size:.9rem;margin:8px 0}
.sep{margin:14px 0;border-top:1px solid rgba(231,236,239,.12)}
.notice{border-left:2px solid var(--teal);padding:6px 0 6px 10px;margin:10px 0;
  color:var(--silver);opacity:.75;font-size:.82rem}
pre{background:rgba(231,236,239,.05);border:1px solid rgba(231,236,239,.15);border-radius:10px;
  padding:12px;overflow-x:auto;font-size:.78rem;color:var(--silver);max-height:360px}
.err{border-color:#E4572E;color:#E4572E}
[hidden]{display:none !important}
@media (max-width:640px){ .wrap{padding:16px 12px 80px} }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(p.brand.publicName)} <span class="mkt">Operations</span></h1>
  <span class="meta">${escapeHtml(p.provenance.tenantId)} · ${escapeHtml(
      p.market.marketId
  )} · ${escapeHtml(p.provenance.environment)} · cfg v${p.provenance.configurationVersion} · ${escapeHtml(
      p.provenance.configurationChecksum.slice(0, 12)
  )}</span>
</header>

<p class="notice">This console exercises authority. It is not the system of record — every
figure below is read from canonical SCP records at the moment you ask, and nothing it shows
is stored here.</p>
<p class="notice">Payment ${p.commerce.paymentActive ? "ACTIVE" : "inactive"} ·
dynamic pricing ${p.commerce.dynamicPricingActive ? "ACTIVE" : "inactive"} ·
rating/commission ${escapeHtml(p.commerce.ratingCommissionState)}${
        p.commerce.ratingCommissionActive ? " (active)" : " (inactive)"
    }</p>

<div class="bar">
  <input type="password" id="token" placeholder="Owner session token" autocomplete="off">
  <button id="load">Load queue</button>
  <label style="display:flex;align-items:center;gap:6px;color:var(--silver);font-size:.85rem">
    <input type="checkbox" id="closed"> include closed
  </label>
</div>

<div class="bar">
  <input type="date" id="week" aria-label="Week starting Monday">
  <button id="loadCoverage">Load coverage</button>
</div>

<section id="errors" class="card err" hidden></section>
<section id="coverage"></section>
<section id="queue"></section>
<div class="sep"></div>
<h3 style="font-family:var(--heading)">Last response</h3>
<pre id="out">—</pre>
</div>

<script>
(function(){
  // The token lives in this page view only. Nothing about operational truth is
  // ever read back out of the browser: every render comes from /api/owner.
  function token(){ return document.getElementById('token').value.trim(); }
  var out = document.getElementById('out');
  var errors = document.getElementById('errors');
  var queue = document.getElementById('queue');

  function show(value){ out.textContent = JSON.stringify(value, null, 2); }
  function fail(value){
    errors.textContent = typeof value === 'string' ? value : (value.message || value.error || 'failed');
    errors.hidden = false;
  }
  function clearError(){ errors.hidden = true; }

  function call(path, body, method){
    return fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-owner-session': token() },
      body: body ? JSON.stringify(body) : undefined
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, json: j }; }); });
  }

  function act(path, body){
    clearError();
    return call(path, body).then(function(res){
      show(res.json);
      if (res.status >= 400) { fail(res.json); return; }
      return load();
    }).catch(function(e){ fail(String(e)); });
  }

  function text(el, value){ el.textContent = value; return el; }

  function button(label, className, handler){
    var b = document.createElement('button');
    if (className) { b.className = className; }
    text(b, label);
    b.addEventListener('click', handler);
    return b;
  }

  function money(minor, currency){ return currency + ' ' + minor.toLocaleString('en-US'); }

  function render(entries){
    queue.innerHTML = '';
    if (!entries.length) {
      var empty = document.createElement('p');
      empty.className = 'notice';
      text(empty, 'Nothing needs operational attention.');
      queue.appendChild(empty);
      return;
    }
    entries.forEach(function(e){
      var card = document.createElement('div'); card.className = 'card';
      var h = document.createElement('h3');
      text(h, (e.customer.displayName || 'Customer') + ' — ' + (e.customer.serviceCode || 'service'));
      card.appendChild(h);

      var stage = document.createElement('span');
      stage.className = 'stage' + (e.stage === 'CLOSED' ? ' closed' : '');
      text(stage, e.stage);
      card.appendChild(stage);

      var row = document.createElement('div'); row.className = 'row';
      [
        'state ' + e.state,
        'v' + e.currentVersion,
        new Date(e.startTime).toISOString(),
        String(e.durationMinutes) + ' min',
        money(e.priceMinorUnits, e.currencyCode),
        'region ' + (e.customer.serviceRegion || '—'),
        'qualification ' + (e.qualification.outcome || 'none'),
        'offer ' + (e.dispatch.state || 'none'),
        'assigned ' + (e.assignment.providerId ? 'yes' : 'no'),
        'confirmed ' + (e.confirmation.confirmed ? 'yes' : 'no')
      ].forEach(function(bit){
        var s = document.createElement('span'); text(s, bit); row.appendChild(s);
      });
      card.appendChild(row);

      var actions = document.createElement('div'); actions.className = 'actions';
      actions.appendChild(button('Serviceable', 'ghost', function(){
        act('/api/owner/qualify', { requestId: e.requestId, outcome: 'SERVICEABLE' });
      }));
      actions.appendChild(button('Needs clarification', 'ghost', function(){
        act('/api/owner/qualify', { requestId: e.requestId, outcome: 'CLARIFICATION_REQUIRED' });
      }));
      actions.appendChild(button('Unserviceable', 'warn', function(){
        act('/api/owner/qualify', {
          requestId: e.requestId, outcome: 'UNSERVICEABLE', reasonCode: 'OWNER_CANCELLED'
        });
      }));
      actions.appendChild(button('Supply', 'ghost', function(){
        clearError();
        call('/api/owner/requests/' + e.requestId + '/supply').then(function(r){ show(r.json); });
      }));
      actions.appendChild(button('Find match', 'ghost', function(){
        clearError();
        call('/api/owner/requests/' + e.requestId + '/match').then(function(r){
          show(r.json);
          if (r.json.match) {
            card.dataset.matchProvider = r.json.match.providerId;
          }
        });
      }));
      actions.appendChild(button('Offer to match', null, function(){
        var providerId = card.dataset.matchProvider;
        if (!providerId) { fail('Find a match first — the Owner may only offer to an eligible provider.'); return; }
        act('/api/owner/dispatch', { requestId: e.requestId, providerId: providerId });
      }));
      actions.appendChild(button('Assign', null, function(){
        var providerId = e.dispatch.providerId || card.dataset.matchProvider;
        if (!providerId) { fail('No provider to assign.'); return; }
        act('/api/owner/assign', { requestId: e.requestId, providerId: providerId });
      }));
      actions.appendChild(button('Ask customer to confirm', 'ghost', function(){
        act('/api/owner/request-confirmation', { requestId: e.requestId });
      }));
      actions.appendChild(button('Start fulfillment', 'ghost', function(){
        act('/api/owner/start-fulfillment', { requestId: e.requestId });
      }));
      actions.appendChild(button('Complete', 'ghost', function(){
        act('/api/owner/complete-service', { requestId: e.requestId });
      }));
      actions.appendChild(button('Cancel', 'warn', function(){
        act('/api/owner/cancel', { requestId: e.requestId, reasonCode: 'OWNER_CANCELLED' });
      }));
      card.appendChild(actions);

      var note = document.createElement('p'); note.className = 'notice';
      text(note, 'Qualifying is not matching. Offering is not acceptance. Assigning is not customer confirmation. Confirmation is not fulfillment.');
      card.appendChild(note);

      queue.appendChild(card);
    });
  }

  function load(){
    clearError();
    var closed = document.getElementById('closed').checked;
    return call('/api/owner/queue?includeClosed=' + (closed ? 'true' : 'false')).then(function(res){
      if (res.status >= 400) { fail(res.json); return; }
      render(res.json.queue);
      show({ loaded: res.json.queue.length, correlationId: res.json.correlationId });
    }).catch(function(e){ fail(String(e)); });
  }

  var DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  function renderCoverage(data){
    var host = document.getElementById('coverage');
    host.innerHTML = '';
    var head = document.createElement('div'); head.className = 'cov-head';
    var count = document.createElement('span'); count.className = 'cov-count';
    text(count, data.approvedSupplyCount + ' approved supply');
    head.appendChild(count);
    var regions = document.createElement('span'); regions.className = 'cov-regions';
    text(regions, data.coverageRegions.length
      ? 'Coverage: ' + data.coverageRegions.join(', ')
      : 'No coverage regions for this week.');
    head.appendChild(regions);
    host.appendChild(head);

    if (!data.supply.length) {
      var empty = document.createElement('p'); empty.className = 'cov-empty';
      text(empty, 'No approved supply for the week beginning ' + data.weekStartDate +
        '. Matching will find no eligible provider until a Partner Card and a week are both confirmed.');
      host.appendChild(empty);
      return;
    }

    data.supply.forEach(function(entry){
      var row = document.createElement('div'); row.className = 'cov-row';
      var name = document.createElement('p'); name.className = 'cov-name';
      text(name, entry.displayName + ' · ' + entry.publicId);
      row.appendChild(name);
      var meta = document.createElement('p'); meta.className = 'cov-meta';
      text(meta, entry.roleCode + ' · ' + entry.serviceCodes.join(', ') +
        ' · week ' + entry.weekStartDate + ' v' + entry.availabilityVersion);
      row.appendChild(meta);
      var days = document.createElement('div'); days.className = 'cov-days';
      for (var i = 1; i <= 7; i++) {
        var day = null;
        for (var j = 0; j < entry.days.length; j++) {
          if (entry.days[j].isoDay === i) { day = entry.days[j]; }
        }
        var chip = document.createElement('span');
        chip.className = 'cov-day' + (day ? ' on' : '');
        text(chip, day
          ? DAYS[i-1] + ' ' + day.startTimeLocal + '-' + day.endTimeLocal +
            (day.regions && day.regions.length ? ' · ' + day.regions.join('/') : '')
          : DAYS[i-1] + ' —');
        days.appendChild(chip);
      }
      row.appendChild(days);
      row.appendChild((function(){
        var n = document.createElement('p'); n.className = 'notice';
        text(n, 'Approved supply is not an assignment. This view reports canonical truth; it does not create it.');
        return n;
      })());
      host.appendChild(row);
    });
  }

  function loadCoverage(){
    clearError();
    var week = document.getElementById('week').value;
    if (!week) { fail('Choose the Monday of the week to inspect.'); return Promise.resolve(); }
    return call('/api/owner/coverage?weekStartDate=' + encodeURIComponent(week)).then(function(res){
      if (res.status >= 400) { fail(res.json); return; }
      renderCoverage(res.json);
      show({ weekStartDate: res.json.weekStartDate, approvedSupplyCount: res.json.approvedSupplyCount,
             coverageRegions: res.json.coverageRegions, correlationId: res.json.correlationId });
    }).catch(function(e){ fail(String(e)); });
  }

  document.getElementById('loadCoverage').addEventListener('click', loadCoverage);
  document.getElementById('load').addEventListener('click', load);
  document.getElementById('closed').addEventListener('change', load);
})();
</script>
</body>
</html>
`;
}
