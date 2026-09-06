// SCP Operational Lifecycle — the orchestrator.
//
// ONE governed entry point for every operational transition. Each call is
// wrapped in an OperationalAction envelope that validates tenant, market,
// request, predecessor state, actor identity, binding authority, operational
// context freshness and idempotency BEFORE any canonical state change, and
// persists the outcome whether it was accepted or refused.
//
// The orchestrator owns no state. Canonical state changes go through
// transitionRequest, which remains the sole owner of core_service_request.state.
// Everything else here is versioned evidence about how that owner moved.
//
// AUTHORITY SEPARATION is structural, not advisory:
//   provider acceptance  -> authorizeProviderResponse   (PROVIDER + offered-to)
//   owner assignment     -> authorizeOwnerAssignment    (OWNER)
//   customer confirmation-> authorizeCustomerConfirmation(CUSTOMER + own request)
// No handler can reach a gate that is not its own.

import type { PoolClient } from "pg";
import {
    SYSTEM_ACTOR,
    type Actor,
    type ServiceRequestState
} from "../core/types";
import { requireUuid, isUuid } from "../core/identifiers";
import { loadMarketConfig, type MarketConfig, type MarketId } from "../config/marketConfig";
import {
    loadRequestForUpdate,
    transitionRequest,
    isTerminal,
    loadCurrentVersion,
    type ServiceRequestRow
} from "../core/request/serviceRequest";
import {
    authorizeCustomerConfirmation,
    authorizeOwnerAssignment,
    authorizeProviderResponse,
    loadIdentity
} from "../core/identity/authority";
import { loadProvider, isDispatchable } from "../core/provider/provider";
import { activeHoldsForRequest, releaseCapacity, withdrawProviderCapacity } from "../core/capacity/capacity";
import {
    actionFingerprint,
    findActionByKey,
    isOperationalActionType,
    persistAction,
    type ActionPayload,
    type OperationalActionType
} from "./actions";
import type { LifecycleReason } from "./reasons";
import {
    currentAttempt,
    decideAttempt,
    loadAttempt,
    openAttempt
} from "./dispatchAttempt";
import {
    activeAssignment,
    assignProvider,
    revokeActiveAssignment
} from "./providerAssignment";
import {
    confirmContext,
    liveContext,
    openContext,
    supersedeLiveContext,
    withdrawLiveContext
} from "./confirmationContext";
import { openRecovery, resolveRecovery, openRecoveryFor } from "./recovery";

export interface OperationalActionRequest {
    actionType: OperationalActionType;
    marketId: MarketId;
    requestId: string;
    /** Null only for SYSTEM-initiated actions such as dispatch expiry. */
    actorIdentityId: string | null;
    idempotencyKey: string;
    payload?: ActionPayload;
    effectiveAt?: Date;
}

export type OperationalOutcome =
    | {
          ok: true;
          actionId: string;
          actionType: OperationalActionType;
          fromState: string | null;
          toState: string | null;
          replayed: boolean;
          detail: Record<string, unknown>;
      }
    | {
          ok: false;
          actionId: string | null;
          actionType: OperationalActionType;
          reasonCode: LifecycleReason;
          message: string;
          replayed: boolean;
      };

interface HandlerContext {
    client: PoolClient;
    request: ServiceRequestRow;
    config: MarketConfig;
    tenantId: string;
    actorIdentityId: string | null;
    payload: ActionPayload;
    effectiveAt: Date;
    idempotencyKey: string;
}

type HandlerResult =
    | {
          accepted: true;
          actor: Actor;
          fromState: string | null;
          toState: string | null;
          detail: Record<string, unknown>;
      }
    | { accepted: false; actor: Actor; reasonCode: LifecycleReason; message: string };

function refuse(reasonCode: LifecycleReason, message: string, actor?: Actor): HandlerResult {
    return { accepted: false, actor: actor ?? SYSTEM_ACTOR, reasonCode, message };
}

/** Actions that may never run against a terminal Service Request. */
const MUTATING_ACTIONS: ReadonlySet<OperationalActionType> = new Set([
    "DISPATCH_PROVIDER",
    "EXPIRE_DISPATCH",
    "RECORD_PROVIDER_ACCEPTANCE",
    "RECORD_PROVIDER_REJECTION",
    "ASSIGN_PROVIDER",
    "REASSIGN_PROVIDER",
    "REQUEST_CUSTOMER_CONFIRMATION",
    "RECORD_CUSTOMER_CONFIRMATION",
    "START_FULFILLMENT",
    "COMPLETE_SERVICE",
    "CANCEL_SERVICE",
    "MARK_NO_SHOW",
    "MARK_UNABLE_TO_FULFILL",
    "RECORD_CAPACITY_LOSS",
    "INITIATE_OPERATIONAL_RECOVERY"
]);

/**
 * Executes one governed operational action. Must be called inside a
 * transaction: either the canonical change, its evidence and its audit all
 * land, or none of it does.
 */
