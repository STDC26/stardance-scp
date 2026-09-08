// Fixtures for the G5-D customer-experience and demand-ingress proofs.
//
// Every world is built the way production builds one: publish -> approve ->
// activate a governed configuration, then start the runtime spine against it.
// Nothing here inserts a catalogue row directly, because the point of the gate
// is that configuration governs the catalogue.

import type { Pool } from "pg";
import { DateTime } from "luxon";
import { createPool, withTransaction } from "../../src/db/pool";
import {
    publishConfiguration,
    approveConfiguration,
    activateConfiguration
} from "../../src/config/tenant/store";
import { FRESHLINE_BALI_V2, cloneBundle } from "../../src/config/tenant/freshline";
import type { TenantConfigurationBundleV2 } from "../../src/config/tenant/contract";
import { startCustomerHost, type CustomerHost } from "../../src/host/customerHost";
import { slotAtLeastDaysAhead } from "../support/testTime";

export const SCOPE = { tenantId: "freshline-bali", marketId: "bali", environment: "candidate" };
export const ACTOR = "PTC/DRJ";
export const SOURCE = "SCP-G5-D-01";

export function getCustomerPool(): Pool {
    return createPool({ database: process.env["PGDATABASE"] ?? "freshline_msos_test" });
}

export async function resetCustomer(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE core_demand_ingress, core_catalogue_binding, core_runtime_evidence,
                 core_tenant_configuration_event, core_tenant_configuration,
                 core_event, core_fulfillment, core_customer_confirmation, core_assignment,
                 core_operational_recovery, core_operational_action,
                 core_dispatch_offer, core_amendment, core_capacity_hold, core_capacity_window,
                 core_commerce_evaluation, core_sellable_offer,
                 core_service_request_version, core_service_request,
                 core_service_price_version, core_service_addon, core_service,
                 core_provider_alias, core_provider, core_identity_role, core_identity
        RESTART IDENTITY CASCADE
    `);
}

/** Publishes, approves and activates a bundle. Returns the activated version. */
export async function activate(pool: Pool, bundle: unknown): Promise<number> {
    return withTransaction(pool, async (client) => {
        const published = await publishConfiguration(client, {
            bundle: bundle as never,
            actorOrAuthority: ACTOR,
            sourceReference: SOURCE
        });
        if (!published.ok) throw new Error(published.message);
        if (published.value.configuration.state !== "VALIDATED") {
            throw new Error(
                `bundle rejected: ${published.value.findings.map((f) => f.code).join(", ")}`
            );
        }
        const id = published.value.configuration.configurationId;
        const approved = await approveConfiguration(client, id, ACTOR);
        if (!approved.ok) throw new Error(approved.message);
        const activated = await activateConfiguration(client, id, ACTOR);
        if (!activated.ok) throw new Error(activated.message);
        return activated.value.activated.configurationVersion;
    });
}

/** A copy of the governed v2 bundle at a new version, with a mutation applied. */
export function bundleAtVersion(
    version: number,
    mutate: (b: TenantConfigurationBundleV2) => void = () => {}
): TenantConfigurationBundleV2 {
    const b = cloneBundle(FRESHLINE_BALI_V2 as never) as unknown as TenantConfigurationBundleV2;
    b.configurationVersion = version;
    mutate(b);
    return b;
}

export async function startHost(
    pool: Pool,
    overrides: Partial<{ tenantId: string; marketId: string; environment: string }> = {},
    options: { enableWhatsAppTransport?: boolean; projectCatalogueOnStart?: boolean } = {}
) {
    return startCustomerHost({
        pool,
        identity: {
            tenantId: overrides.tenantId ?? SCOPE.tenantId,
            marketId: overrides.marketId ?? SCOPE.marketId,
            environment: overrides.environment ?? SCOPE.environment
        },
        ...options
    });
}

export async function startHostOrThrow(
    pool: Pool,
    overrides?: Partial<{ tenantId: string; marketId: string; environment: string }>,
    options?: { enableWhatsAppTransport?: boolean; projectCatalogueOnStart?: boolean }
): Promise<CustomerHost> {
    const outcome = await startHost(pool, overrides, options);
    if (!outcome.ok) {
        throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    return outcome.host;
}

/**
 * A market-local date/time comfortably inside the governed operating hours and
 * booking window. Anchored to a fixed hour so a test never depends on the wall
 * clock at which it happens to run.
 */
export function futureSlot(daysAhead = 3, hour = 10): { date: string; time: string } {
    return slotAtLeastDaysAhead(daysAhead, hour);
}

let seq = 0;

/** A well-formed submission body. Individual tests override what they exercise. */
export function validIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    const slot = futureSlot();
    return {
        serviceCode: "FRESH_CUT",
        extraCodes: [],
        requestedDate: slot.date,
        requestedTime: slot.time,
        region: "Seminyak",
        accommodationType: "Villa",
        customerName: "Ayu Pratama",
        contactHandle: `+62812${String(3000000 + seq).slice(0, 7)}`,
        locale: "en",
        ...overrides
    };
}

export interface PostResult {
    status: number;
    body: Record<string, unknown>;
}

export async function post(
    origin: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
): Promise<PostResult> {
    const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function getJson(origin: string, path: string): Promise<PostResult> {
    const response = await fetch(`${origin}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function getText(origin: string, path: string): Promise<{ status: number; text: string }> {
    const response = await fetch(`${origin}${path}`);
    return { status: response.status, text: await response.text() };
}
