// C4 — the provenance inspector.
//
// UAT instrumentation, not product. Its one job is to let DRJ or EXE look at any
// primary Experience Lab projection and answer two questions without reading
// code: is this authoritative or simulated, and why does it say what it says.
//
// It reports ABSENCE as a first-class answer. `eligibility: null` does not mean
// "not eligible" — it means the source does not model eligibility, which for LIVE
// SCP today is the truth and is exactly the fact a reviewer needs. A dash where a
// value should be is the most important thing on the page.
//
// It renders no customer-facing content and offers no action. SEEING IS NOT
// DOING: an inspector that could mutate anything would be an admin console.

import {
    attentionRank,
    type AttentionLevel,
    type DemandPayload,
    type OperatePayload,
    type ProjectionEnvelope
} from "./contract";

export interface InspectionReport {
    tenant: string;
    perspective: string;
    actor: { actorId: string | null; role: string };
    authority: {
        canRequest: boolean;
        canCommit: boolean;
        requiresAuthority: boolean;
        grants: readonly string[];
    };
    canonicalRef: { kind: string; id: string | null };
    state: { code: string; label: string; terminal: boolean };
    actions: ReadonlyArray<{ id: string; kind: string; enabled: boolean; reason: string | null }>;
    source: {
        sourceType: "LIVE" | "FIXTURE";
        provider: string;
        version: string | null;
        generatedAt: string;
        correlationId: string | null;
        maturity: string | null;
    };
    /** Commercial semantics, with null meaning "the source does not carry this". */
    commercial: {
        serviceCount: number | null;
        offerCount: number | null;
        recommendationCount: number | null;
        availabilityCount: number | null;
        eligibilityModelled: boolean | null;
        eligibleWindowCount: number | null;
        committablePosture: string | null;
        resolved: Record<string, boolean> | null;
    };
    /** Operational semantics, likewise. */
    operational: {
        itemCount: number | null;
        highestAttention: string | null;
        stages: readonly string[] | null;
    };
}

function isDemand(
    envelope: ProjectionEnvelope<unknown>
): envelope is ProjectionEnvelope<DemandPayload> {
    return envelope.perspective === "DEMAND";
}

function isOperate(
    envelope: ProjectionEnvelope<unknown>
): envelope is ProjectionEnvelope<OperatePayload> {
    return envelope.perspective === "OPERATE";
}

export function inspect(envelope: ProjectionEnvelope<unknown>): InspectionReport {
    const p = envelope.provenance;

    const commercial: InspectionReport["commercial"] = {
        serviceCount: null,
        offerCount: null,
        recommendationCount: null,
        availabilityCount: null,
        eligibilityModelled: null,
        eligibleWindowCount: null,
        committablePosture: null,
        resolved: null
    };

    const operational: InspectionReport["operational"] = {
        itemCount: null,
        highestAttention: null,
        stages: null
    };

    if (isDemand(envelope)) {
        const d = envelope.payload;
        const modelled = d.availability.some((window) => window.eligible !== undefined);
        commercial.serviceCount = d.services.length;
        commercial.offerCount = d.offers.filter((offer) => offer.kind === "OFFER").length;
        commercial.recommendationCount = d.offers.filter((o) => o.kind === "RECOMMENDATION").length;
        commercial.availabilityCount = d.availability.length;
        // Only claim the source models eligibility if some window actually says so.
        commercial.eligibilityModelled = d.availability.length === 0 ? false : modelled;
        commercial.eligibleWindowCount = modelled
            ? d.availability.filter((window) => window.eligible === true).length
            : null;
        commercial.committablePosture = d.committable.posture;
        commercial.resolved = { ...d.committable.resolved };
    }

    if (isOperate(envelope)) {
        const items = envelope.payload.items;
        operational.itemCount = items.length;
        operational.stages = items.map((item) => item.stage);
        // Highest attention across the queue, by the contract's own precedence.
        operational.highestAttention =
            items.length === 0
                ? null
                : items
                      .map((item) => item.attention)
                      .reduce((worst, level) =>
                          // ATTENTION_PRECEDENCE index 0 is the most severe.
                          attentionIsWorse(level, worst) ? level : worst
                      );
    }

    return {
        tenant: envelope.tenant,
        perspective: envelope.perspective,
        actor: { actorId: envelope.actor.actorId, role: envelope.actor.role },
        authority: {
            canRequest: envelope.authority.canRequest,
            canCommit: envelope.authority.canCommit,
            requiresAuthority: envelope.authority.requiresAuthority,
            grants: envelope.authority.grants
        },
        canonicalRef: envelope.canonicalRef,
        state: envelope.state,
        actions: envelope.actions.map((action) => ({
            id: action.id,
            kind: action.kind,
            enabled: action.enabled,
            reason: action.reason ?? null
        })),
        source: {
            sourceType: p.sourceType,
            provider: p.provider,
            version: p.fixtureVersion ?? p.sourceVersion ?? null,
            generatedAt: p.generatedAt,
            correlationId: p.correlationId ?? null,
            maturity: p.maturity ?? null
        },
        commercial,
        operational
    };
}

