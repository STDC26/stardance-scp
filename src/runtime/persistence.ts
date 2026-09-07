// SCP Runtime — authoritative persistence verification.
//
// PostgreSQL holds authoritative truth. Nothing else may: not browser storage,
// not a mock, not a WhatsApp message. Startup proves the schema the runtime
// needs is actually present and refuses to start otherwise, so a runtime can
// never come up half-migrated and then discover it mid-transaction.

import type { Pool, PoolClient } from "pg";

/**
 * Relations the runtime requires before it may serve anything. Deliberately
 * the authoritative surfaces only — the canonical lifecycle aggregate, the
 * governed kernel objects, the audit trail, and the configuration store.
 */
export const REQUIRED_RELATIONS = [
    "core_service_request",
    "core_service_request_version",
    "core_provider",
    "core_identity",
    "core_identity_role",
    "core_capacity_hold",
    "core_dispatch_offer",
    "core_assignment",
    "core_customer_confirmation",
    "core_amendment",
    "core_event",
    "core_sellable_offer",
    "core_commerce_evaluation",
    "core_operational_action",
    "core_operational_recovery",
    "core_tenant_configuration",
    "core_tenant_configuration_event"
] as const;

/**
 * Legacy relations that may EXIST but must never be treated as authoritative.
 * Recorded so the startup report states the position explicitly rather than
 * leaving it implied.
 */
export const NON_AUTHORITATIVE_LEGACY_RELATIONS = ["appointments", "service_catalogue"] as const;

export interface SchemaCheck {
    ok: boolean;
    present: string[];
    missing: string[];
    legacyPresentButNonAuthoritative: string[];
}

export async function verifySchema(client: PoolClient): Promise<SchemaCheck> {
    const { rows } = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const existing = new Set(rows.map((r) => r.tablename));
    const present = REQUIRED_RELATIONS.filter((r) => existing.has(r));
    const missing = REQUIRED_RELATIONS.filter((r) => !existing.has(r));
    return {
        ok: missing.length === 0,
        present: [...present],
        missing: [...missing],
        legacyPresentButNonAuthoritative: NON_AUTHORITATIVE_LEGACY_RELATIONS.filter((r) =>
            existing.has(r)
        )
    };
}

export interface ConnectivityCheck {
    ok: boolean;
    serverVersion: string | null;
    database: string | null;
    message?: string;
}

export async function verifyConnectivity(pool: Pool): Promise<ConnectivityCheck> {
    try {
        const { rows } = await pool.query<{ v: string; db: string }>(
            `SELECT version() AS v, current_database() AS db`
        );
        return { ok: true, serverVersion: rows[0]!.v, database: rows[0]!.db };
    } catch (err) {
        return {
            ok: false,
            serverVersion: null,
            database: null,
            message: err instanceof Error ? err.message : String(err)
        };
    }
}
