// G2-E09 — Versioned Amendment sub-record.
//
// The invariant under test throughout: "Existing commitment remains
// authoritative until a replacement is validly adopted." Every assertion about
// `current_version` is really an assertion about that rule.
//
// G2R-01 adds the durable-proposal binding proofs, including the exact
// substitution DTS demonstrated (propose Oct 5, validate Oct 20).

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { getCorePool, resetCore, seedWorld, windowStartingInHours, idemKey } from "./coreTestDb";
import {
    createServiceRequest,
    loadCurrentVersion,
    loadRequest
} from "../../src/core/request/serviceRequest";
import {
    applyAmendment,
    loadAmendment,
    proposeAmendment,
    rejectAmendment,
    validateAmendment
} from "../../src/core/request/amendment";
import {
    canonicalProposalJson,
    normalizeProposal,
    proposalHash
} from "../../src/core/request/amendmentProposal";
import { offerDispatch, respondToOffer } from "../../src/core/dispatch/dispatchOffer";
import { assignRequest, requestCustomerConfirmation } from "../../src/core/dispatch/assignment";
import { confirmBooking, activeConfirmation } from "../../src/core/confirmation/customerConfirmation";
import { holdCapacity } from "../../src/core/capacity/capacity";
import { eventsFor } from "../../src/core/events/eventLog";
import { SYSTEM_ACTOR } from "../../src/core/types";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

// The exact dates from the DTS adversarial probe.
const OCT_5 = new Date("2027-10-05T09:00:00.000Z");
const OCT_20 = new Date("2027-10-20T09:00:00.000Z");

/** Drives a request all the way to CUSTOMER_CONFIRMED with committed capacity. */
async function confirmedBooking(pool: Pool, startHours = 48) {
    return withTransaction(pool, async (client) => {
        const world = await seedWorld(client);
        const startTime = windowStartingInHours(startHours);

        const created = await createServiceRequest(
            client,
            {
                marketId: world.marketId,
                customerIdentityId: world.customerIdentityId,
                serviceId: world.serviceId,
                startTime
            },
            SYSTEM_ACTOR,
            idemKey("create")
        );
        if (!created.ok) throw new Error(created.message);
        const requestId = created.value.requestId;

        await holdCapacity(
            client,
            {
                marketId: world.marketId,
                providerId: world.providerId,
                locationId: "PRIMARY",
                requestId,
                startTime,
                endTime: created.value.endTime
            },
            SYSTEM_ACTOR,
            idemKey("hold")
        );

        const offered = await offerDispatch(
            client,
            { requestId, providerId: world.providerId, marketId: "bali" },
            SYSTEM_ACTOR,
            idemKey("offer")
        );
        if (!offered.ok) throw new Error(offered.message);

        const accepted = await respondToOffer(
            client,
            { offerId: offered.value.offerId, identityId: world.providerIdentityId, decision: "ACCEPT" },
            idemKey("accept")
        );
        if (!accepted.ok) throw new Error(accepted.message);

        const assigned = await assignRequest(
            client,
            { requestId, offerId: offered.value.offerId, identityId: world.ownerIdentityId },
            idemKey("assign")
        );
        if (!assigned.ok) throw new Error(assigned.message);

        await requestCustomerConfirmation(client, requestId, world.ownerIdentityId, idemKey("present"));

        const confirmed = await confirmBooking(
            client,
            { requestId, identityId: world.customerIdentityId, confirmedVersion: 1 },
            idemKey("confirm")
        );
        if (!confirmed.ok) throw new Error(confirmed.message);

        return { world, requestId, startTime, endTime: created.value.endTime };
    });
}