export async function executeOperationalAction(
    client: PoolClient,
    input: OperationalActionRequest
): Promise<OperationalOutcome> {
    const actionType = input.actionType;

    if (!isOperationalActionType(actionType)) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "AMBIGUOUS_ACTION",
            message: `unknown action type ${String(actionType)}`,
            replayed: false
        };
    }

    const idCheck = requireUuid("requestId", input.requestId);
    if (!idCheck.ok) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "CORRELATION_REQUIRED",
            message: idCheck.message,
            replayed: false
        };
    }
    if (input.actorIdentityId !== null && !isUuid(input.actorIdentityId)) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "AUTHORITY_REFUSED",
            message: `actorIdentityId ${JSON.stringify(input.actorIdentityId)} is not a valid UUID`,
            replayed: false
        };
    }

    let config: MarketConfig;
    try {
        config = loadMarketConfig(input.marketId);
    } catch (err) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "CORRELATION_REQUIRED",
            message: err instanceof Error ? err.message : String(err),
            replayed: false
        };
    }
    const tenantId = config.tenantId;
    const payload = input.payload ?? {};
    const effectiveAt = input.effectiveAt ?? new Date();

    const fingerprint = actionFingerprint({
        tenantId,
        marketId: input.marketId,
        requestId: input.requestId,
        actionType,
        actorIdentityId: input.actorIdentityId,
        payload
    });

    const replayOf = (prior: NonNullable<Awaited<ReturnType<typeof findActionByKey>>>):
        | OperationalOutcome
        | null => {
        if (prior.requestFingerprint !== fingerprint) {
            return {
                ok: false,
                actionId: prior.actionId,
                actionType,
                reasonCode: "IDEMPOTENCY_CONFLICT",
                message: `idempotency key ${input.idempotencyKey} was already used for a materially different action`,
                replayed: false
            };
        }
        // Honest replay: return the decision already made, accepted or refused.
        if (prior.outcome === "ACCEPTED") {
            return {
                ok: true,
                actionId: prior.actionId,
                actionType,
                fromState: prior.fromState,
                toState: prior.toState,
                replayed: true,
                detail: prior.payload
            };
        }
        return {
            ok: false,
            actionId: prior.actionId,
            actionType,
            reasonCode: prior.reasonCode ?? "AMBIGUOUS_ACTION",
            message: "replayed refusal",
            replayed: true
        };
    };

    // --- Idempotency fast path, before any work ---------------------------
    const early = await findActionByKey(client, tenantId, input.idempotencyKey);
    if (early) {
        return replayOf(early)!;
    }

    // --- Load and lock the canonical aggregate ----------------------------
    const request = await loadRequestForUpdate(client, input.requestId);
    if (!request) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "CORRELATION_REQUIRED",
            message: `service request ${input.requestId} not found`,
            replayed: false
        };
    }
    if (request.marketId !== input.marketId) {
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "AUTHORITY_REFUSED",
            message: `service request belongs to market ${request.marketId}`,
            replayed: false
        };
    }

    // AUTHORITATIVE idempotency check, now that the request row is locked.
    //
    // The fast path above cannot see a concurrent transaction's uncommitted
    // action, so two simultaneous deliveries of the same key would both pass it
    // and race to the unique index. Re-checking after the lock closes that
    // window for same-request duplicates: the loser waits on the row lock, and
    // by the time it proceeds the winner's action is committed and visible.
    const locked = await findActionByKey(client, tenantId, input.idempotencyKey);
    if (locked) {
        return replayOf(locked)!;
    }

    const ctx: HandlerContext = {
        client,
        request,
        config,
        tenantId,
        actorIdentityId: input.actorIdentityId,
        payload,
        effectiveAt,
        idempotencyKey: input.idempotencyKey
    };

    // The handler's work is undoable as a unit: if the idempotency backstop
    // fires at persist time, nothing it did may survive.
    await client.query("SAVEPOINT operational_action");

    // Terminal states are never reopened by G4.
    let result: HandlerResult;
    if (MUTATING_ACTIONS.has(actionType) && isTerminal(request.state)) {
        result = refuse(
            "INVALID_PREDECESSOR_STATE",
            `service request is terminal (${request.state}) and cannot be mutated`
        );
    } else {
        result = await HANDLERS[actionType](ctx);
    }

    let actionId: string;
    await client.query("SAVEPOINT operational_action_persist");
    try {
        actionId = await persistAction(client, {
            tenantId,
            marketId: input.marketId,
            requestId: input.requestId,
            actionType,
            outcome: result.accepted ? "ACCEPTED" : "REFUSED",
            reasonCode: result.accepted ? null : result.reasonCode,
            fromState: result.accepted ? result.fromState : request.state,
            toState: result.accepted ? result.toState : null,
            actorIdentityId: input.actorIdentityId,
            actorRole: result.actor.role,
            actorAuthority: result.actor.authority,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            payload: result.accepted ? result.detail : { refusal: result.message }
        });
        await client.query("RELEASE SAVEPOINT operational_action_persist");
    } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT operational_action_persist");
        if (!isUniqueViolation(err)) {
            throw err;
        }
        // The database backstop fired: another transaction claimed this key
        // between our check and our insert. Undo everything this call did and
        // return the winner's decision instead of a raw driver error.
        await client.query("ROLLBACK TO SAVEPOINT operational_action");
        const winner = await findActionByKey(client, tenantId, input.idempotencyKey);
        if (winner) {
            return replayOf(winner)!;
        }
        return {
            ok: false,
            actionId: null,
            actionType,
            reasonCode: "IDEMPOTENCY_CONFLICT",
            message: `idempotency key ${input.idempotencyKey} is already in use`,
            replayed: false
        };
    }

    if (!result.accepted) {
        return {
            ok: false,
            actionId,
            actionType,
            reasonCode: result.reasonCode,
            message: result.message,
            replayed: false
        };
    }
    return {
        ok: true,
        actionId,
        actionType,
        fromState: result.fromState,
        toState: result.toState,
        replayed: false,
        detail: result.detail
    };
}

