// SCP-G5-D — the governed customer demand-ingress boundary.
//
// ONE boundary. Customer intent enters here and leaves as a canonical SCP
// Service Request or a governed refusal, and there is no other way in.
//
// The order of operations is the design:
//
//   1. parse against the CLOSED intake contract   (browser cannot supply price,
//                                                  tenant, market, environment)
//   2. check any ASSERTED context against the      (a caller may claim an
//      runtime identity                             identity; it may never set one)
//   3. validate against GOVERNED CONFIGURATION     (catalogue, coverage, locale)
//   4. resolve the requested instant SERVER-SIDE   (client supplies a local date
//      in the market timezone                       and time, never an instant)
//   5. serialize on the idempotency key            (a replay is recognised
//                                                   before anything is written)
//   6. resolve CANONICAL catalogue identity        (fails closed if the governed
//      from the governed binding                    catalogue was never projected)
//   7. hand to CORE, which prices from its own     (this is why a browser price
//      catalogue and owns the resulting state       cannot govern commercial truth)
//   8. record the customer-context envelope        (region, accommodation,
//                                                   locale, contact, channel)
//
// What this module never does: create a lifecycle state, qualify a request,
// assign a provider, confirm a booking, activate payment, price anything, or
// write to `appointments`. REQUEST_RECEIVED is the whole of what a submission
// produces, and PENDING_ACCEPTANCE — chosen by Core, not here — is what that
// means canonically.

import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { createServiceRequest } from "../core/request/serviceRequest";
import type { Actor } from "../core/types";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { assertIdentityMatches, type RuntimeIdentity, type IdentityLineage } from "../runtime/identity";
import { recordRuntimeEvidence } from "../runtime/evidence";
import { resolveCatalogueIdentity } from "./catalogueProjection";
import {
    deriveIdempotencyKey,
    intentFingerprint,
    parseCustomerIntent,
    type CustomerIntent,
    type IntakeFinding
} from "./intake";
import type { IngressReason } from "./reasons";
import { buildAcknowledgement, type CustomerAcknowledgement } from "./acknowledgement";

export interface IngressRuntime {
    identity: RuntimeIdentity;
    configuration: EffectiveConfiguration;
}

export interface IngressInput {
    /** The submitted body, exactly as received. Never pre-filtered. */
    body: unknown;
    /** Ties every evidence row and adapter attempt for this submission together. */
    correlationId: string;
    /** Set by the transport that received the intent, never by the client. */
    sourceChannel: string;
    /** Context the caller ASSERTS. Checked, never trusted. */
    claimed?: { tenantId?: string | undefined; marketId?: string | undefined; environment?: string | undefined };
    /** Injectable server clock. Production passes nothing. */
    now?: Date;
}

export type IngressDisposition = "ACCEPTED" | "REPLAYED";

export interface AcceptedDemand {
    disposition: IngressDisposition;
    /** The canonical Service Request. The only identifier that means anything. */
    requestId: string;
    requestVersion: number;
    /** Always PENDING_ACCEPTANCE. Core chose it; ingress cannot pick a state. */
    state: string;
    priceMinorUnits: number;
    currencyCode: string;
    durationMinutes: number;
    startTime: Date;
    endTime: Date;
    idempotencyKey: string;
    correlationId: string;
    lineage: IdentityLineage;
    configurationVersion: number;
    configurationChecksum: string;
    customerIdentityId: string;
    acknowledgement: CustomerAcknowledgement;
}

export type IngressOutcome =
    | { ok: true; value: AcceptedDemand }
    | { ok: false; reason: IngressReason; message: string; findings?: IntakeFinding[] };

function refuse(reason: IngressReason, message: string, findings?: IntakeFinding[]): IngressOutcome {
    return findings ? { ok: false, reason, message, findings } : { ok: false, reason, message };
}

function parseClock(hhmm: string): { hour: number; minute: number } {
    const [h, m] = hhmm.split(":");
    return { hour: Number(h), minute: Number(m) };
}