d("G2-E09 — Amendment", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("a proposed amendment does NOT disturb the authoritative commitment", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const before = await loadCurrentVersion(client, requestId);

            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(72),
                    reason: "customer wants a later slot"
                },
                idemKey("propose")
            );
            expect(proposed.ok).toBe(true);
            if (!proposed.ok) return;
            expect(proposed.value.state).toBe("PROPOSED");

            const after = await loadCurrentVersion(client, requestId);
            const request = await loadRequest(client, requestId);
            expect(after!.version).toBe(before!.version);
            expect(after!.startTime.getTime()).toBe(before!.startTime.getTime());
            expect(request!.state).toBe("CUSTOMER_CONFIRMED");
        });
    });

    it("validation writes a candidate version WITHOUT making it authoritative", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(72)
                },
                idemKey("propose")
            );
            expect(proposed.ok).toBe(true);
            if (!proposed.ok) return;

            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            expect(validated.ok).toBe(true);
            if (!validated.ok) return;

            expect(validated.value.candidateVersion).toBe(2);
            expect(validated.value.authoritativeVersion).toBe(1);
            expect(validated.value.requiresReconfirmation).toBe(true);

            // Version 2 exists as a row, but version 1 still governs.
            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);
        });
    });

    it("NO SILENT REPRICE: the price delta is reported, not quietly applied", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newAddonIds: [world.addonId]
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);

            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            expect(validated.ok).toBe(true);
            if (!validated.ok) return;

            expect(validated.value.priceDeltaMinorUnits).toBe(50000);
            expect(validated.value.requiresReconfirmation).toBe(true);

            // The committed price is untouched while the amendment is open.
            const current = await loadCurrentVersion(client, requestId);
            expect(current!.priceMinorUnits).toBe(250000);
        });
    });

    it("adoption moves the authoritative version and forces reconfirmation", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(96)
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);

            expect((await activeConfirmation(client, requestId))?.confirmedVersion).toBe(1);

            const applied = await applyAmendment(
                client,
                proposed.value.amendmentId,
                world.ownerIdentityId,
                idemKey("apply")
            );
            expect(applied.ok).toBe(true);
            if (!applied.ok) return;

            expect(applied.value.adoptedVersion).toBe(2);
            expect(applied.value.reconfirmationRequired).toBe(true);
            expect(applied.value.requestState).toBe("AWAITING_CUSTOMER_CONFIRMATION");
            // The adopted version is traceable to the bound proposal.
            expect(applied.value.proposalHash).toBe(proposed.value.proposalHash);

            expect(await activeConfirmation(client, requestId)).toBeNull();

            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(2);
        });
    });

    it("the customer can reconfirm the adopted version, and only that version", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(120)
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);
            await applyAmendment(client, proposed.value.amendmentId, world.ownerIdentityId, idemKey("apply"));

            const stale = await confirmBooking(
                client,
                { requestId, identityId: world.customerIdentityId, confirmedVersion: 1 },
                idemKey("confirm")
            );
            expect(stale.ok).toBe(false);
            if (!stale.ok) expect(stale.code).toBe("STALE_STATE");

            const fresh = await confirmBooking(
                client,
                { requestId, identityId: world.customerIdentityId, confirmedVersion: 2 },
                idemKey("confirm")
            );
            expect(fresh.ok).toBe(true);
        });
    });

    it("a capacity collision on adoption leaves the committed version authoritative", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const blockedStart = windowStartingInHours(200);

        await withTransaction(pool, async (client) => {
            const blocked = await holdCapacity(
                client,
                {
                    marketId: world.marketId,
                    providerId: world.providerId,
                    locationId: "PRIMARY",
                    startTime: blockedStart,
                    endTime: new Date(blockedStart.getTime() + 4 * 3_600_000)
                },
                SYSTEM_ACTOR,
                idemKey("blocker")
            );
            expect(blocked.ok).toBe(true);
        });

        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: blockedStart
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            if (!validated.ok) throw new Error(validated.message);

            const applied = await applyAmendment(
                client,
                proposed.value.amendmentId,
                world.ownerIdentityId,
                idemKey("apply")
            );
            expect(applied.ok).toBe(false);
            if (!applied.ok) expect(applied.code).toBe("CAPACITY_CONFLICT");

            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);
            const request = await loadRequest(client, requestId);
            expect(request!.state).toBe("CUSTOMER_CONFIRMED");
            expect((await activeConfirmation(client, requestId))?.confirmedVersion).toBe(1);
        });
    });

    it("permits only one open amendment per request", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const first = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_5 },
                idemKey("propose")
            );
            expect(first.ok).toBe(true);

            const second = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_20 },
                idemKey("propose")
            );
            expect(second.ok).toBe(false);
            if (!second.ok) expect(second.code).toBe("AMENDMENT_IN_FLIGHT");
        });
    });

    it("a rejected amendment frees the slot and changes nothing", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const first = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_5 },
                idemKey("propose")
            );
            if (!first.ok) throw new Error(first.message);

            const rejected = await rejectAmendment(
                client,
                first.value.amendmentId,
                world.ownerIdentityId,
                idemKey("reject")
            );
            expect(rejected.ok).toBe(true);

            const current = await loadCurrentVersion(client, requestId);
            expect(current!.version).toBe(1);

            const reopened = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_20 },
                idemKey("propose")
            );
            expect(reopened.ok).toBe(true);
        });
    });
});

