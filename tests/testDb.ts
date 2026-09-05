// Shared helper for the integration test: creates a fresh service +
// appointment row and gives back a Pool pointed at the local Postgres
// instance. Not used by the pure-function unit tests.

import { Pool } from "pg";
import { createPool } from "../src/db/pool";

export function getIntegrationPool(): Pool {
    return createPool({
        database: process.env["PGDATABASE"] ?? "freshline_msos_test"
    });
}

export async function resetSchema(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE appointment_status_history, whatsapp_inbound_events, appointments, service_catalogue
        RESTART IDENTITY CASCADE
    `);
}

export interface SeedResult {
    serviceId: string;
    appointmentId: string;
}

/**
 * Inserts a service and a single appointment already sitting in
 * CONTRACTOR_DISPATCHED with `dispatched_at` set `minutesAgo` in the past —
 * exactly the shape the timeout sweep looks for.
 */
export async function seedDispatchedAppointment(
    pool: Pool,
    minutesAgo: number
): Promise<SeedResult> {
    const serviceResult = await pool.query<{ service_id: string }>(
        `INSERT INTO service_catalogue (name, duration_minutes, active)
         VALUES ('Test Massage', 60, TRUE)
         RETURNING service_id`
    );
    const serviceId = serviceResult.rows[0]!.service_id;

    const dispatchedAt = new Date(Date.now() - minutesAgo * 60_000);
    const startTime = new Date(Date.now() + 60 * 60_000);
    const endTime = new Date(startTime.getTime() + 60 * 60_000);

    const apptResult = await pool.query<{ appointment_id: string }>(
        `INSERT INTO appointments
            (billing_code, customer_id, service_id, contractor_id, start_time, end_time,
             status, dispatched_at, version)
         VALUES
            ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, $4,
             'CONTRACTOR_DISPATCHED', $5, 1)
         RETURNING appointment_id`,
        [randomBillingCode(), serviceId, startTime, endTime, dispatchedAt]
    );

    return { serviceId, appointmentId: apptResult.rows[0]!.appointment_id };
}

let billingCodeCounter = 0;
function randomBillingCode(): string {
    billingCodeCounter += 1;
    const digits = String(1000 + billingCodeCounter).padStart(6, "0").slice(-6);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "X");
    return `FL-${digits}-${suffix}`;
}