// =============================================================================
// Authority helpers
// =============================================================================

async function ownerActor(ctx: HandlerContext): Promise<Actor | { refusal: HandlerResult }> {
    if (!ctx.actorIdentityId) {
        return { refusal: refuse("AUTHORITY_REFUSED", "this action requires an owner identity") };
    }
    const authorized = await authorizeOwnerAssignment(
        ctx.client,
        ctx.actorIdentityId,
        ctx.request.marketId
    );
    if (!authorized.ok) {
        return { refusal: refuse("AUTHORITY_REFUSED", authorized.message) };
    }
    return authorized.value;
}

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "23505"
    );
}

function isRefusal(v: unknown): v is { refusal: HandlerResult } {
    return typeof v === "object" && v !== null && "refusal" in v;
}

async function transition(
    ctx: HandlerContext,
    to: ServiceRequestState,
    actor: Actor,
    suffix: string,
    governingRef?: string
): Promise<{ ok: true } | { ok: false; result: HandlerResult }> {
    const moved = await transitionRequest(ctx.client, {
        requestId: ctx.request.requestId,
        expectedFrom: ctx.request.state,
        to,
        actor,
        idempotencyKey: `${ctx.idempotencyKey}:${suffix}`,
        governingRef: governingRef ?? null
    });
    if (!moved.ok) {
        return {
            ok: false,
            result: refuse(
                moved.code === "INVALID_TRANSITION"
                    ? "INVALID_PREDECESSOR_STATE"
                    : "STALE_OPERATIONAL_CONTEXT",
                moved.message,
                actor
            )
        };
    }
    return { ok: true };
}

// =============================================================================
// Handlers
// =============================================================================

