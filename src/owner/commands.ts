// SCP-G5-F — the Owner command boundary.
//
// THE BOUNDARY: the Owner experience exercises authority. SCP owns the
// resulting operational truth.
//
// Every command here does the same three things and nothing else:
//
//   1. parse a CLOSED contract, so a client cannot smuggle a field
//   2. check the Owner-process precondition that has no canonical home
//      (has this request been judged serviceable? is this provider the strict
//      match the kernel just named?)
//   3. hand the work to `executeOperationalAction`
//
// It contains no state machine. It performs no transition itself, validates no
// predecessor state, and invents no reason code — Core does all of that, and a
// canonical refusal is carried back with its lifecycle code unchanged rather
// than paraphrased. That is what "no second operational state machine" means
// when it is structural: there is nothing in this file that could become one.

import type { PoolClient } from "pg";
import { executeOperationalAction, type OperationalOutcome } from "../lifecycle/orchestrator";
import type { OperationalActionType } from "../lifecycle/actions";
import { isQualifiedForMatching, currentQualification } from "../lifecycle/qualification";
import { attemptsForRequest } from "../lifecycle/dispatchAttempt";
import type { MarketId } from "../config/marketConfig";
import type { EffectiveConfiguration } from "../runtime/effectiveConfiguration";
import { recordRuntimeEvidence } from "../runtime/evidence";
import type { IdentityLineage } from "../runtime/identity";
import { ownerRequestDetail, type OwnerQueueEntry } from "./queue";
import { strictMatch } from "./matching";
import type { OwnerReason } from "./reasons";

// -----------------------------------------------------------------------------
// Closed contracts
// -----------------------------------------------------------------------------

export interface ContractFinding {
    field: string;
    code: "UNDECLARED_FIELD" | "FIELD_INVALID";
    message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Fields no Owner command declares, in any of its shapes. Listed so the
 * prohibition is greppable, but enforcement is the allowlist below — a denylist
 * would have to anticipate every name a client might invent.
 */
export const NEVER_DECLARED = [
    "state",
    "toState",
    "fromState",
    "status",
    "actorIdentityId",
    "role",
    "tenantId",
    "marketId",
    "environment",
    "confirmed",
    "assignmentId",
    "supplyStatus"
] as const;

function parse(
    body: unknown,
    declared: readonly string[],
    required: readonly string[]
): { ok: true; value: Record<string, unknown> } | { ok: false; findings: ContractFinding[] } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return {
            ok: false,
            findings: [{ field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }]
        };
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set(declared);
    const findings: ContractFinding[] = [];
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            findings.push({
                field: key,
                code: "UNDECLARED_FIELD",
                message: `${key} is not part of this command's contract and is not accepted`
            });
        }
    }
    for (const field of required) {
        const value = record[field];
        if (typeof value !== "string" || value.trim() === "") {
            findings.push({
                field,
                code: "FIELD_INVALID",
                message: `${field} is required and must be a non-empty string`
            });
        }
    }
    const key = record["idempotencyKey"];
    if (key !== undefined && key !== null && (typeof key !== "string" || !KEY_RE.test(key))) {
        findings.push({
            field: "idempotencyKey",
            code: "FIELD_INVALID",
            message:
                "idempotencyKey must be 8-128 characters of [A-Za-z0-9._:-] starting alphanumerically"
        });
    }
    for (const field of ["requestId", "providerId"]) {
        const value = record[field];
        if (typeof value === "string" && value.trim() !== "" && !UUID_RE.test(value)) {
            findings.push({ field, code: "FIELD_INVALID", message: `${field} must be a UUID` });
        }
    }
    return findings.length > 0 ? { ok: false, findings } : { ok: true, value: record };
}

// -----------------------------------------------------------------------------
// Outcome
// -----------------------------------------------------------------------------

export interface OwnerCommandContext {
    configuration: EffectiveConfiguration;
    /** The authenticated OWNER identity. Never a value from the request body. */
    ownerIdentityId: string;
    correlationId: string;
    now?: Date;
}

export interface OwnerCommandAccepted {
    command: string;
    requestId: string;
    /** Every governed action this command performed, in order. */
    actions: Array<{
        actionType: OperationalActionType;
        actionId: string;
        fromState: string | null;
        toState: string | null;
        replayed: boolean;
        detail: Record<string, unknown>;
    }>;
    /** The request as it stands afterwards, read back from canonical records. */
    request: OwnerQueueEntry;
}

