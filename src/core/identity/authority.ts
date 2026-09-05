// SCP Core Foundation — Identity, scoped roles, least privilege.
//
// IDENTITY_AUTHORITY: the same person may hold several roles; holding one never
// implies authority in another scope. The three consequential authorities —
// provider acceptance, owner assignment, customer confirmation — are resolved
// by three separate functions here and are not interchangeable.
//
// Nothing in this module trusts a channel handle, a parser result, or a
// cognition classification. Authority is always re-derived from persisted
// identity + role + object ownership inside the caller's transaction.

import type { PoolClient } from "pg";
import { fail, succeed, type Actor, type GovernedOutcome, type ScpRole } from "../types";

export interface ResolvedIdentity {
    identityId: string;
    marketId: string;
    displayName: string;
    roles: ScpRole[];
}

export async function loadIdentity(
    client: PoolClient,
    identityId: string
): Promise<ResolvedIdentity | null> {
    const { rows } = await client.query<{
        identity_id: string;
        market_id: string;
        display_name: string;
    }>(
        `SELECT identity_id, market_id, display_name FROM core_identity WHERE identity_id = $1`,
        [identityId]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    const roleRows = await client.query<{ role: ScpRole }>(
        `SELECT role FROM core_identity_role WHERE identity_id = $1 AND market_id = $2`,
        [identityId, row.market_id]
    );
    return {
        identityId: row.identity_id,
        marketId: row.market_id,
        displayName: row.display_name,
        roles: roleRows.rows.map((r) => r.role)
    };
}

/**
 * Resolves an identity from a verified inbound channel handle. Returns null
 * when the handle matches nothing — an unrecognized sender has no authority,
 * which is the whole point of ADAPTER_BOUNDARY.INBOUND_CORRELATION.
 */
export async function identityForChannelHandle(
    client: PoolClient,
    marketId: string,
    channelHandle: string
): Promise<ResolvedIdentity | null> {
    const { rows } = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_identity WHERE market_id = $1 AND channel_handle = $2`,
        [marketId, channelHandle]
    );
    const row = rows[0];
    return row ? loadIdentity(client, row.identity_id) : null;
}

async function requireRole(
    client: PoolClient,
    identityId: string,
    marketId: string,
    role: ScpRole
): Promise<GovernedOutcome<ResolvedIdentity>> {
    const identity = await loadIdentity(client, identityId);
    if (!identity) {
        return fail("UNAUTHORIZED", `identity ${identityId} not found`);
    }
    if (identity.marketId !== marketId) {
        return fail(
            "UNAUTHORIZED",
            `identity ${identityId} belongs to market ${identity.marketId}, not ${marketId}`
        );
    }
    if (!identity.roles.includes(role)) {
        return fail(
            "UNAUTHORIZED",
            `identity ${identityId} does not hold role ${role} in market ${marketId}`
        );
    }
    return succeed(identity);
}

/**
 * Provider acceptance authority. Requires the PROVIDER role AND that the
 * identity is the one behind the Provider the offer was made to. A PROVIDER in
 * the same market who was not offered the work has no authority over it.
 */
export async function authorizeProviderResponse(
    client: PoolClient,
    identityId: string,
    marketId: string,
    providerId: string
): Promise<GovernedOutcome<Actor>> {
    const roleCheck = await requireRole(client, identityId, marketId, "PROVIDER");
    if (!roleCheck.ok) {
        return roleCheck;
    }
    const { rows } = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM core_provider WHERE provider_id = $1 AND market_id = $2`,
        [providerId, marketId]
    );
    const provider = rows[0];
    if (!provider) {
        return fail("UNAUTHORIZED", `provider ${providerId} not found in market ${marketId}`);
    }
    if (provider.identity_id !== identityId) {
        return fail(
            "UNAUTHORIZED",
            `identity ${identityId} is not the provider bound to ${providerId}`
        );
    }
    return succeed({
        identityId,
        role: "PROVIDER",
        authority: `PROVIDER_ROLE+PROVIDER_BINDING:${providerId}`
    });
}

/**
 * Owner assignment authority. Assignment is an owner act; a provider accepting
 * its own offer never assigns the request
 * (DISPATCH_ASSIGNMENT_CONFIRMATION rule 1).
 */
export async function authorizeOwnerAssignment(
    client: PoolClient,
    identityId: string,
    marketId: string
): Promise<GovernedOutcome<Actor>> {
    const roleCheck = await requireRole(client, identityId, marketId, "OWNER");
    if (!roleCheck.ok) {
        return roleCheck;
    }
    return succeed({
        identityId,
        role: "OWNER",
        authority: `OWNER_ROLE:${marketId}`
    });
}

/**
 * Customer confirmation authority. Requires the CUSTOMER role AND that the
 * identity is the customer on that specific request. Owner assignment does not
 * confirm the booking (DISPATCH_ASSIGNMENT_CONFIRMATION rule 2).
 */
export async function authorizeCustomerConfirmation(
    client: PoolClient,
    identityId: string,
    marketId: string,
    requestId: string
): Promise<GovernedOutcome<Actor>> {
    const roleCheck = await requireRole(client, identityId, marketId, "CUSTOMER");
    if (!roleCheck.ok) {
        return roleCheck;
    }
    const { rows } = await client.query<{ customer_identity_id: string }>(
        `SELECT customer_identity_id FROM core_service_request
          WHERE request_id = $1 AND market_id = $2`,
        [requestId, marketId]
    );
    const request = rows[0];
    if (!request) {
        return fail("NOT_FOUND", `service request ${requestId} not found in market ${marketId}`);
    }
    if (request.customer_identity_id !== identityId) {
        return fail(
            "UNAUTHORIZED",
            `identity ${identityId} is not the customer on request ${requestId}`
        );
    }
    return succeed({
        identityId,
        role: "CUSTOMER",
        authority: `CUSTOMER_ROLE+REQUEST_OWNERSHIP:${requestId}`
    });
}
