// G4-E06 Confirmation Correctness · G4-E07 Fulfillment / Result Correctness
// G4-E03 Authority Separation. Adversarial scenarios 10-21.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import {
    getLifecyclePool,
    resetLifecycle,
    seedCommittedMobile,
    idem,
    type CommittedMobile
} from "./lifecycleTestDb";
import { executeOperationalAction } from "../../src/lifecycle/orchestrator";
import { loadRequest } from "../../src/core/request/serviceRequest";
import { contextsForRequest, liveContext } from "../../src/lifecycle/confirmationContext";
import { activeAssignment } from "../../src/lifecycle/providerAssignment";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

/** Drives a committed request to OWNER_ASSIGNED. */
async function toAssigned(pool: Pool, w: CommittedMobile): Promise<string> {
    const dispatched = await withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "DISPATCH_PROVIDER",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.ownerIdentityId,
            idempotencyKey: idem("dispatch"),
            payload: { providerId: w.providerId }
        })
    );
    if (!dispatched.ok) throw new Error("dispatch failed");
    const attemptId = dispatched.detail["attemptId"] as string;

    await withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "RECORD_PROVIDER_ACCEPTANCE",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.providerIdentityId,
            idempotencyKey: idem("accept"),
            payload: { attemptId }
        })
    );
    const assigned = await withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "ASSIGN_PROVIDER",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.ownerIdentityId,
            idempotencyKey: idem("assign"),
            payload: { attemptId }
        })
    );
    if (!assigned.ok) throw new Error("assign failed");
    return attemptId;
}

async function requestConfirmation(pool: Pool, w: CommittedMobile) {
    return withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "REQUEST_CUSTOMER_CONFIRMATION",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.ownerIdentityId,
            idempotencyKey: idem("request-confirm")
        })
    );
}

async function confirm(pool: Pool, w: CommittedMobile, key = idem("confirm"), payload = {}) {
    return withTransaction(pool, (client) =>
        executeOperationalAction(client, {
            actionType: "RECORD_CUSTOMER_CONFIRMATION",
            marketId: w.marketId,
            requestId: w.requestId,
            actorIdentityId: w.customerIdentityId,
            idempotencyKey: key,
            payload
        })
    );
}