export type OwnerCommandOutcome =
    | { ok: true; value: OwnerCommandAccepted }
    | {
          ok: false;
          reason: OwnerReason;
          message: string;
          findings?: ContractFinding[];
          /** Present when Core refused: its lifecycle code, unchanged. */
          canonicalReason?: string;
      };

function refuse(
    reason: OwnerReason,
    message: string,
    extra: { findings?: ContractFinding[]; canonicalReason?: string } = {}
): OwnerCommandOutcome {
    return { ok: false, reason, message, ...extra };
}

function lineageOf(configuration: EffectiveConfiguration): IdentityLineage {
    return {
        tenantId: configuration.identity.tenantId,
        marketId: configuration.identity.marketId,
        environment: configuration.identity.environment
    };
}

async function recordEvidence(
    client: PoolClient,
    context: OwnerCommandContext,
    kind: "OWNER_COMMAND_ACCEPTED" | "OWNER_COMMAND_REFUSED" | "OWNER_QUALIFICATION_RECORDED",
    detail: Record<string, unknown>,
    reasonCode?: string
): Promise<void> {
    await recordRuntimeEvidence(client, {
        kind,
        lineage: lineageOf(context.configuration),
        outcome: kind === "OWNER_COMMAND_REFUSED" ? "REFUSED" : "OK",
        reasonCode: reasonCode ?? null,
        configurationVersion: context.configuration.provenance.configurationVersion,
        configurationChecksum: context.configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            ownerIdentityId: context.ownerIdentityId,
            ...detail
        }
    });
}

/**
 * Loads the request, scoped. A request outside this runtime's market is
 * indistinguishable from one that does not exist, so a client learns nothing by
 * guessing identifiers.
 */
async function scopedRequest(
    client: PoolClient,
    context: OwnerCommandContext,
    requestId: string
): Promise<OwnerQueueEntry | null> {
    return ownerRequestDetail(
        client,
        {
            tenantId: context.configuration.identity.tenantId,
            marketId: context.configuration.identity.marketId,
            environment: context.configuration.identity.environment
        },
        requestId
    );
}

/** Runs one governed action through the orchestrator. */
async function act(
    client: PoolClient,
    context: OwnerCommandContext,
    input: {
        actionType: OperationalActionType;
        requestId: string;
        idempotencyKey: string;
        payload?: Record<string, unknown>;
    }
): Promise<OperationalOutcome> {
    return executeOperationalAction(client, {
        actionType: input.actionType,
        marketId: context.configuration.identity.marketId as MarketId,
        requestId: input.requestId,
        // The authenticated session identity. There is no path by which a body
        // field could reach this argument.
        actorIdentityId: context.ownerIdentityId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? {},
        ...(context.now ? { effectiveAt: context.now } : {})
    });
}

function keyFor(context: OwnerCommandContext, body: Record<string, unknown>, command: string): string {
    const supplied = body["idempotencyKey"];
    return typeof supplied === "string" && supplied !== ""
        ? supplied
        : `owner:${command}:${context.correlationId}`;
}

async function accepted(
    client: PoolClient,
    context: OwnerCommandContext,
    command: string,
    requestId: string,
    outcomes: OperationalOutcome[]
): Promise<OwnerCommandOutcome> {
    const request = await scopedRequest(client, context, requestId);
    const actions = outcomes.map((outcome) => {
        if (!outcome.ok) {
            throw new Error("accepted() called with a refused action");
        }
        return {
            actionType: outcome.actionType,
            actionId: outcome.actionId,
            fromState: outcome.fromState,
            toState: outcome.toState,
            replayed: outcome.replayed,
            detail: outcome.detail
        };
    });
    await recordEvidence(client, context, "OWNER_COMMAND_ACCEPTED", {
        command,
        requestId,
        actions: actions.map((a) => ({
            actionType: a.actionType,
            toState: a.toState,
            replayed: a.replayed
        })),
        resultingState: request?.state ?? null,
        resultingStage: request?.stage ?? null
    });
    return { ok: true, value: { command, requestId, actions, request: request! } };
}