/**
 * Validates intent against the governing configuration. Every check here is a
 * configuration lookup — none of these values exists as a constant anywhere in
 * this codebase, which is what stops a duplicated Freshline runtime constant
 * from becoming a second authority.
 */
function validateAgainstConfiguration(
    intent: CustomerIntent,
    configuration: EffectiveConfiguration
): IngressOutcome | null {
    const service = configuration.catalogue.services.find((s) => s.code === intent.serviceCode);
    if (!service) {
        return refuse("SERVICE_UNKNOWN", `service ${intent.serviceCode} is not in the governed catalogue`);
    }
    if (!service.active) {
        return refuse("SERVICE_INACTIVE", `service ${intent.serviceCode} is not active`);
    }

    const seen = new Set<string>();
    for (const code of intent.extraCodes) {
        if (seen.has(code)) {
            return refuse("EXTRA_DUPLICATED", `extra ${code} was submitted more than once`);
        }
        seen.add(code);
        const extra = configuration.catalogue.extras.find((e) => e.code === code);
        if (!extra) {
            return refuse("EXTRA_UNKNOWN", `extra ${code} is not in the governed catalogue`);
        }
        if (!extra.active) {
            return refuse("EXTRA_INACTIVE", `extra ${code} is not active`);
        }
    }

    if (!configuration.coverage.regions.includes(intent.region)) {
        return refuse("REGION_UNSUPPORTED", `region ${intent.region} is not in the governed coverage`);
    }

    if (
        intent.accommodationType !== null &&
        !configuration.coverage.customerContext.accommodationTypes.includes(intent.accommodationType)
    ) {
        return refuse(
            "ACCOMMODATION_UNSUPPORTED",
            `accommodation type ${intent.accommodationType} is not governed for this market`
        );
    }

    if (!configuration.locales.supported.includes(intent.locale)) {
        return refuse("LOCALE_UNSUPPORTED", `locale ${intent.locale} is not a governed supported locale`);
    }

    return null;
}

interface ResolvedTiming {
    startTime: Date;
    startLocal: DateTime;
}

/**
 * Resolves the customer's market-local selection to an instant, and checks it
 * against the governed opening time and booking window.
 *
 * The closing ceiling is NOT checked here: it depends on the service duration,
 * and the only authoritative duration is the one Core freezes onto the request
 * version. Checking it against a second, configuration-derived duration would
 * create exactly the duplicate authority this gate exists to prevent.
 */
function resolveTiming(
    intent: CustomerIntent,
    configuration: EffectiveConfiguration,
    now: Date
): IngressOutcome | ResolvedTiming {
    const zone = configuration.timezone.value;
    const startLocal = DateTime.fromISO(`${intent.requestedDate}T${intent.requestedTime}`, { zone });
    if (!startLocal.isValid) {
        return refuse(
            "REQUESTED_DATE_INVALID",
            `${intent.requestedDate} ${intent.requestedTime} is not a valid instant in ${zone}`
        );
    }

    const open = parseClock(configuration.operatingHours.value.open);
    const openLocal = startLocal.set({ hour: open.hour, minute: open.minute, second: 0, millisecond: 0 });
    if (startLocal < openLocal) {
        return refuse(
            "OUTSIDE_OPERATING_HOURS",
            `${intent.requestedTime} is before the governed opening time of ${configuration.operatingHours.value.open}`
        );
    }

    const close = parseClock(configuration.operatingHours.value.close);
    const closeLocal = startLocal.set({ hour: close.hour, minute: close.minute, second: 0, millisecond: 0 });
    if (startLocal >= closeLocal) {
        return refuse(
            "OUTSIDE_OPERATING_HOURS",
            `${intent.requestedTime} is at or after the governed closing time of ${configuration.operatingHours.value.close}`
        );
    }

    const startTime = startLocal.toJSDate();
    const leadMinutes = (startTime.getTime() - now.getTime()) / 60_000;
    const window = configuration.bookingWindow.value;
    if (leadMinutes < window.minLeadMinutes) {
        return refuse(
            "BOOKING_WINDOW_TOO_SOON",
            `requests require at least ${window.minLeadMinutes} minutes of lead time`
        );
    }
    if (leadMinutes / (60 * 24) > window.maxAdvanceDays) {
        return refuse(
            "BOOKING_WINDOW_TOO_FAR",
            `requests may be made at most ${window.maxAdvanceDays} days in advance`
        );
    }

    return { startTime, startLocal };
}