const HANDLERS: Record<OperationalActionType, (ctx: HandlerContext) => Promise<HandlerResult>> = {
    DISPATCH_PROVIDER: async (ctx) => {
        const providerId = ctx.payload["providerId"];
        if (!isUuid(providerId)) {
            return refuse("CORRELATION_REQUIRED", "providerId is required and must be a UUID");
        }
        // Dispatch may be owner-initiated or automated. An automated dispatch
        // carries no identity and is attributed to SYSTEM.
        let actor: Actor = SYSTEM_ACTOR;
        if (ctx.actorIdentityId) {
            const owner = await ownerActor(ctx);
            if (isRefusal(owner)) return owner.refusal;
            actor = owner;
        }
        if (ctx.request.state !== "PENDING_ACCEPTANCE") {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `dispatch requires PENDING_ACCEPTANCE, found ${ctx.request.state}`,
                actor
            );
        }
        const provider = await loadProvider(ctx.client, providerId);
        if (!provider || provider.marketId !== ctx.request.marketId || !isDispatchable(provider)) {
            return refuse(
                "PROVIDER_NO_LONGER_ELIGIBLE",
                `provider ${providerId} is not approved supply in this market`,
                actor
            );
        }

        const timeout = ctx.config.dispatch.acceptanceTimeoutMinutes;
        const attempt = await openAttempt(
            ctx.client,
            {
                requestId: ctx.request.requestId,
                providerId,
                marketId: ctx.request.marketId,
                offeredAt: ctx.effectiveAt,
                expiresAt: new Date(ctx.effectiveAt.getTime() + timeout * 60_000)
            },
            actor,
            ctx.idempotencyKey
        );

        const moved = await transition(
            ctx,
            "PROVIDER_DISPATCHED",
            actor,
            "request",
            `attempt:${attempt.attemptId}`
        );
        if (!moved.ok) return moved.result;

        return {
            accepted: true,
            actor,
            fromState: "PENDING_ACCEPTANCE",
            toState: "PROVIDER_DISPATCHED",
            detail: {
                attemptId: attempt.attemptId,
                attemptVersion: attempt.attemptVersion,
                providerId,
                expiresAt: attempt.expiresAt.toISOString()
            }
        };
    },

    EXPIRE_DISPATCH: async (ctx) => {
        const actor = SYSTEM_ACTOR;
        const attemptId = ctx.payload["attemptId"];
        const attempt = isUuid(attemptId)
            ? await loadAttempt(ctx.client, attemptId, true)
            : await currentAttempt(ctx.client, ctx.request.requestId);
        if (!attempt || attempt.requestId !== ctx.request.requestId) {
            return refuse("CORRELATION_REQUIRED", "no dispatch attempt to expire", actor);
        }
        if (attempt.state !== "OFFERED") {
            return refuse(
                "STALE_OPERATIONAL_CONTEXT",
                `dispatch attempt is ${attempt.state}, not open`,
                actor
            );
        }
        if (ctx.effectiveAt < attempt.expiresAt) {
            return refuse(
                "STALE_OPERATIONAL_CONTEXT",
                "dispatch attempt has not yet expired",
                actor
            );
        }

        const decided = await decideAttempt(
            ctx.client,
            attempt,
            "EXPIRED",
            ctx.effectiveAt,
            null,
            actor,
            `${ctx.idempotencyKey}:attempt`
        );
        if (!decided) {
            return refuse("STALE_DISPATCH_RESPONSE", "attempt was decided concurrently", actor);
        }

        const moved = await transition(
            ctx,
            "PENDING_ACCEPTANCE",
            actor,
            "request",
            `attempt:${attempt.attemptId}`
        );
        if (!moved.ok) return moved.result;

        // Expiry enters governed recovery and returns the request to the pool.
        // It never manufactures an acceptance.
        const recovery = await openRecovery(
            ctx.client,
            {
                tenantId: ctx.tenantId,
                marketId: ctx.request.marketId,
                requestId: ctx.request.requestId,
                triggerReason: "DISPATCH_EXPIRED",
                payload: { attemptId: attempt.attemptId }
            },
            actor,
            `${ctx.idempotencyKey}:recovery`
        );
        if (recovery.ok) {
            await resolveRecovery(
                ctx.client,
                recovery.value.recoveryId,
                "RECOVERED_WITHIN_COMMITMENT",
                "returned to dispatch pool; commercial commitment unchanged",
                actor,
                `${ctx.idempotencyKey}:recovery:resolve`
            );
        }

        return {
            accepted: true,
            actor,
            fromState: "PROVIDER_DISPATCHED",
            toState: "PENDING_ACCEPTANCE",
            detail: { attemptId: attempt.attemptId, reason: "DISPATCH_EXPIRED" }
        };
    },

    RECORD_PROVIDER_ACCEPTANCE: (ctx) => respondToAttempt(ctx, "ACCEPT"),
    RECORD_PROVIDER_REJECTION: (ctx) => respondToAttempt(ctx, "REJECT"),

    ASSIGN_PROVIDER: async (ctx) => {
        const owner = await ownerActor(ctx);
        if (isRefusal(owner)) return owner.refusal;
        const actor = owner;

        if (ctx.request.state !== "PROVIDER_ACCEPTED") {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `assignment requires PROVIDER_ACCEPTED, found ${ctx.request.state}`,
                actor
            );
        }
        const attemptId = ctx.payload["attemptId"];
        if (!isUuid(attemptId)) {
            return refuse("CORRELATION_REQUIRED", "attemptId is required", actor);
        }
        const attempt = await loadAttempt(ctx.client, attemptId);
        if (!attempt || attempt.requestId !== ctx.request.requestId) {
            return refuse("CORRELATION_REQUIRED", "attempt does not belong to this request", actor);
        }
        if (attempt.state !== "ACCEPTED") {
            return refuse(
                "STALE_DISPATCH_RESPONSE",
                `cannot assign from an attempt in state ${attempt.state}`,
                actor
            );
        }
        const provider = await loadProvider(ctx.client, attempt.providerId);
        if (!provider || !isDispatchable(provider)) {
            return refuse(
                "PROVIDER_NO_LONGER_ELIGIBLE",
                "the accepted provider is no longer approved supply",
                actor
            );
        }

        const assigned = await assignProvider(
            ctx.client,
            {
                requestId: ctx.request.requestId,
                providerId: attempt.providerId,
                attemptId: attempt.attemptId,
                marketId: ctx.request.marketId,
                assignedByIdentityId: ctx.actorIdentityId!,
                replaceExisting: false
            },
            actor,
            ctx.idempotencyKey
        );
        if (!assigned.ok) {
            return refuse("ASSIGNMENT_CONFLICT", "this request already has an active assignment", actor);
        }

        const moved = await transition(
            ctx,
            "OWNER_ASSIGNED",
            actor,
            "request",
            `assignment:${assigned.assignment.assignmentId}`
        );
        if (!moved.ok) return moved.result;

        return {
            accepted: true,
            actor,
            fromState: "PROVIDER_ACCEPTED",
            toState: "OWNER_ASSIGNED",
            detail: {
                assignmentId: assigned.assignment.assignmentId,
                assignmentVersion: assigned.assignment.assignmentVersion,
                providerId: attempt.providerId
            }
        };
    },

    REASSIGN_PROVIDER: async (ctx) => {
        const owner = await ownerActor(ctx);
        if (isRefusal(owner)) return owner.refusal;
        const actor = owner;

        const allowed: ServiceRequestState[] = [
            "OWNER_ASSIGNED",
            "AWAITING_CUSTOMER_CONFIRMATION",
            "CUSTOMER_CONFIRMED"
        ];
        if (!allowed.includes(ctx.request.state)) {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `reassignment requires an assigned request, found ${ctx.request.state}`,
                actor
            );
        }
        const providerId = ctx.payload["providerId"];
        if (!isUuid(providerId)) {
            return refuse("CORRELATION_REQUIRED", "providerId is required", actor);
        }
        const provider = await loadProvider(ctx.client, providerId);
        if (!provider || provider.marketId !== ctx.request.marketId || !isDispatchable(provider)) {
            return refuse("PROVIDER_NO_LONGER_ELIGIBLE", "replacement provider is not approved", actor);
        }
        const existing = await activeAssignment(ctx.client, ctx.request.requestId, true);
        if (!existing) {
            return refuse("ASSIGNMENT_SUPERSEDED", "no active assignment to replace", actor);
        }

        const assigned = await assignProvider(
            ctx.client,
            {
                requestId: ctx.request.requestId,
                providerId,
                attemptId: existing.attemptId,
                marketId: ctx.request.marketId,
                assignedByIdentityId: ctx.actorIdentityId!,
                replaceExisting: true
            },
            actor,
            ctx.idempotencyKey
        );
        if (!assigned.ok) {
            return refuse("ASSIGNMENT_CONFLICT", "assignment changed concurrently", actor);
        }

        // Consent was given against the previous assignment and does not carry.
        await supersedeLiveContext(
            ctx.client,
            ctx.request.requestId,
            ctx.request.marketId,
            actor,
            ctx.idempotencyKey
        );

        let toState: string = ctx.request.state;
        if (ctx.request.state === "CUSTOMER_CONFIRMED") {
            const moved = await transition(
                ctx,
                "AWAITING_CUSTOMER_CONFIRMATION",
                actor,
                "request",
                `assignment:${assigned.assignment.assignmentId}`
            );
            if (!moved.ok) return moved.result;
            toState = "AWAITING_CUSTOMER_CONFIRMATION";
        }

        return {
            accepted: true,
            actor,
            fromState: ctx.request.state,
            toState,
            detail: {
                assignmentId: assigned.assignment.assignmentId,
                assignmentVersion: assigned.assignment.assignmentVersion,
                replacedAssignmentId: assigned.replaced?.assignmentId ?? null,
                providerId
            }
        };
    },

    REQUEST_CUSTOMER_CONFIRMATION: async (ctx) => {
        const owner = await ownerActor(ctx);
        if (isRefusal(owner)) return owner.refusal;
        const actor = owner;

        if (ctx.request.state !== "OWNER_ASSIGNED") {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `confirmation may only be requested from OWNER_ASSIGNED, found ${ctx.request.state}`,
                actor
            );
        }
        const assignment = await activeAssignment(ctx.client, ctx.request.requestId);
        if (!assignment) {
            return refuse("ASSIGNMENT_SUPERSEDED", "no active assignment", actor);
        }

        const context = await openContext(
            ctx.client,
            {
                requestId: ctx.request.requestId,
                marketId: ctx.request.marketId,
                assignmentId: assignment.assignmentId,
                commitmentVersion: ctx.request.currentVersion,
                expiresAt: new Date(
                    ctx.effectiveAt.getTime() + ctx.config.offer.validityMinutes * 60_000
                )
            },
            actor,
            ctx.idempotencyKey
        );

        const moved = await transition(
            ctx,
            "AWAITING_CUSTOMER_CONFIRMATION",
            actor,
            "request",
            `context:${context.confirmationId}`
        );
        if (!moved.ok) return moved.result;

        return {
            accepted: true,
            actor,
            fromState: "OWNER_ASSIGNED",
            toState: "AWAITING_CUSTOMER_CONFIRMATION",
            detail: {
                confirmationId: context.confirmationId,
                contextVersion: context.contextVersion,
                commitmentVersion: context.commitmentVersion
            }
        };
    },

    RECORD_CUSTOMER_CONFIRMATION: async (ctx) => {
        if (!ctx.actorIdentityId) {
            return refuse("AUTHORITY_REFUSED", "customer confirmation requires an identity");
        }
        if (ctx.request.state !== "AWAITING_CUSTOMER_CONFIRMATION") {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `confirmation requires AWAITING_CUSTOMER_CONFIRMATION, found ${ctx.request.state}`
            );
        }
        const authorized = await authorizeCustomerConfirmation(
            ctx.client,
            ctx.actorIdentityId,
            ctx.request.marketId,
            ctx.request.requestId
        );
        if (!authorized.ok) {
            return refuse("AUTHORITY_REFUSED", authorized.message);
        }
        const actor = authorized.value;

        const context = await liveContext(ctx.client, ctx.request.requestId, true);
        if (!context || context.status !== "PENDING") {
            return refuse("STALE_CONFIRMATION", "no pending confirmation context", actor);
        }
        const claimedContextVersion = ctx.payload["contextVersion"];
        if (
            typeof claimedContextVersion === "number" &&
            claimedContextVersion !== context.contextVersion
        ) {
            return refuse(
                "CONFIRMATION_SUPERSEDED",
                `confirmation context v${claimedContextVersion} was superseded by v${context.contextVersion}`,
                actor
            );
        }
        if (context.expiresAt && ctx.effectiveAt >= context.expiresAt) {
            return refuse("CONFIRMATION_EXPIRED", "confirmation window elapsed", actor);
        }
        if (context.commitmentVersion !== ctx.request.currentVersion) {
            return refuse(
                "STALE_CONFIRMATION",
                `context is bound to commitment v${context.commitmentVersion} but v${ctx.request.currentVersion} is authoritative`,
                actor
            );
        }
        const assignment = await activeAssignment(ctx.client, ctx.request.requestId);
        if (!assignment || assignment.assignmentId !== context.assignmentId) {
            return refuse(
                "ASSIGNMENT_SUPERSEDED",
                "the assignment this confirmation was bound to is no longer active",
                actor
            );
        }

        const confirmed = await confirmContext(
            ctx.client,
            context,
            ctx.request.marketId,
            ctx.actorIdentityId,
            actor,
            `${ctx.idempotencyKey}:context`
        );
        if (!confirmed) {
            return refuse("STALE_CONFIRMATION", "context changed concurrently", actor);
        }

        const moved = await transition(
            ctx,
            "CUSTOMER_CONFIRMED",
            actor,
            "request",
            `context:${context.confirmationId}`
        );
        if (!moved.ok) return moved.result;

        return {
            accepted: true,
            actor,
            fromState: "AWAITING_CUSTOMER_CONFIRMATION",
            toState: "CUSTOMER_CONFIRMED",
            detail: {
                confirmationId: context.confirmationId,
                contextVersion: context.contextVersion,
                commitmentVersion: context.commitmentVersion
            }
        };
    },

    START_FULFILLMENT: async (ctx) => {
        if (ctx.request.state !== "CUSTOMER_CONFIRMED") {
            return refuse(
                "INVALID_PREDECESSOR_STATE",
                `fulfillment requires CUSTOMER_CONFIRMED, found ${ctx.request.state}`
            );
        }
        const actorOrRefusal = await executionActor(ctx);
        if (isRefusal(actorOrRefusal)) return actorOrRefusal.refusal;
        const actor = actorOrRefusal;

        const assignment = await activeAssignment(ctx.client, ctx.request.requestId);
        if (!assignment) {
            return refuse("ASSIGNMENT_SUPERSEDED", "no active assignment to execute", actor);
        }

        const moved = await transition(
            ctx,
            "FULFILLMENT_ACTIVE",
            actor,
            "request",
            `assignment:${assignment.assignmentId}`
        );
        if (!moved.ok) return moved.result;

        return {
            accepted: true,
            actor,
            fromState: "CUSTOMER_CONFIRMED",
            toState: "FULFILLMENT_ACTIVE",
            detail: { assignmentId: assignment.assignmentId }
        };
    },

    COMPLETE_SERVICE: (ctx) =>
        terminalResult(ctx, "SERVICE_COMPLETED", ["FULFILLMENT_ACTIVE"], "SERVICE_COMPLETED_NORMALLY"),

    MARK_NO_SHOW: (ctx) => {
        const claimed = ctx.payload["reasonCode"];
        const reason =
            claimed === "PROVIDER_NO_SHOW" ? "PROVIDER_NO_SHOW" : "CUSTOMER_NO_SHOW";
        return terminalResult(ctx, "NO_SHOW", ["CUSTOMER_CONFIRMED", "FULFILLMENT_ACTIVE"], reason);
    },

    MARK_UNABLE_TO_FULFILL: (ctx) =>
        terminalResult(
            ctx,
            "UNABLE_TO_FULFILL",
            [
                "PENDING_ACCEPTANCE",
                "PROVIDER_ACCEPTED",
                "OWNER_ASSIGNED",
                "AWAITING_CUSTOMER_CONFIRMATION",
                "CUSTOMER_CONFIRMED",
                "FULFILLMENT_ACTIVE"
            ],
            "UNABLE_TO_RECOVER"
        ),

    CANCEL_SERVICE: async (ctx) => {
        const claimed = ctx.payload["reasonCode"];
        const reason: LifecycleReason =
            claimed === "OWNER_CANCELLED"
                ? "OWNER_CANCELLED"
                : claimed === "POLICY_CANCELLED"
                  ? "POLICY_CANCELLED"
                  : "CUSTOMER_CANCELLED";

        // Customer may cancel their own request; owner may cancel any.
        let actor: Actor | null = null;
        if (ctx.actorIdentityId) {
            const owner = await authorizeOwnerAssignment(
                ctx.client,
                ctx.actorIdentityId,
                ctx.request.marketId
            );
            if (owner.ok) {
                actor = owner.value;
            } else {
                const customer = await authorizeCustomerConfirmation(
                    ctx.client,
                    ctx.actorIdentityId,
                    ctx.request.marketId,
                    ctx.request.requestId
                );
                if (customer.ok) {
                    actor = customer.value;
                }
            }
        }
        if (!actor) {
            return refuse("AUTHORITY_REFUSED", "cancellation requires owner or the customer");
        }

        await withdrawLiveContext(
            ctx.client,
            ctx.request.requestId,
            ctx.request.marketId,
            actor,
            ctx.idempotencyKey
        );
        await revokeActiveAssignment(
            ctx.client,
            ctx.request.requestId,
            ctx.request.marketId,
            actor,
            `${ctx.idempotencyKey}:revoke`
        );
        await releaseAllCapacity(ctx, actor);

        const moved = await transition(ctx, "CANCELLED", actor, "request");
        if (!moved.ok) return moved.result;

        const open = await openRecoveryFor(ctx.client, ctx.request.requestId);
        if (open) {
            await resolveRecovery(
                ctx.client,
                open.recoveryId,
                "CANCELLED",
                "request cancelled during recovery",
                actor,
                `${ctx.idempotencyKey}:recovery`
            );
        }

        return {
            accepted: true,
            actor,
            fromState: ctx.request.state,
            toState: "CANCELLED",
            detail: { reasonCode: reason }
        };
    },

    RECORD_CAPACITY_LOSS: async (ctx) => {
        let actor: Actor = SYSTEM_ACTOR;
        if (ctx.actorIdentityId) {
            const owner = await ownerActor(ctx);
            if (isRefusal(owner)) return owner.refusal;
            actor = owner;
        }
        const providerId = ctx.payload["providerId"];
        if (!isUuid(providerId)) {
            return refuse("CORRELATION_REQUIRED", "providerId is required", actor);
        }

        const recovery = await openRecovery(
            ctx.client,
            {
                tenantId: ctx.tenantId,
                marketId: ctx.request.marketId,
                requestId: ctx.request.requestId,
                triggerReason: "PROVIDER_CAPACITY_LOST",
                payload: { providerId }
            },
            actor,
            `${ctx.idempotencyKey}:recovery`
        );
        if (!recovery.ok) {
            return refuse("STALE_OPERATIONAL_CONTEXT", recovery.message, actor);
        }

        const withdrawn = await withdrawProviderCapacity(
            ctx.client,
            ctx.request.requestId,
            providerId,
            ctx.request.marketId,
            actor,
            `${ctx.idempotencyKey}:withdraw`
        );

        // The commitment is NOT erased. The Service Request keeps its state and
        // its commercial version; only capacity was released.
        return {
            accepted: true,
            actor,
            fromState: ctx.request.state,
            toState: ctx.request.state,
            detail: {
                recoveryId: recovery.value.recoveryId,
                releasedHoldIds: withdrawn.ok ? withdrawn.value.releasedHoldIds : [],
                customerCommitmentAffected: withdrawn.ok
                    ? withdrawn.value.customerCommitmentAffected
                    : false,
                commitmentPreserved: true
            }
        };
    },

    INITIATE_OPERATIONAL_RECOVERY: async (ctx) => {
        let actor: Actor = SYSTEM_ACTOR;
        if (ctx.actorIdentityId) {
            const owner = await ownerActor(ctx);
            if (isRefusal(owner)) return owner.refusal;
            actor = owner;
        }
        const trigger = ctx.payload["triggerReason"];
        const recovery = await openRecovery(
            ctx.client,
            {
                tenantId: ctx.tenantId,
                marketId: ctx.request.marketId,
                requestId: ctx.request.requestId,
                triggerReason: typeof trigger === "string" ? trigger : "MANUAL",
                payload: ctx.payload
            },
            actor,
            `${ctx.idempotencyKey}:recovery`
        );
        if (!recovery.ok) {
            return refuse("STALE_OPERATIONAL_CONTEXT", recovery.message, actor);
        }
        return {
            accepted: true,
            actor,
            fromState: ctx.request.state,
            toState: ctx.request.state,
            detail: { recoveryId: recovery.value.recoveryId }
        };
    }
};