async function canonicalRefusal(
    client: PoolClient,
    context: OwnerCommandContext,
    command: string,
    outcome: OperationalOutcome & { ok: false }
): Promise<OwnerCommandOutcome> {
    await recordEvidence(
        client,
        context,
        "OWNER_COMMAND_REFUSED",
        { command, canonicalReason: outcome.reasonCode, message: outcome.message },
        outcome.reasonCode
    );
    // Core's reason, verbatim. A boundary that paraphrased it would eventually
    // paraphrase one of them wrongly.
    return refuse("CANONICAL_REFUSAL", outcome.message, { canonicalReason: outcome.reasonCode });
}

// -----------------------------------------------------------------------------
// F-02 / F-03 — qualification
// -----------------------------------------------------------------------------

export const DECLARED_QUALIFY_FIELDS = [
    "requestId",
    "outcome",
    "reasonCode",
    "note",
    "idempotencyKey"
] as const;

/**
 * Records the Owner's serviceability judgement.
 *
 * SERVICEABLE and CLARIFICATION_REQUIRED record a judgement and move nothing.
 * UNSERVICEABLE records the judgement AND performs the governed cancellation,
 * as two separate orchestrator actions in one transaction — because concluding
 * that something cannot be served and telling the customer so are two acts, and
 * the audit trail should show both.
 */
export async function qualifyRequest(
    client: PoolClient,
    context: OwnerCommandContext,
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_QUALIFY_FIELDS, ["requestId", "outcome"]);
    if (!parsed.ok) {
        await recordEvidence(
            client,
            context,
            "OWNER_COMMAND_REFUSED",
            { command: "QUALIFY", findings: parsed.findings },
            "CONTRACT"
        );
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "qualification does not satisfy the command contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    const outcome = parsed.value["outcome"] as string;

    const request = await scopedRequest(client, context, requestId);
    if (!request) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }

    const key = keyFor(context, parsed.value, "qualify");
    const judgement = await act(client, context, {
        actionType: "QUALIFY_REQUEST",
        requestId,
        idempotencyKey: key,
        payload: {
            outcome,
            reasonCode: parsed.value["reasonCode"] ?? null,
            note: parsed.value["note"] ?? null
        }
    });
    if (!judgement.ok) {
        return canonicalRefusal(client, context, "QUALIFY", judgement);
    }
    await recordEvidence(client, context, "OWNER_QUALIFICATION_RECORDED", {
        requestId,
        outcome,
        // Stated in the record: a judgement is not a match, an offer or an
        // assignment.
        matched: false,
        offered: false,
        assigned: false,
        confirmed: false
    });

    const outcomes: OperationalOutcome[] = [judgement];

    if (outcome === "UNSERVICEABLE") {
        const cancelled = await act(client, context, {
            actionType: "CANCEL_SERVICE",
            requestId,
            idempotencyKey: `${key}:decline`,
            payload: {
                reasonCode: "OWNER_CANCELLED",
                note: parsed.value["reasonCode"] ?? null
            }
        });
        if (!cancelled.ok) {
            return canonicalRefusal(client, context, "QUALIFY", cancelled);
        }
        outcomes.push(cancelled);
    }

    return accepted(client, context, "QUALIFY", requestId, outcomes);
}

// -----------------------------------------------------------------------------
// F-06 / F-08 — strict match and provider offer
// -----------------------------------------------------------------------------

export const DECLARED_DISPATCH_FIELDS = ["requestId", "providerId", "idempotencyKey"] as const;

/**
 * Offers the work to a provider.
 *
 * Two Owner-process preconditions the surface owns, and nothing else:
 *   * the request must have been judged serviceable
 *   * the named provider must be the one G3 just named as the strict match
 *
 * Everything after that — predecessor state, provider approval, offer creation,
 * the transition to PROVIDER_DISPATCHED — belongs to Core.
 *
 * Creating an offer is not acceptance and not assignment. Those are separate
 * actions with separate authorities, and this command cannot reach either.
 */