interface PriorIngress {
    request_id: string;
    request_fingerprint: string;
    configuration_version: number;
    configuration_checksum: string;
    customer_identity_id: string;
    requested_start_time: Date;
}

async function findPriorIngress(
    client: PoolClient,
    lineage: IdentityLineage,
    idempotencyKey: string
): Promise<PriorIngress | null> {
    const { rows } = await client.query<PriorIngress>(
        `SELECT request_id, request_fingerprint, configuration_version, configuration_checksum,
                customer_identity_id, requested_start_time
           FROM core_demand_ingress
          WHERE tenant_id = $1 AND market_id = $2 AND environment = $3 AND idempotency_key = $4`,
        [lineage.tenantId, lineage.marketId, lineage.environment, idempotencyKey]
    );
    return rows[0] ?? null;
}

/**
 * Resolves the customer identity behind a contact handle, creating one if this
 * is a first contact.
 *
 * It deliberately grants NO role. `core_identity_role` is what confers customer
 * confirmation authority, and a contact handle typed into a public form is
 * self-asserted, not verified. Granting CUSTOMER here would let an unverified
 * submission later confirm its own booking, which is precisely the collapse
 * OWNER_ASSIGNED -> CUSTOMER_CONFIRMED must not permit. Verification and the
 * role that follows from it are governed work beyond this gate.
 */