// =============================================================================
// Shared handler bodies
// =============================================================================

async function respondToAttempt(
    ctx: HandlerContext,
    decision: "ACCEPT" | "REJECT"
): Promise<HandlerResult> {
    if (!ctx.actorIdentityId) {
        return refuse("AUTHORITY_REFUSED", "a provider response requires an identity");
    }
    const attemptId = ctx.payload["attemptId"];
    if (!isUuid(attemptId)) {
        return refuse("CORRELATION_REQUIRED", "attemptId is required to bind a response");
    }
    const attempt = await loadAttempt(ctx.client, attemptId, true);
    if (!attempt || attempt.requestId !== ctx.request.requestId) {
        return refuse("CORRELATION_REQUIRED", "attempt does not belong to this request");
    }

    // Exact-current semantics: only the newest open attempt may bind.
    if (attempt.state === "SUPERSEDED") {
        return refuse("DISPATCH_SUPERSEDED", "this dispatch attempt was superseded");
    }
    if (attempt.state === "EXPIRED") {
        return refuse("DISPATCH_EXPIRED", "this dispatch attempt expired");
    }
    if (attempt.state !== "OFFERED") {
        return refuse("STALE_DISPATCH_RESPONSE", `attempt is already ${attempt.state}`);
    }
    const current = await currentAttempt(ctx.client, ctx.request.requestId);
    if (!current || current.attemptId !== attempt.attemptId) {
        return refuse("STALE_DISPATCH_RESPONSE", "a newer dispatch attempt is current");
    }
    if (ctx.effectiveAt >= attempt.expiresAt) {
        return refuse("DISPATCH_EXPIRED", "the acceptance window has closed");
    }
    if (ctx.request.state !== "PROVIDER_DISPATCHED") {
        return refuse(
            "INVALID_PREDECESSOR_STATE",
            `expected PROVIDER_DISPATCHED, found ${ctx.request.state}`
        );
    }

    const authorized = await authorizeProviderResponse(
        ctx.client,
        ctx.actorIdentityId,
        ctx.request.marketId,
        attempt.providerId
    );
    if (!authorized.ok) {
        return refuse("AUTHORITY_REFUSED", authorized.message);
    }
    const actor = authorized.value;

    const terminal = decision === "ACCEPT" ? "ACCEPTED" : "DECLINED";
    const decided = await decideAttempt(
        ctx.client,
        attempt,
        terminal,
        ctx.effectiveAt,
        ctx.actorIdentityId,
        actor,
        `${ctx.idempotencyKey}:attempt`
    );
    if (!decided) {
        return refuse("STALE_DISPATCH_RESPONSE", "attempt was decided concurrently", actor);
    }

    const target: ServiceRequestState =
        decision === "ACCEPT" ? "PROVIDER_ACCEPTED" : "PENDING_ACCEPTANCE";
    const moved = await transition(ctx, target, actor, "request", `attempt:${attempt.attemptId}`);
    if (!moved.ok) return moved.result;

    if (decision === "REJECT") {
        const recovery = await openRecovery(
            ctx.client,
            {
                tenantId: ctx.tenantId,
                marketId: ctx.request.marketId,
                requestId: ctx.request.requestId,
                triggerReason: "DISPATCH_REJECTED",
                payload: { attemptId: attempt.attemptId }
            },
            actor,
            `${ctx.idempotencyKey}:recovery`
        );
        if (recovery.ok) {
            await resolveRecovery(
                ctx.client,
                recovery.value.recoveryId,
                "RECOVERED_WITHIN_COMMITMENT",
                "provider declined; returned to dispatch pool",
                actor,
                `${ctx.idempotencyKey}:recovery:resolve`
            );
        }
    }

    return {
        accepted: true,
        actor,
        fromState: "PROVIDER_DISPATCHED",
        toState: target,
        detail: {
            attemptId: attempt.attemptId,
            attemptVersion: attempt.attemptVersion,
            decision: terminal
        }
    };
}