function attentionIsWorse(candidate: AttentionLevel, incumbent: AttentionLevel): boolean {
    return attentionRank(candidate) < attentionRank(incumbent);
}

const CELL = (value: unknown): string =>
    value === null || value === undefined
        ? `<td class="absent">—</td>`
        : `<td>${String(value)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")}</td>`;

/** Minimal HTML rendering. Monospace and unstyled on purpose: this is a probe. */
export function renderInspector(reports: readonly InspectionReport[]): string {
    const rows = reports
        .map((r) => {
            const fields: Array<[string, unknown]> = [
                ["tenant", r.tenant],
                ["perspective", r.perspective],
                ["source", `${r.source.sourceType} · ${r.source.provider}`],
                ["version", r.source.version],
                ["maturity", r.source.maturity],
                ["generatedAt", r.source.generatedAt],
                ["correlationId", r.source.correlationId],
                ["actor", `${r.actor.role}${r.actor.actorId === null ? " (anonymous)" : ""}`],
                ["canRequest", r.authority.canRequest],
                ["canCommit", r.authority.canCommit],
                ["requiresAuthority", r.authority.requiresAuthority],
                ["grants", r.authority.grants.join(", ")],
                ["canonicalRef", `${r.canonicalRef.kind}:${r.canonicalRef.id ?? "—"}`],
                ["state", `${r.state.code} (${r.state.label})`],
                ["services", r.commercial.serviceCount],
                ["offers", r.commercial.offerCount],
                ["recommendations", r.commercial.recommendationCount],
                ["availability windows", r.commercial.availabilityCount],
                ["eligibility modelled", r.commercial.eligibilityModelled],
                ["eligible windows", r.commercial.eligibleWindowCount],
                ["committable posture", r.commercial.committablePosture],
                ["resolved inputs", r.commercial.resolved === null ? null : JSON.stringify(r.commercial.resolved)],
                ["operate items", r.operational.itemCount],
                ["highest attention", r.operational.highestAttention],
                ["stages", r.operational.stages === null ? null : r.operational.stages.join(", ")]
            ];

            const body = fields.map(([k, v]) => `<tr><th>${k}</th>${CELL(v)}</tr>`).join("\n");
            const badge = r.source.sourceType === "LIVE" ? "live" : "fixture";

            return `<section class="card">
  <h2><span class="badge ${badge}">${r.source.sourceType}</span> ${r.tenant} · ${r.perspective}</h2>
  <table>${body}</table>
  <details><summary>actions (${r.actions.length})</summary><table>${r.actions
      .map(
          (a) =>
              `<tr><th>${a.id}</th><td>${a.kind} · ${a.enabled ? "enabled" : "disabled"}${
                  a.reason === null ? "" : ` — ${a.reason}`
              }</td></tr>`
      )
      .join("\n")}</table></details>
</section>`;
        })
        .join("\n");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Experience Lab — projection inspector</title>
<style>
body{margin:0;padding:24px;background:#101214;color:#D7DCE0;
  font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#8A939B;margin:0 0 20px}
.card{border:1px solid #262B30;border-radius:6px;padding:16px;margin:0 0 18px;background:#15181B}
h2{font-size:13px;margin:0 0 12px;display:flex;align-items:center;gap:10px}
.badge{font-size:10px;letter-spacing:.12em;padding:3px 8px;border-radius:3px}
.badge.live{background:#1E3A24;color:#7FD69A;border:1px solid #2E5C39}
.badge.fixture{background:#3A2E19;color:#E0B466;border:1px solid #5C4826}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-weight:400;color:#79838C;padding:3px 12px 3px 0;white-space:nowrap;vertical-align:top;width:200px}
td{padding:3px 0;word-break:break-word}
td.absent{color:#5A636B}
details{margin-top:12px}
summary{cursor:pointer;color:#79838C}
p.note{color:#79838C;max-width:80ch}
</style></head>
<body>
<h1>Experience Lab — projection inspector</h1>
<p class="note">Internal UAT instrumentation. A dash means the source does not carry that
semantic — which is not the same as the value being false.</p>
${rows}
</body></html>`;
}
