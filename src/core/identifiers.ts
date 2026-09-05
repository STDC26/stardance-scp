// SCP Core Foundation — governed external identifier validation.
//
// Closes G1R-R01. In the G1 baseline only `contractorId` was shape-checked, so
// a malformed appointment/request identifier still reached Postgres and aborted
// the transaction with SQLSTATE 22P02, escaping the caller as a raw driver
// exception rather than a governed refusal. Every externally supplied
// identifier now passes through here before any SQL is issued.
//
// This is robustness hardening only: it changes no canonical state semantics,
// and a well-formed identifier behaves exactly as it did before.

import { fail, succeed, type GovernedOutcome } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Validates one externally supplied UUID. `label` names the field so the audit
 * trail and the caller both see which identifier was rejected.
 */
export function requireUuid(label: string, value: unknown): GovernedOutcome<string> {
    if (!isUuid(value)) {
        return fail("INVALID_IDENTIFIER", `${label} ${JSON.stringify(value)} is not a valid UUID`);
    }
    return succeed(value);
}

/**
 * Validates several identifiers at once, returning the first failure. Keeps
 * command entry points to a single guard line instead of a validation ladder.
 */
export function requireUuids(
    fields: Readonly<Record<string, unknown>>
): GovernedOutcome<Record<string, string>> {
    const validated: Record<string, string> = {};
    for (const [label, value] of Object.entries(fields)) {
        const outcome = requireUuid(label, value);
        if (!outcome.ok) {
            return outcome;
        }
        validated[label] = outcome.value;
    }
    return succeed(validated);
}
