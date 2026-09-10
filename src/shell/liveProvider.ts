// C3 — the LIVE projection provider.
//
// This file adapts. It does not decide. Every commercial and operational value it
// emits was produced by existing SCP code — `buildCustomerProjection` for the
// demand surface, `ownerQueue` and `deriveStage` for the operate surface — and
// this module's entire contribution is reshaping those results into the
// Shell-facing envelope.
//
// The rule that shapes everything below: it must not restate catalogue, pricing,
// availability, qualification, owner-stage or commitment rules. So where SCP does
// not currently produce a semantic, this provider reports its ABSENCE rather than
// deriving a plausible value. Two consequences are visible and deliberate:
//
//   - `availability` is empty. SCP models booking windows and operating hours as
//     market configuration, not as a resolved set of bookable slots, and turning
//     the former into the latter here would be inventing an availability rule.
//   - `eligibility` is unresolved and the posture never reaches CAN_COMMIT.
//     Canonical eligibility is not yet a proven LIVE SCP primitive (EXE-01A §3.4),
//     and AVAILABLE ≠ ELIGIBLE means a Shell may not promote one into the other.
//
// Both are honest gaps rather than defects in this adapter, and the inspector
// shows them as such.

import type { Pool } from "pg";

import { buildCustomerProjection } from "../customer/projection";
import { ownerQueue, type OwnerQueueEntry } from "../owner/queue";
import type { RuntimeContext } from "../runtime/bootstrap";
import { withTransaction } from "../db/pool";
import {
    type Committable,
    type DemandPayload,
    type OperateItem,
    type OperatePayload,
    type ProjectionEnvelope,
    type ProjectionProvider,
    type ProjectionRequest,
    type ShellService,
    type AttentionLevel
} from "./contract";

export const LIVE_PROVIDER_NAME = "scp-live";

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Maps a canonical owner stage to an attention level.
 *
 * Only mappings the canonical vocabulary actually justifies are made. Everything
 * else is NORMAL — the attention ladder is not completed by guessing, because an
 * invented BLOCKED is as misleading to an operator as a missed one.
 */
export function attentionForStage(stage: string): AttentionLevel {
    switch (stage) {
        case "CLARIFICATION_REQUIRED":
            // The canonical record says a human must resolve something.
            return "JUDGMENT_REQUIRED";
        case "OFFER_OUTSTANDING":
            // An offer awaiting response is a real change in the request's standing.
            return "MATERIAL_CHANGE";
        default:
            // BLOCKED, AUTHORITY_REQUIRED and EXCEPTION have no canonical source in
            // SCP today. Mapping a stage onto one of them to make the ladder look
            // complete would be inventing operational truth, and an invented BLOCKED
            // misleads an operator exactly as much as a missed one.
            return "NORMAL";
    }
}

function toService(service: {
    code: string;
    name: string;
    price: { minorUnits: number; currency: string; display: string };
    durationMinutes: number;
}): ShellService {
    return {
        code: service.code,
        name: service.name,
        price: {
            minorUnits: service.price.minorUnits,
            currency: service.price.currency,
            display: service.price.display
        },
        durationMinutes: service.durationMinutes
    };
}

/**
 * The honest LIVE committable posture.
 *
 * Service and price are resolved — the catalogue projection carries both.
 * Eligibility and capacity are not, so the posture is CAN_REQUEST: a customer may
 * submit demand, which is exactly what `submitCustomerDemand` supports, and
 * nothing stronger is claimed.
 */
function liveCommittable(serviceCount: number): Committable {
    if (serviceCount === 0) {
        return {
            posture: "NOT_DETERMINED",
            reason: "No services are published in the active governed configuration.",
            resolved: { service: false, price: false, eligibility: false, capacity: false }
        };
    }
    return {
        posture: "CAN_REQUEST",
        reason:
            "Service and price are governed and resolved. Canonical eligibility and capacity are " +
            "not yet live SCP primitives, so this surface may accept a request but must not " +
            "present a confirmed commitment.",
        resolved: { service: true, price: true, eligibility: false, capacity: false }
    };
}

export interface LiveProviderInput {
    pool: Pool;
    runtime: RuntimeContext;
}