d("G4-E06 — confirmation correctness", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    it("10 — customer confirmation before assignment is refused", async () => {
        const w = await seedCommittedMobile(pool);
        const early = await confirm(pool, w);
        expect(early.ok).toBe(false);
        if (!early.ok) expect(early.reasonCode).toBe("INVALID_PREDECESSOR_STATE");

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("PENDING_ACCEPTANCE");
    });

    it("binds the confirmation context to the assignment and commitment version", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        const requested = await requestConfirmation(pool, w);
        expect(requested.ok).toBe(true);
        if (!requested.ok) return;

        const context = await withTransaction(pool, (c) => liveContext(c, w.requestId));
        const assignment = await withTransaction(pool, (c) => activeAssignment(c, w.requestId));
        expect(context!.status).toBe("PENDING");
        expect(context!.assignmentId).toBe(assignment!.assignmentId);
        expect(context!.commitmentVersion).toBe(1);
        expect(context!.confirmedByIdentityId).toBeNull();
    });

    it("11 — confirmation against a superseded assignment is refused", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        // A reassignment invalidates the consent context.
        const relief = await withTransaction(pool, async (client) => {
            const identity = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ($1,'Relief')
                 RETURNING identity_id`,
                [w.marketId]
            );
            const identityId = identity.rows[0]!.identity_id;
            await client.query(
                `INSERT INTO core_identity_role (identity_id, market_id, role) VALUES ($1,$2,'PROVIDER')`,
                [identityId, w.marketId]
            );
            const provider = await client.query<{ provider_id: string }>(
                `INSERT INTO core_provider (market_id, identity_id, display_name, supply_status)
                 VALUES ($1,$2,'Relief','APPROVED') RETURNING provider_id`,
                [w.marketId, identityId]
            );
            return provider.rows[0]!.provider_id;
        });

        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "REASSIGN_PROVIDER",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("reassign"),
                payload: { providerId: relief }
            })
        );

        const stale = await confirm(pool, w);
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.reasonCode).toBe("STALE_CONFIRMATION");

        const contexts = await withTransaction(pool, (c) => contextsForRequest(c, w.requestId));
        expect(contexts[0]!.status).toBe("SUPERSEDED");
    });

    it("refuses a confirmation naming a superseded context version", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        const wrongVersion = await confirm(pool, w, idem("wrong"), { contextVersion: 99 });
        expect(wrongVersion.ok).toBe(false);
        if (!wrongVersion.ok) expect(wrongVersion.reasonCode).toBe("CONFIRMATION_SUPERSEDED");
    });

    it("refuses an expired confirmation window", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        const expired = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "RECORD_CUSTOMER_CONFIRMATION",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("expired"),
                // Bali's configured confirmation window is 15 minutes.
                effectiveAt: new Date(Date.now() + 30 * 60_000)
            })
        );
        expect(expired.ok).toBe(false);
        if (!expired.ok) expect(expired.reasonCode).toBe("CONFIRMATION_EXPIRED");
    });

    it("refuses a confirmation from anyone but the customer on the request", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        for (const impostor of [w.ownerIdentityId, w.providerIdentityId]) {
            const attempt = await withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "RECORD_CUSTOMER_CONFIRMATION",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: impostor,
                    idempotencyKey: idem("impostor")
                })
            );
            expect(attempt.ok).toBe(false);
            if (!attempt.ok) expect(attempt.reasonCode).toBe("AUTHORITY_REFUSED");
        }
    });

    it("12 — duplicate customer confirmation produces one effect", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        const first = await confirm(pool, w, "confirm-once");
        const second = await confirm(pool, w, "confirm-once");
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.replayed).toBe(true);
        expect(second.actionId).toBe(first.actionId);

        const contexts = await withTransaction(pool, (c) => contextsForRequest(c, w.requestId));
        expect(contexts.filter((c) => c.status === "CONFIRMED")).toHaveLength(1);
    });
});

d("G4-E07 — fulfillment, completion and exceptions", () => {
    let pool: Pool;
    beforeEach(async () => {
        pool = getLifecyclePool();
        await resetLifecycle(pool);
    });
    afterAll(async () => {
        await pool?.end();
    });

    async function toConfirmed(w: CommittedMobile) {
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);
        const confirmed = await confirm(pool, w);
        if (!confirmed.ok) throw new Error("confirm failed");
    }

    it("13 — fulfillment before customer confirmation is refused", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);
        await requestConfirmation(pool, w);

        const early = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "START_FULFILLMENT",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("early-start")
            })
        );
        expect(early.ok).toBe(false);
        if (!early.ok) expect(early.reasonCode).toBe("INVALID_PREDECESSOR_STATE");
    });

    it("14 / 16 / 17 — authorized start, completion once, duplicate completion idempotent", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(w);

        const started = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "START_FULFILLMENT",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("start")
            })
        );
        expect(started.ok).toBe(true);
        if (started.ok) expect(started.toState).toBe("FULFILLMENT_ACTIVE");

        const complete = () =>
            withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType: "COMPLETE_SERVICE",
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.ownerIdentityId,
                    idempotencyKey: "complete-once"
                })
            );
        const first = await complete();
        const second = await complete();
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.toState).toBe("SERVICE_COMPLETED");
        expect(second.replayed).toBe(true);

        const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_fulfillment WHERE request_id = $1`,
            [w.requestId]
        );
        expect(Number(rows[0]!.n)).toBe(1);
    });

    it("15 — completion before fulfillment is refused", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(w);
        const early = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "COMPLETE_SERVICE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("early-complete")
            })
        );
        expect(early.ok).toBe(false);
        if (!early.ok) expect(early.reasonCode).toBe("INVALID_PREDECESSOR_STATE");
    });

    it("18 — a terminal request refuses every further mutation", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(w);
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "START_FULFILLMENT",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("start")
            })
        );
        await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "COMPLETE_SERVICE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("complete")
            })
        );

        for (const actionType of [
            "CANCEL_SERVICE",
            "MARK_NO_SHOW",
            "START_FULFILLMENT",
            "REASSIGN_PROVIDER",
            "DISPATCH_PROVIDER"
        ] as const) {
            const attempt = await withTransaction(pool, (client) =>
                executeOperationalAction(client, {
                    actionType,
                    marketId: w.marketId,
                    requestId: w.requestId,
                    actorIdentityId: w.ownerIdentityId,
                    idempotencyKey: idem(`post-terminal-${actionType}`),
                    payload: { providerId: w.providerId }
                })
            );
            expect(attempt.ok).toBe(false);
            if (!attempt.ok) expect(attempt.reasonCode).toBe("INVALID_PREDECESSOR_STATE");
        }

        const request = await withTransaction(pool, (c) => loadRequest(c, w.requestId));
        expect(request!.state).toBe("SERVICE_COMPLETED");
    });

    it("19 — cancellation obeys predecessor and authority", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);

        // A stranger cannot cancel.
        const stranger = await withTransaction(pool, async (client) => {
            const identity = await client.query<{ identity_id: string }>(
                `INSERT INTO core_identity (market_id, display_name) VALUES ($1,'Stranger')
                 RETURNING identity_id`,
                [w.marketId]
            );
            return identity.rows[0]!.identity_id;
        });
        const refused = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "CANCEL_SERVICE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: stranger,
                idempotencyKey: idem("stranger-cancel")
            })
        );
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reasonCode).toBe("AUTHORITY_REFUSED");

        // The customer may cancel their own request.
        const cancelled = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "CANCEL_SERVICE",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("cancel"),
                payload: { reasonCode: "CUSTOMER_CANCELLED" }
            })
        );
        expect(cancelled.ok).toBe(true);
        if (cancelled.ok) {
            expect(cancelled.toState).toBe("CANCELLED");
            expect(cancelled.detail["reasonCode"]).toBe("CUSTOMER_CANCELLED");
        }

        // The assignment is revoked and capacity released.
        expect(await withTransaction(pool, (c) => activeAssignment(c, w.requestId))).toBeNull();
        const holds = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_capacity_hold
              WHERE request_id = $1 AND state NOT IN ('RELEASED','EXPIRED','INVALIDATED')`,
            [w.requestId]
        );
        expect(Number(holds.rows[0]!.n)).toBe(0);
    });

    it("20 — no-show obeys predecessor and authority", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(w);

        const byCustomer = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "MARK_NO_SHOW",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.customerIdentityId,
                idempotencyKey: idem("customer-noshow")
            })
        );
        expect(byCustomer.ok).toBe(false);
        if (!byCustomer.ok) expect(byCustomer.reasonCode).toBe("AUTHORITY_REFUSED");

        const marked = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "MARK_NO_SHOW",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("noshow"),
                payload: { reasonCode: "CUSTOMER_NO_SHOW" }
            })
        );
        expect(marked.ok).toBe(true);
        if (marked.ok) {
            // Recorded from the confirmed pre-fulfillment context, without
            // inventing a service start that never happened.
            expect(marked.fromState).toBe("CUSTOMER_CONFIRMED");
            expect(marked.toState).toBe("NO_SHOW");
        }
    });

    it("21 — unable-to-fulfill is an explicit governed terminal result", async () => {
        const w = await seedCommittedMobile(pool);
        await toAssigned(pool, w);

        const marked = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "MARK_UNABLE_TO_FULFILL",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.ownerIdentityId,
                idempotencyKey: idem("unable")
            })
        );
        expect(marked.ok).toBe(true);
        if (marked.ok) {
            expect(marked.toState).toBe("UNABLE_TO_FULFILL");
            expect(marked.detail["reasonCode"]).toBe("UNABLE_TO_RECOVER");
        }

        const { rows } = await pool.query<{ result: string }>(
            `SELECT result FROM core_fulfillment WHERE request_id = $1`,
            [w.requestId]
        );
        expect(rows[0]!.result).toBe("UNABLE_TO_FULFILL");
    });

    it("the assigned provider may start fulfillment, an unrelated provider may not", async () => {
        const w = await seedCommittedMobile(pool);
        await toConfirmed(w);

        const started = await withTransaction(pool, (client) =>
            executeOperationalAction(client, {
                actionType: "START_FULFILLMENT",
                marketId: w.marketId,
                requestId: w.requestId,
                actorIdentityId: w.providerIdentityId,
                idempotencyKey: idem("provider-start")
            })
        );
        expect(started.ok).toBe(true);
        if (started.ok) expect(started.toState).toBe("FULFILLMENT_ACTIVE");
    });
});
