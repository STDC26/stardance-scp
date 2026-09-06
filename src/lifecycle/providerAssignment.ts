// SCP Operational Lifecycle — ProviderAssignment.
//
// Versioned durable operational responsibility on the existing core_assignment
// owner. The invariant "exactly one ACTIVE assignment per Service Request" is
// enforced by uq_assignment_single_active in migration 007, not by application
// checking — so two concurrent owners cannot both believe they assigned.
//
// Reassignment REPLACES rather than revokes: the prior assignment stays as
// evidence with status REPLACED and a pointer to its successor, so operational
// history is reconstructable.

import type { PoolClient } from "pg";
import type { Actor, AssignmentStatus } from "../core/types";
import { recordEvent } from "../core/events/eventLog";

export interface ProviderAssignment {
    assignmentId: string;
    requestId: string;
    providerId: string;
    attemptId: string;
    status: AssignmentStatus;
    assignmentVersion: number;
    replacedBy: string | null;
}

const ASSIGNMENT_COLUMNS = `assignment_id, request_id, provider_id, offer_id, status,
                            assignment_version, replaced_by`;

function toAssignment(row: Record<string, unknown>): ProviderAssignment {
    return {
        assignmentId: row["assignment_id"] as string,
        requestId: row["request_id"] as string,
        providerId: row["provider_id"] as string,
        attemptId: row["offer_id"] as string,
        status: row["status"] as AssignmentStatus,
        assignmentVersion: row["assignment_version"] as number,
        replacedBy: (row["replaced_by"] as string | null) ?? null
    };
}

export async function activeAssignment(
    client: PoolClient,
    requestId: string,
    forUpdate = false
): Promise<ProviderAssignment | null> {
    const { rows } = await client.query(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM core_assignment
          WHERE request_id = $1 AND status = 'ACTIVE' ${forUpdate ? "FOR UPDATE" : ""}`,
        [requestId]
    );
    return rows[0] ? toAssignment(rows[0]) : null;
}

export async function assignmentsForRequest(
    client: PoolClient,
    requestId: string
): Promise<ProviderAssignment[]> {
    const { rows } = await client.query(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM core_assignment
          WHERE request_id = $1 ORDER BY assignment_version ASC`,
        [requestId]
    );
    return rows.map(toAssignment);
}

export type AssignOutcome =
    | { ok: true; assignment: ProviderAssignment; replaced: ProviderAssignment | null }
    | { ok: false; reason: "ASSIGNMENT_CONFLICT" };

/**
 * Creates or replaces the active assignment. The unique index is the arbiter:
 * a concurrent second assigner loses on insert and receives
 * ASSIGNMENT_CONFLICT rather than a database error.
 */
export async function assignProvider(
    client: PoolClient,
    input: {
        requestId: string;
        providerId: string;
        attemptId: string;
        marketId: string;
        assignedByIdentityId: string;
        replaceExisting: boolean;
    },
    actor: Actor,
    idempotencyKey: string
): Promise<AssignOutcome> {
    const existing = await activeAssignment(client, input.requestId, true);
    let replaced: ProviderAssignment | null = null;

    if (existing) {
        if (!input.replaceExisting) {
            return { ok: false, reason: "ASSIGNMENT_CONFLICT" };
        }
        await client.query(
            `UPDATE core_assignment SET status = 'REPLACED', revoked_at = now()
              WHERE assignment_id = $1 AND status = 'ACTIVE'`,
            [existing.assignmentId]
        );
        replaced = existing;
    }

    const nextVersion = (existing?.assignmentVersion ?? 0) + 1;

    await client.query("SAVEPOINT assign_provider");
    try {
        const inserted = await client.query(
            `INSERT INTO core_assignment
                (request_id, provider_id, offer_id, assigned_by_identity_id,
                 status, assignment_version)
             VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
             RETURNING ${ASSIGNMENT_COLUMNS}`,
            [
                input.requestId,
                input.providerId,
                input.attemptId,
                input.assignedByIdentityId,
                nextVersion
            ]
        );
        await client.query("RELEASE SAVEPOINT assign_provider");
        const assignment = toAssignment(inserted.rows[0]!);

        if (replaced) {
            await client.query(
                `UPDATE core_assignment SET replaced_by = $2 WHERE assignment_id = $1`,
                [replaced.assignmentId, assignment.assignmentId]
            );
            await recordEvent(client, {
                marketId: input.marketId,
                objectType: "ASSIGNMENT",
                objectId: replaced.assignmentId,
                fromState: "ACTIVE",
                toState: "REPLACED",
                actor,
                governingRef: `assignment:${assignment.assignmentId}`,
                idempotencyKey: `${idempotencyKey}:replaced`
            });
        }

        await recordEvent(client, {
            marketId: input.marketId,
            objectType: "ASSIGNMENT",
            objectId: assignment.assignmentId,
            fromState: null,
            toState: "ACTIVE",
            actor,
            governingRef: `request:${input.requestId}#assignment_v${nextVersion}`,
            idempotencyKey: `${idempotencyKey}:assignment`,
            payload: { providerId: input.providerId, assignmentVersion: nextVersion }
        });

        return { ok: true, assignment, replaced };
    } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT assign_provider");
        if (isUniqueViolation(err)) {
            return { ok: false, reason: "ASSIGNMENT_CONFLICT" };
        }
        throw err;
    }
}

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "23505"
    );
}

/** Revokes the active assignment without naming a successor. */
export async function revokeActiveAssignment(
    client: PoolClient,
    requestId: string,
    marketId: string,
    actor: Actor,
    idempotencyKey: string
): Promise<ProviderAssignment | null> {
    const existing = await activeAssignment(client, requestId, true);
    if (!existing) {
        return null;
    }
    await client.query(
        `UPDATE core_assignment SET status = 'REVOKED', revoked_at = now()
          WHERE assignment_id = $1 AND status = 'ACTIVE'`,
        [existing.assignmentId]
    );
    await recordEvent(client, {
        marketId,
        objectType: "ASSIGNMENT",
        objectId: existing.assignmentId,
        fromState: "ACTIVE",
        toState: "REVOKED",
        actor,
        idempotencyKey
    });
    return existing;
}