/** Builds the LIVE provider bound to an already-started runtime. */
export function createLiveProjectionProvider(input: LiveProviderInput): ProjectionProvider {
    const { pool, runtime } = input;

    return {
        name: LIVE_PROVIDER_NAME,
        sourceType: "LIVE",

        async demand(request: ProjectionRequest): Promise<ProjectionEnvelope<DemandPayload>> {
            // The governed effective configuration is the source. This provider does
            // not read tenant JSON, market files or the database directly.
            const projection = buildCustomerProjection(runtime.configuration);
            const services = projection.catalogue.services.map(toService);
            const committable = liveCommittable(services.length);

            return {
                tenant: request.tenant,
                actor: request.actor,
                perspective: "DEMAND",
                authority: {
                    // A visitor may state demand. Committing is a separate act that
                    // canonical truth does not yet support here.
                    canRequest: committable.posture === "CAN_REQUEST",
                    canCommit: false,
                    requiresAuthority: false,
                    grants: ["DEMAND_SUBMIT"]
                },
                canonicalRef: {
                    kind: "TENANT_CONFIGURATION",
                    id: String(projection.provenance.configurationVersion)
                },
                state: {
                    code: "DEMAND_OPEN",
                    label: "Accepting requests",
                    terminal: false
                },
                actions: [
                    {
                        id: "submit-demand",
                        label: "Request this service",
                        kind: "REQUEST",
                        enabled: committable.posture === "CAN_REQUEST",
                        ...(committable.posture === "CAN_REQUEST" ? {} : { reason: committable.reason })
                    },
                    {
                        id: "commit",
                        label: "Confirm booking",
                        kind: "COMMIT",
                        enabled: false,
                        reason:
                            "Confirmation requires canonical eligibility and capacity, which are not " +
                            "yet live SCP primitives."
                    }
                ],
                provenance: {
                    sourceType: "LIVE",
                    provider: LIVE_PROVIDER_NAME,
                    sourceVersion: `v${projection.provenance.configurationVersion}`,
                    generatedAt: nowIso(),
                    correlationId: request.correlationId ?? null,
                    maturity: "LIVE_AUTHORITATIVE"
                },
                payload: {
                    brand: {
                        name: projection.brand.name,
                        publicName: projection.brand.publicName,
                        tagline: projection.brand.tagline,
                        marketDescriptor: projection.brand.marketDescriptor,
                        colors: projection.brand.colors,
                        headingFont: projection.brand.headingFont,
                        bodyFont: projection.brand.bodyFont
                    },
                    market: {
                        marketId: projection.market.marketId,
                        timezone: projection.market.timezone,
                        currency: projection.market.currency,
                        regions: projection.market.regions,
                        operatingHours: projection.market.operatingHours
                    },
                    services,
                    // No governed offer primitive exists yet; an empty list is the
                    // truthful answer and the inspector reports it as such.
                    offers: [],
                    // Deliberately empty — see the header note on availability.
                    availability: [],
                    committable
                }
            };
        },

        async operate(request: ProjectionRequest): Promise<ProjectionEnvelope<OperatePayload>> {
            const lineage = runtime.identity;
            const entries: OwnerQueueEntry[] = await withTransaction(pool, async (client) =>
                ownerQueue(client, {
                    tenantId: lineage.tenantId,
                    marketId: lineage.marketId,
                    environment: lineage.environment
                })
            );

            const items: OperateItem[] = entries.map((entry) => {
                // `ownerQueue` already derived this through `deriveStage`. Recomputing
                // it here would create a second place the stage could be decided, and
                // therefore a second place it could drift.
                const stage: string = entry.stage;
                return {
                    canonicalRef: { kind: "SERVICE_REQUEST", id: entry.requestId },
                    stage,
                    attention: attentionForStage(stage),
                    // Each field is read from the canonical record it belongs to. Where
                    // the source is a boolean, both branches are named: "not confirmed"
                    // is a known fact and must not be rendered as an unknown.
                    qualification: entry.qualification.outcome ?? null,
                    capacity: entry.dispatch.state ?? null,
                    assignment: entry.assignment.assignmentId === null ? "NOT_ASSIGNED" : "ASSIGNED",
                    confirmation: entry.confirmation.confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
                    fulfillment: entry.fulfillment.started
                        ? entry.fulfillment.result ?? "FULFILLMENT_ACTIVE"
                        : "NOT_STARTED",
                    // No canonical exception record exists to read from.
                    exception: null,
                    occurredAt: entry.createdAt.toISOString()
                };
            });

            return {
                tenant: request.tenant,
                actor: request.actor,
                perspective: "OPERATE",
                authority: {
                    canRequest: false,
                    canCommit: false,
                    // Operate is a reading surface here. VISIBILITY IS NOT AUTHORITY.
                    requiresAuthority: true,
                    grants: ["OPERATE_VIEW"]
                },
                canonicalRef: { kind: "OWNER_QUEUE", id: lineage.tenantId },
                state: {
                    code: items.length === 0 ? "QUEUE_EMPTY" : "QUEUE_ACTIVE",
                    label: items.length === 0 ? "No operator work" : `${items.length} in queue`,
                    terminal: false
                },
                actions: [],
                provenance: {
                    sourceType: "LIVE",
                    provider: LIVE_PROVIDER_NAME,
                    sourceVersion: `v${runtime.configuration.provenance.configurationVersion}`,
                    generatedAt: nowIso(),
                    correlationId: request.correlationId ?? null,
                    maturity: "LIVE_AUTHORITATIVE"
                },
                payload: { items }
            };
        }
    };
}