d("G2R-01 — durable proposal binding (closes R2 AUDIT_REPLAY_WEAKNESS)", () => {
    let pool: Pool;

    beforeEach(async () => {
        pool = getCorePool();
        await resetCore(pool);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("persists the complete normalized change-set durably at proposal time", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const proposed = await withTransaction(pool, async (client) => {
            const outcome = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: OCT_5,
                    newAddonIds: [world.addonId]
                },
                idemKey("propose")
            );
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.value;
        });

        const stored = await pool.query<{ proposal: unknown; proposal_hash: string }>(
            `SELECT proposal, proposal_hash FROM core_amendment WHERE amendment_id = $1`,
            [proposed.amendmentId]
        );
        const row = stored.rows[0]!;
        expect((row.proposal as Record<string, unknown>)["newStartTime"]).toBe(OCT_5.toISOString());
        expect((row.proposal as Record<string, unknown>)["newAddonIds"]).toEqual([world.addonId]);
        expect(row.proposal_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.proposal_hash).toBe(proposed.proposalHash);
    });

    it("reconstructs the proposal after a transaction restart, with no caller-supplied values", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const proposed = await withTransaction(pool, async (client) => {
            const outcome = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: OCT_5
                },
                idemKey("propose")
            );
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.value;
        });

        // A completely separate connection and transaction.
        await withTransaction(pool, async (client) => {
            const reloaded = await loadAmendment(client, proposed.amendmentId);
            expect(reloaded.ok).toBe(true);
            if (!reloaded.ok) return;
            expect(reloaded.value.proposal.newStartTime).toBe(OCT_5.toISOString());
            expect(reloaded.value.proposalHash).toBe(proposed.proposalHash);
        });
    });

    it("DTS REPRODUCTION: propose Oct 5, validate Oct 20 -> governed refusal", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const proposed = await withTransaction(pool, async (client) => {
            const outcome = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: OCT_5
                },
                idemKey("propose")
            );
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.value;
        });

        // Separate validation transaction, exactly as DTS ran it.
        await withTransaction(pool, async (client) => {
            const substituted = await validateAmendment(
                client,
                proposed.amendmentId,
                idemKey("validate"),
                { newStartTime: OCT_20 }
            );
            expect(substituted.ok).toBe(false);
            if (!substituted.ok) {
                expect(substituted.code).toBe("PROPOSAL_MISMATCH");
                expect(substituted.message).toContain(proposed.proposalHash);
            }
        });

        // Durable proposal still says Oct 5.
        const reloaded = await withTransaction(pool, (c) => loadAmendment(c, proposed.amendmentId));
        expect(reloaded.ok).toBe(true);
        if (reloaded.ok) {
            expect(reloaded.value.proposal.newStartTime).toBe(OCT_5.toISOString());
            expect(reloaded.value.proposalHash).toBe(proposed.proposalHash);
            expect(reloaded.value.state).toBe("PROPOSED");
            expect(reloaded.value.proposedVersionId).toBeNull();
        }

        // No Oct 20 version was manufactured, and none became authoritative.
        const versions = await pool.query<{ version: number; start_time: Date }>(
            `SELECT version, start_time FROM core_service_request_version
              WHERE request_id = $1 ORDER BY version`,
            [requestId]
        );
        expect(versions.rows).toHaveLength(1);
        expect(versions.rows[0]!.version).toBe(1);

        const current = await withTransaction(pool, (c) => loadCurrentVersion(c, requestId));
        expect(current!.version).toBe(1);

        // No conflicting capacity was created.
        const holds = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_capacity_hold WHERE request_id = $1`,
            [requestId]
        );
        expect(Number(holds.rows[0]!.n)).toBe(1);

        // The refusal is auditable.
        const events = await withTransaction(pool, (c) =>
            eventsFor(c, "AMENDMENT", proposed.amendmentId)
        );
        const refusal = events.find((e) => e.to_state === "VALIDATION_REFUSED_PROPOSAL_MISMATCH");
        expect(refusal).toBeDefined();
        expect(refusal!.governing_ref).toContain(proposed.proposalHash);
        expect(world.ownerIdentityId).toBeTruthy();
    });

    it("a substituted add-on set is refused just as a substituted time is", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newAddonIds: [] },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);

            const substituted = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate"),
                { newAddonIds: [world.addonId] }
            );
            expect(substituted.ok).toBe(false);
            if (!substituted.ok) expect(substituted.code).toBe("PROPOSAL_MISMATCH");
        });
    });

    it("distinguishes absent from empty: neither may be substituted for the other", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            // Proposal says nothing about add-ons -> keep the committed set.
            const proposed = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_5 },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            expect(proposed.value.proposal.newAddonIds).toBeNull();

            // Supplying an explicit empty list is a different change-set.
            const substituted = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate"),
                { newStartTime: OCT_5, newAddonIds: [] }
            );
            expect(substituted.ok).toBe(false);
            if (!substituted.ok) expect(substituted.code).toBe("PROPOSAL_MISMATCH");
        });
    });

    it("a mismatch does not consume the amendment — correct validation still succeeds after", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const proposed = await withTransaction(pool, async (client) => {
            const outcome = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_5 },
                idemKey("propose")
            );
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.value;
        });

        await withTransaction(pool, async (client) => {
            const bad = await validateAmendment(client, proposed.amendmentId, idemKey("validate"), {
                newStartTime: OCT_20
            });
            expect(bad.ok).toBe(false);
        });

        await withTransaction(pool, async (client) => {
            const good = await validateAmendment(client, proposed.amendmentId, idemKey("validate"), {
                newStartTime: OCT_5
            });
            expect(good.ok).toBe(true);
            if (good.ok) {
                expect(good.value.candidateVersion).toBe(2);
                expect(good.value.proposalHash).toBe(proposed.proposalHash);
            }
        });
    });

    it("validation with no supplied change-set derives entirely from the durable proposal", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        // Captured once so the assertion compares against the exact instant
        // that was proposed, not a freshly recomputed one.
        const proposedStart = windowStartingInHours(150);

        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: proposedStart
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);

            // No change-set is passed at all — the only possible source is the
            // durable proposal.
            const validated = await validateAmendment(
                client,
                proposed.value.amendmentId,
                idemKey("validate")
            );
            expect(validated.ok).toBe(true);
            if (!validated.ok) return;

            const candidate = await client.query<{ start_time: Date; end_time: Date }>(
                `SELECT start_time, end_time FROM core_service_request_version
                  WHERE request_version_id = $1`,
                [validated.value.candidateVersionId]
            );
            expect(candidate.rows[0]!.start_time.toISOString()).toBe(proposedStart.toISOString());
            // 60 base + 0 add-ons + 10 buffer = 70 minutes.
            expect(
                candidate.rows[0]!.end_time.getTime() - candidate.rows[0]!.start_time.getTime()
            ).toBe(70 * 60_000);
        });
    });

    it("the durable proposal survives progression through VALIDATING / REQUIRES_RECONFIRMATION", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        await withTransaction(pool, async (client) => {
            const proposed = await proposeAmendment(
                client,
                {
                    requestId,
                    proposedByIdentityId: world.customerIdentityId,
                    newStartTime: windowStartingInHours(170)
                },
                idemKey("propose")
            );
            if (!proposed.ok) throw new Error(proposed.message);
            const originalJson = canonicalProposalJson(proposed.value.proposal);

            await validateAmendment(client, proposed.value.amendmentId, idemKey("validate"));
            const afterValidate = await loadAmendment(client, proposed.value.amendmentId);
            expect(afterValidate.ok).toBe(true);
            if (!afterValidate.ok) return;
            expect(afterValidate.value.state).toBe("REQUIRES_RECONFIRMATION");
            expect(canonicalProposalJson(afterValidate.value.proposal)).toBe(originalJson);
            expect(afterValidate.value.proposalHash).toBe(proposed.value.proposalHash);
        });
    });

    it("the database itself refuses to mutate a stored proposal", async () => {
        const { world, requestId } = await confirmedBooking(pool);
        const proposed = await withTransaction(pool, async (client) => {
            const outcome = await proposeAmendment(
                client,
                { requestId, proposedByIdentityId: world.customerIdentityId, newStartTime: OCT_5 },
                idemKey("propose")
            );
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.value;
        });

        let rejected = false;
        try {
            await pool.query(
                `UPDATE core_amendment SET proposal = jsonb_set(proposal, '{newStartTime}', to_jsonb($2::text))
                  WHERE amendment_id = $1`,
                [proposed.amendmentId, OCT_20.toISOString()]
            );
        } catch (err) {
            rejected = /immutable/i.test(err instanceof Error ? err.message : String(err));
        }
        expect(rejected).toBe(true);

        const reloaded = await withTransaction(pool, (c) => loadAmendment(c, proposed.amendmentId));
        expect(reloaded.ok).toBe(true);
        if (reloaded.ok) {
            expect(reloaded.value.proposal.newStartTime).toBe(OCT_5.toISOString());
        }
    });

    it("normalizes semantically equivalent proposals to the same hash", () => {
        const a = normalizeProposal({
            newAddonIds: [
                "8C41D0E7-52B9-4A63-B17F-9E6A3C208D54",
                "3f2a9c14-6b7d-4e58-9a01-2d5c8e7b4f31"
            ]
        });
        const b = normalizeProposal({
            newAddonIds: [
                "3f2a9c14-6b7d-4e58-9a01-2d5c8e7b4f31",
                "8c41d0e7-52b9-4a63-b17f-9e6a3c208d54"
            ]
        });
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) {
            // Order and case are not semantically meaningful, so they must not
            // cause hash divergence.
            expect(proposalHash(a.value)).toBe(proposalHash(b.value));
        }

        const absent = normalizeProposal({});
        const empty = normalizeProposal({ newAddonIds: [] });
        expect(absent.ok && empty.ok).toBe(true);
        if (absent.ok && empty.ok) {
            // Absent and empty ARE semantically different and must diverge.
            expect(proposalHash(absent.value)).not.toBe(proposalHash(empty.value));
        }
    });

    it("malformed identifiers still return governed errors, never a raw driver exception", async () => {
        await withTransaction(pool, async (client) => {
            let threw: unknown = null;
            let outcome;
            try {
                outcome = await validateAmendment(client, "amendment-1", idemKey("validate"), {
                    newStartTime: OCT_5
                });
            } catch (err) {
                threw = err;
            }
            expect(threw).toBeNull();
            expect(outcome?.ok).toBe(false);
            if (outcome && !outcome.ok) expect(outcome.code).toBe("INVALID_IDENTIFIER");

            const badAddon = await proposeAmendment(
                client,
                {
                    requestId: "11111111-1111-1111-1111-111111111111",
                    proposedByIdentityId: "22222222-2222-2222-2222-222222222222",
                    newAddonIds: ["not-a-uuid"]
                },
                idemKey("propose")
            );
            expect(badAddon.ok).toBe(false);
            if (!badAddon.ok) expect(badAddon.code).toBe("INVALID_IDENTIFIER");

            // Transaction still usable.
            const { rows } = await client.query(`SELECT 1 AS ok`);
            expect(rows).toHaveLength(1);
        });
    });
});
