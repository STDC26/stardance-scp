// Freshline Studio Bali — MSOS Phase 0/1
// Connection pool + a transaction helper that retries on Postgres
// SERIALIZABLE/deadlock failures (SQLSTATE 40001 / 40P01) with exponential
// backoff and jitter. All three services route writes through this helper
// so retry semantics are enforced in exactly one place.

import { Pool, type PoolClient, type PoolConfig } from "pg";

export function createPool(overrides: PoolConfig = {}): Pool {
    return new Pool({
        host: process.env["PGHOST"] ?? "/tmp",
        port: process.env["PGPORT"] ? Number(process.env["PGPORT"]) : 5432,
        database: process.env["PGDATABASE"] ?? "freshline_msos_test",
        user: process.env["PGUSER"] ?? "jwairepo",
        password: process.env["PGPASSWORD"] ?? undefined,
        max: 10,
        idleTimeoutMillis: 30_000,
        ...overrides
    });
}

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

const RETRYABLE_SQLSTATES = new Set([
    "40001", // serialization_failure
    "40P01" // deadlock_detected
]);

interface TxOptions {
    isolation?: IsolationLevel;
    maxRetries?: number;
    baseBackoffMs?: number;
}

function isRetryablePgError(err: unknown): err is { code: string } {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string" &&
        RETRYABLE_SQLSTATES.has((err as { code: string }).code)
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` inside a transaction at the requested isolation level. On a
 * serialization failure or deadlock, rolls back and retries with
 * exponential backoff + jitter, up to `maxRetries` attempts. Any other
 * error propagates immediately after rollback.
 */
export async function withTransaction<T>(
    pool: Pool,
    fn: (client: PoolClient) => Promise<T>,
    options: TxOptions = {}
): Promise<T> {
    const isolation = options.isolation ?? "READ COMMITTED";
    const maxRetries = options.maxRetries ?? 5;
    const baseBackoffMs = options.baseBackoffMs ?? 20;

    let attempt = 0;
    for (;;) {
        const client = await pool.connect();
        try {
            await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {
                // Rollback failure on an already-aborted connection is
                // expected; swallow it and surface the original error.
            });

            if (isRetryablePgError(err) && attempt < maxRetries) {
                attempt += 1;
                const jitter = Math.random() * baseBackoffMs;
                const backoff = baseBackoffMs * 2 ** (attempt - 1) + jitter;
                await sleep(backoff);
                continue;
            }
            throw err;
        } finally {
            client.release();
        }
    }
}