export async function dispatchProvider(
    client: PoolClient,
    context: OwnerCommandContext,
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_DISPATCH_FIELDS, ["requestId", "providerId"]);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "dispatch does not satisfy the command contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    const providerId = parsed.value["providerId"] as string;

    const request = await scopedRequest(client, context, requestId);
    if (!request) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }

    if (!(await isQualifiedForMatching(client, requestId))) {
        const current = await currentQualification(client, requestId);
        await recordEvidence(
            client,
            context,
            "OWNER_COMMAND_REFUSED",
            { command: "DISPATCH", requestId, qualification: current?.outcome ?? null },
            current ? "QUALIFICATION_BLOCKS_MATCHING" : "NOT_QUALIFIED_FOR_MATCHING"
        );
        return current
            ? refuse(
                  "QUALIFICATION_BLOCKS_MATCHING",
                  `this request was last judged ${current.outcome}; it is not ready for matching`
              )
            : refuse(
                  "NOT_QUALIFIED_FOR_MATCHING",
                  "qualify this request as serviceable before offering it to a provider"
              );
    }

    // Ask G3. The Owner may only offer to whom the kernel says is eligible.
    const evaluated = await strictMatch(client, context.configuration, request, {
        preferredProviderId: providerId,
        ...(context.now ? { now: context.now } : {})
    });
    if ("ok" in evaluated) {
        return refuse("NO_ELIGIBLE_MATCH", evaluated.message);
    }
    await recordRuntimeEvidence(client, {
        kind: "OWNER_MATCH_EVALUATED",
        lineage: lineageOf(context.configuration),
        outcome: evaluated.match ? "OK" : "REFUSED",
        reasonCode: evaluated.reasonCode,
        configurationVersion: context.configuration.provenance.configurationVersion,
        configurationChecksum: context.configuration.provenance.checksum,
        detail: {
            correlationId: context.correlationId,
            requestId,
            requestedProviderId: providerId,
            matchedProviderId: evaluated.match?.providerId ?? null,
            approvedSupplyCount: evaluated.supply.approvedCount,
            coveringRequestedRegion: evaluated.supply.coveringCount
        }
    });
    if (!evaluated.match) {
        return refuse(
            "PROVIDER_NOT_ELIGIBLE_MATCH",
            `provider ${providerId} is not a strictly eligible match for this request: ${evaluated.reasonCode}`
        );
    }
    if (evaluated.match.providerId !== providerId) {
        return refuse(
            "PROVIDER_NOT_ELIGIBLE_MATCH",
            `provider ${providerId} is not a strictly eligible match for this request`
        );
    }

    const outcome = await act(client, context, {
        actionType: "DISPATCH_PROVIDER",
        requestId,
        idempotencyKey: keyFor(context, parsed.value, "dispatch"),
        payload: { providerId }
    });
    if (!outcome.ok) {
        return canonicalRefusal(client, context, "DISPATCH", outcome);
    }
    return accepted(client, context, "DISPATCH", requestId, [outcome]);
}

// -----------------------------------------------------------------------------
// F-10 / F-11 / F-12 — the remaining governed lifecycle commands
// -----------------------------------------------------------------------------

export const DECLARED_ASSIGN_FIELDS = ["requestId", "providerId", "idempotencyKey"] as const;
export const DECLARED_REQUEST_FIELDS = ["requestId", "idempotencyKey"] as const;
export const DECLARED_CANCEL_FIELDS = ["requestId", "reasonCode", "note", "idempotencyKey"] as const;

/**
 * The explicit Owner assignment.
 *
 * Every guard that matters lives in Core's ASSIGN_PROVIDER handler: predecessor
 * state, an accepted offer for THIS provider, provider approval, market scope,
 * idempotency, audit. This function supplies the authenticated Owner identity
 * and gets out of the way. Assignment transitions to OWNER_ASSIGNED and
 * nowhere near customer confirmation.
 */