/** Owner, or the provider currently assigned to execute the work. */
async function executionActor(
    ctx: HandlerContext
): Promise<Actor | { refusal: HandlerResult }> {
    if (!ctx.actorIdentityId) {
        return { refusal: refuse("AUTHORITY_REFUSED", "execution requires an identity") };
    }
    const owner = await authorizeOwnerAssignment(
        ctx.client,
        ctx.actorIdentityId,
        ctx.request.marketId
    );
    if (owner.ok) {
        return owner.value;
    }
    const assignment = await activeAssignment(ctx.client, ctx.request.requestId);
    if (assignment) {
        const provider = await authorizeProviderResponse(
            ctx.client,
            ctx.actorIdentityId,
            ctx.request.marketId,
            assignment.providerId
        );
        if (provider.ok) {
            return provider.value;
        }
    }
    const identity = await loadIdentity(ctx.client, ctx.actorIdentityId);
    return {
        refusal: refuse(
            "AUTHORITY_REFUSED",
            `identity ${ctx.actorIdentityId}${identity ? "" : " (unknown)"} may not execute this request`
        )
    };
}

async function releaseAllCapacity(ctx: HandlerContext, actor: Actor): Promise<string[]> {
    const released: string[] = [];
    for (const hold of await activeHoldsForRequest(ctx.client, ctx.request.requestId)) {
        const outcome = await releaseCapacity(
            ctx.client,
            hold.holdId,
            ctx.request.marketId,
            actor,
            `${ctx.idempotencyKey}:release:${hold.holdId}`
        );
        if (outcome.ok) {
            released.push(hold.holdId);
        }
    }
    return released;
}