async function resolveCustomerIdentity(
    client: PoolClient,
    marketId: string,
    displayName: string,
    contactHandle: string
): Promise<string> {
    await client.query(
        `INSERT INTO core_identity (market_id, display_name, channel_handle)
         VALUES ($1, $2, $3)
         ON CONFLICT (market_id, channel_handle) DO NOTHING`,
        [marketId, displayName, contactHandle]
    );
    const { rows } = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_identity WHERE market_id = $1 AND channel_handle = $2`,
        [marketId, contactHandle]
    );
    return rows[0]!.identity_id;
}

/**
 * The single governed customer demand-ingress entry point.
 *
 * Runs inside the caller's transaction. On success the canonical Service
 * Request and the ingress record commit together, so a customer request can
 * never exist without its context or its context without a request.
 */
export async function submitCustomerDemand(
    client: PoolClient,
    runtime: IngressRuntime,
    input: IngressInput
): Promise<IngressOutcome> {
    const configuration = runtime.configuration;
    const lineage: IdentityLineage = {
        tenantId: runtime.identity.tenantId,
        marketId: runtime.identity.marketId,
        environment: runtime.identity.environment
    };
    const now = input.now ?? new Date();

    const recordRefusal = async (outcome: IngressOutcome): Promise<IngressOutcome> => {
        if (outcome.ok) {
            return outcome;
        }
        await recordRuntimeEvidence(client, {
            kind: "DEMAND_INGRESS_REFUSED",
            lineage,
            outcome: "REFUSED",
            reasonCode: outcome.reason,
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            detail: {
                correlationId: input.correlationId,
                sourceChannel: input.sourceChannel,
                message: outcome.message,
                findings: outcome.findings ?? []
            }
        });
        return outcome;
    };

    // 1. Closed contract.
    const parsed = parseCustomerIntent(input.body);
    if (!parsed.ok) {
        return recordRefusal(
            refuse(
                parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                    ? "UNDECLARED_FIELD"
                    : "FIELD_INVALID",
                "customer intent does not satisfy the intake contract",
                parsed.findings
            )
        );
    }
    const intent = parsed.intent;

    // 2. An asserted context is checked against the runtime identity. There is
    //    no branch in which a claim replaces it.
    if (input.claimed) {
        const identityCheck = assertIdentityMatches(runtime.identity, input.claimed);
        if (!identityCheck.ok) {
            return recordRefusal(
                refuse(
                    identityCheck.code === "ENVIRONMENT_MISMATCH"
                        ? "ENVIRONMENT_MISMATCH"
                        : "IDENTITY_MISMATCH",
                    identityCheck.message
                )
            );
        }
    }

    // 3. Governed configuration.
    const configurationFailure = validateAgainstConfiguration(intent, configuration);
    if (configurationFailure) {
        return recordRefusal(configurationFailure);
    }

    // 4. Server-resolved instant and governed operating policy.
    const timing = resolveTiming(intent, configuration, now);
    if ("ok" in timing) {
        return recordRefusal(timing);
    }

    const fingerprint = intentFingerprint({
        tenantId: lineage.tenantId,
        marketId: lineage.marketId,
        environment: lineage.environment,
        intent
    });
    const idempotencyKey = intent.idempotencyKey ?? deriveIdempotencyKey(fingerprint, input.correlationId);

    // 5. Serialize contenders for this key. Without it, simultaneous replays
    //    race to insert and the loser gets a raw unique violation instead of a
    //    governed answer.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `demand-ingress:${lineage.tenantId}:${lineage.marketId}:${lineage.environment}:${idempotencyKey}`
    ]);

    const prior = await findPriorIngress(client, lineage, idempotencyKey);
    if (prior) {
        if (prior.request_fingerprint !== fingerprint) {
            return recordRefusal(
                refuse(
                    "IDEMPOTENCY_KEY_CONFLICT",
                    `idempotency key ${idempotencyKey} was already used for materially different intent`
                )
            );
        }
        const version = await client.query<{
            version: number;
            price_minor_units: string;
            currency_code: string;
            duration_minutes: number;
            start_time: Date;
            end_time: Date;
        }>(
            `SELECT v.version, v.price_minor_units, v.currency_code, v.duration_minutes,
                    v.start_time, v.end_time
               FROM core_service_request r
               JOIN core_service_request_version v
                 ON v.request_id = r.request_id AND v.version = r.current_version
              WHERE r.request_id = $1`,
            [prior.request_id]
        );
        const v = version.rows[0]!;
        const stateRow = await client.query<{ state: string }>(
            `SELECT state FROM core_service_request WHERE request_id = $1`,
            [prior.request_id]
        );

        await recordRuntimeEvidence(client, {
            kind: "DEMAND_INGRESS_REPLAYED",
            lineage,
            outcome: "OK",
            configurationVersion: prior.configuration_version,
            configurationChecksum: prior.configuration_checksum,
            detail: {
                correlationId: input.correlationId,
                idempotencyKey,
                requestId: prior.request_id
            }
        });

        return {
            ok: true,
            value: {
                disposition: "REPLAYED",
                requestId: prior.request_id,
                requestVersion: v.version,
                state: stateRow.rows[0]!.state,
                priceMinorUnits: Number(v.price_minor_units),
                currencyCode: v.currency_code,
                durationMinutes: v.duration_minutes,
                startTime: v.start_time,
                endTime: v.end_time,
                idempotencyKey,
                correlationId: input.correlationId,
                lineage,
                configurationVersion: prior.configuration_version,
                configurationChecksum: prior.configuration_checksum,
                customerIdentityId: prior.customer_identity_id,
                acknowledgement: buildAcknowledgement({
                    locale: intent.locale,
                    requestId: prior.request_id,
                    brandPublicName: configuration.brand.publicName,
                    replay: true
                })
            }
        };
    }

    // 6. Canonical catalogue identity, from the governed binding only.
    const catalogue = await resolveCatalogueIdentity(
        client,
        lineage,
        intent.serviceCode,
        intent.extraCodes
    );
    if (!catalogue) {
        return recordRefusal(
            refuse(
                "CATALOGUE_NOT_PROJECTED",
                `the governed catalogue for ${intent.serviceCode} has not been projected into this runtime`
            )
        );
    }

    const customerIdentityId = await resolveCustomerIdentity(
        client,
        lineage.marketId,
        intent.customerName,
        intent.contactHandle
    );

    const actor: Actor = {
        identityId: customerIdentityId,
        role: "CUSTOMER",
        authority: `CUSTOMER_DEMAND_INGRESS:${input.sourceChannel}`
    };

    // 7. Core prices from its own catalogue and owns the resulting state. No
    //    price, duration or state value crosses this call from the client side.
    await client.query("SAVEPOINT demand_ingress");
    const created = await createServiceRequest(
        client,
        {
            marketId: lineage.marketId,
            customerIdentityId,
            serviceId: catalogue.serviceId,
            startTime: timing.startTime,
            addonIds: catalogue.addonIds
        },
        actor,
        `${idempotencyKey}:create`
    );
    if (!created.ok) {
        await client.query("ROLLBACK TO SAVEPOINT demand_ingress");
        return recordRefusal(
            refuse("CANONICAL_REFUSAL", `${created.code}: ${created.message}`)
        );
    }

    // The closing ceiling, checked against the ONE authoritative duration —
    // the one Core just froze onto the request version.
    const close = parseClock(configuration.operatingHours.value.close);
    const endLocal = DateTime.fromJSDate(created.value.endTime, { zone: configuration.timezone.value });
    const closeLocal = timing.startLocal.set({
        hour: close.hour,
        minute: close.minute,
        second: 0,
        millisecond: 0
    });
    if (endLocal > closeLocal) {
        await client.query("ROLLBACK TO SAVEPOINT demand_ingress");
        return recordRefusal(
            refuse(
                "CLOSING_CEILING_EXCEEDED",
                `this booking would end at ${endLocal.toFormat("HH:mm")}, after the governed closing time of ${configuration.operatingHours.value.close}`
            )
        );
    }
    await client.query("RELEASE SAVEPOINT demand_ingress");

    // 8. The customer-context envelope Core does not model.
    await client.query(
        `INSERT INTO core_demand_ingress
            (request_id, tenant_id, market_id, environment, configuration_version,
             configuration_checksum, idempotency_key, request_fingerprint, source_channel,
             locale, service_code, extra_codes, service_region, accommodation_type,
             customer_display_name, customer_contact_handle, customer_identity_id,
             requested_local_date, requested_local_time, requested_start_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,$14,$15,$16,$17,$18::date,$19,$20)`,
        [
            created.value.requestId,
            lineage.tenantId,
            lineage.marketId,
            lineage.environment,
            configuration.provenance.configurationVersion,
            configuration.provenance.checksum,
            idempotencyKey,
            fingerprint,
            input.sourceChannel,
            intent.locale,
            intent.serviceCode,
            intent.extraCodes,
            intent.region,
            intent.accommodationType,
            intent.customerName,
            intent.contactHandle,
            customerIdentityId,
            intent.requestedDate,
            intent.requestedTime,
            created.value.startTime
        ]
    );

    await recordRuntimeEvidence(client, {
        kind: "DEMAND_INGRESS_ACCEPTED",
        lineage,
        outcome: "OK",
        configurationVersion: configuration.provenance.configurationVersion,
        configurationChecksum: configuration.provenance.checksum,
        detail: {
            correlationId: input.correlationId,
            idempotencyKey,
            requestId: created.value.requestId,
            sourceChannel: input.sourceChannel,
            serviceCode: intent.serviceCode,
            extraCodes: intent.extraCodes,
            durationProvenance: catalogue.durationProvenance
        }
    });

    return {
        ok: true,
        value: {
            disposition: "ACCEPTED",
            requestId: created.value.requestId,
            requestVersion: created.value.version,
            state: "PENDING_ACCEPTANCE",
            priceMinorUnits: created.value.priceMinorUnits,
            currencyCode: created.value.currencyCode,
            durationMinutes: created.value.durationMinutes,
            startTime: created.value.startTime,
            endTime: created.value.endTime,
            idempotencyKey,
            correlationId: input.correlationId,
            lineage,
            configurationVersion: configuration.provenance.configurationVersion,
            configurationChecksum: configuration.provenance.checksum,
            customerIdentityId,
            acknowledgement: buildAcknowledgement({
                locale: intent.locale,
                requestId: created.value.requestId,
                brandPublicName: configuration.brand.publicName,
                replay: false
            })
        }
    };
}