export async function assignProviderCommand(
    client: PoolClient,
    context: OwnerCommandContext,
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_ASSIGN_FIELDS, ["requestId", "providerId"]);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "assignment does not satisfy the command contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    const providerId = parsed.value["providerId"] as string;
    const request = await scopedRequest(client, context, requestId);
    if (!request) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }

    // Core binds an assignment to the dispatch ATTEMPT that was accepted, not
    // to a provider id. The Owner names the provider they believe they are
    // assigning; the surface resolves the accepted attempt from canonical
    // records and refuses if it belongs to somebody else, so an operator can
    // never assign one provider while a different one holds the acceptance.
    //
    // Core re-validates the attempt's state anyway. This resolution exists so
    // the Owner's INTENT is checked against canonical truth, not to replace
    // Core's check.
    const attempts = await attemptsForRequest(client, requestId);
    const acceptedAttempt = [...attempts].reverse().find((a) => a.state === "ACCEPTED");
    if (!acceptedAttempt) {
        return refuse(
            "PROVIDER_NOT_ELIGIBLE_MATCH",
            "no provider has accepted this request, so there is nothing to assign"
        );
    }
    if (acceptedAttempt.providerId !== providerId) {
        return refuse(
            "PROVIDER_NOT_ELIGIBLE_MATCH",
            "the accepted dispatch attempt belongs to a different provider"
        );
    }
    const attempt = acceptedAttempt;

    const outcome = await act(client, context, {
        actionType: "ASSIGN_PROVIDER",
        requestId,
        idempotencyKey: keyFor(context, parsed.value, "assign"),
        payload: { attemptId: attempt.attemptId }
    });
    if (!outcome.ok) {
        return canonicalRefusal(client, context, "ASSIGN", outcome);
    }
    return accepted(client, context, "ASSIGN", requestId, [outcome]);
}

/**
 * Opens the customer-confirmation window.
 *
 * This ASKS the customer. It does not answer for them: recording the
 * confirmation requires the CUSTOMER role on that specific request, a gate no
 * Owner command can reach.
 */
export async function requestCustomerConfirmation(
    client: PoolClient,
    context: OwnerCommandContext,
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_REQUEST_FIELDS, ["requestId"]);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "confirmation request does not satisfy the command contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    if (!(await scopedRequest(client, context, requestId))) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }
    const outcome = await act(client, context, {
        actionType: "REQUEST_CUSTOMER_CONFIRMATION",
        requestId,
        idempotencyKey: keyFor(context, parsed.value, "request-confirmation")
    });
    if (!outcome.ok) {
        return canonicalRefusal(client, context, "REQUEST_CONFIRMATION", outcome);
    }
    return accepted(client, context, "REQUEST_CONFIRMATION", requestId, [outcome]);
}

/** Governed no-match recovery and operational cancellation (F-07). */
export async function cancelRequest(
    client: PoolClient,
    context: OwnerCommandContext,
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_CANCEL_FIELDS, ["requestId", "reasonCode"]);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "cancellation does not satisfy the command contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    if (!(await scopedRequest(client, context, requestId))) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }
    const outcome = await act(client, context, {
        actionType: "CANCEL_SERVICE",
        requestId,
        idempotencyKey: keyFor(context, parsed.value, "cancel"),
        payload: {
            reasonCode: parsed.value["reasonCode"],
            note: parsed.value["note"] ?? null
        }
    });
    if (!outcome.ok) {
        return canonicalRefusal(client, context, "CANCEL", outcome);
    }
    return accepted(client, context, "CANCEL", requestId, [outcome]);
}

/**
 * Fulfillment controls (F-12). Exposed because G4 established them, and routed
 * through the same canonical contracts with the same predecessor rules — an
 * Owner pressing "start" cannot skip a state any more than anyone else can.
 */
export async function fulfillmentCommand(
    client: PoolClient,
    context: OwnerCommandContext,
    actionType: "START_FULFILLMENT" | "COMPLETE_SERVICE",
    body: unknown
): Promise<OwnerCommandOutcome> {
    const parsed = parse(body, DECLARED_REQUEST_FIELDS, ["requestId"]);
    if (!parsed.ok) {
        return refuse(
            parsed.findings.some((f) => f.code === "UNDECLARED_FIELD")
                ? "UNDECLARED_FIELD"
                : "FIELD_INVALID",
            "command does not satisfy the contract",
            { findings: parsed.findings }
        );
    }
    const requestId = parsed.value["requestId"] as string;
    if (!(await scopedRequest(client, context, requestId))) {
        return refuse("REQUEST_UNKNOWN", "no such request in this market");
    }
    const outcome = await act(client, context, {
        actionType,
        requestId,
        idempotencyKey: keyFor(context, parsed.value, actionType.toLowerCase())
    });
    if (!outcome.ok) {
        return canonicalRefusal(client, context, actionType, outcome);
    }
    return accepted(client, context, actionType, requestId, [outcome]);
}