/** Shared body for the three terminal operational results. */
async function terminalResult(
    ctx: HandlerContext,
    target: Extract<
        ServiceRequestState,
        "SERVICE_COMPLETED" | "NO_SHOW" | "UNABLE_TO_FULFILL"
    >,
    allowedFrom: ServiceRequestState[],
    reason: LifecycleReason
): Promise<HandlerResult> {
    const owner = await ownerActor(ctx);
    if (isRefusal(owner)) return owner.refusal;
    const actor = owner;

    if (!allowedFrom.includes(ctx.request.state)) {
        return refuse(
            "INVALID_PREDECESSOR_STATE",
            `${target} requires one of [${allowedFrom.join(", ")}], found ${ctx.request.state}`,
            actor
        );
    }

    const moved = await transition(ctx, target, actor, "request");
    if (!moved.ok) return moved.result;

    await ctx.client.query(
        `INSERT INTO core_fulfillment (request_id, result, recorded_by_identity_id, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id) DO NOTHING`,
        [ctx.request.requestId, target, ctx.actorIdentityId, reason]
    );

    const released = await releaseAllCapacity(ctx, actor);

    const open = await openRecoveryFor(ctx.client, ctx.request.requestId);
    if (open && target === "UNABLE_TO_FULFILL") {
        await resolveRecovery(
            ctx.client,
            open.recoveryId,
            "TERMINAL_UNABLE_TO_FULFILL",
            reason,
            actor,
            `${ctx.idempotencyKey}:recovery`
        );
    }

    const version = await loadCurrentVersion(ctx.client, ctx.request.requestId);

    return {
        accepted: true,
        actor,
        fromState: ctx.request.state,
        toState: target,
        detail: {
            result: target,
            reasonCode: reason,
            releasedHoldIds: released,
            commitmentVersion: version?.version ?? null
        }
    };
}
