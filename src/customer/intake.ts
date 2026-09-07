// SCP-G5-D — the customer intake contract.
//
// CENTRAL BOUNDARY: the customer surface CAPTURES INTENT. SCP owns the resulting
// Service Request and all authoritative state. This module is the shape of that
// intent, and nothing more.
//
// The contract is CLOSED, not filtered. A denylist of dangerous fields would
// have to anticipate every name a client might invent; an allowlist makes the
// question "is this field declared?" and the answer for `priceMinorUnits`,
// `tenantId`, `state` and everything else nobody has thought of yet is the same:
// no. That is why a browser cannot govern price, tenant, market, environment or
// lifecycle position — there is no field in which it could try.
//
// Deliberately absent, and why:
//   price / currency        the server resolves commercial truth from the
//                           governed catalogue; a submitted price is untrusted
//   tenant / market /       resolved once at runtime startup and bound to the
//   environment             process, never accepted from a caller
//   startTime / timestamp   the server resolves the instant from a market-local
//                           date and time; the server clock is authoritative
//   state / status          demand ingress produces exactly one initial state,
//                           chosen by Core, never by a caller
//   sourceChannel           set by the transport that received the intent, so a
//                           client cannot claim to be an operator console

import { createHash } from "node:crypto";

/** Every field a customer surface may submit. Nothing else is accepted. */
export const DECLARED_INTAKE_FIELDS = [
    "serviceCode",
    "extraCodes",
    "requestedDate",
    "requestedTime",
    "region",
    "accommodationType",
    "customerName",
    "contactHandle",
    "locale",
    "idempotencyKey"
] as const;

export type DeclaredIntakeField = (typeof DECLARED_INTAKE_FIELDS)[number];

const DECLARED: ReadonlySet<string> = new Set(DECLARED_INTAKE_FIELDS);

export interface CustomerIntent {
    serviceCode: string;
    extraCodes: string[];
    /** Market-local calendar date, YYYY-MM-DD. */
    requestedDate: string;
    /** Market-local wall time, HH:MM. */
    requestedTime: string;
    region: string;
    accommodationType: string | null;
    customerName: string;
    /** Normalized contact handle (E.164-shaped digits with a leading +). */
    contactHandle: string;
    locale: string;
    /** Present only when the caller supplied one; the server validates it. */
    idempotencyKey: string | null;
}

export interface IntakeFinding {
    field: string;
    code: "UNDECLARED_FIELD" | "FIELD_INVALID";
    message: string;
}

export type IntakeParse =
    | { ok: true; intent: CustomerIntent }
    | { ok: false; findings: IntakeFinding[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NAME_MAX = 120;
const CONTACT_DIGITS = /^\+[1-9]\d{7,14}$/;

/**
 * Normalizes a contact handle to E.164 shape. Presentation characters are
 * stripped; a leading 0 is NOT silently promoted to a country code, because
 * guessing a country from a local-format number is exactly the kind of helpful
 * inference that later turns into an unreachable customer.
 */
export function normalizeContactHandle(raw: string): string | null {
    const stripped = raw.replace(/[\s()\-.]/g, "");
    const candidate = stripped.startsWith("+") ? stripped : `+${stripped}`;
    return CONTACT_DIGITS.test(candidate) ? candidate : null;
}

function requireString(
    body: Record<string, unknown>,
    field: DeclaredIntakeField,
    findings: IntakeFinding[],
    max = 200
): string | null {
    const value = body[field];
    if (typeof value !== "string" || value.trim() === "") {
        findings.push({
            field,
            code: "FIELD_INVALID",
            message: `${field} is required and must be a non-empty string`
        });
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        findings.push({
            field,
            code: "FIELD_INVALID",
            message: `${field} exceeds ${max} characters`
        });
        return null;
    }
    return trimmed;
}

/**
 * Parses a submitted body into customer intent, or returns every finding at
 * once. Reporting all findings together is a deliberate UX choice: a customer
 * correcting a form should not have to discover its problems one round trip at
 * a time.
 */
export function parseCustomerIntent(body: unknown): IntakeParse {
    const findings: IntakeFinding[] = [];

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return {
            ok: false,
            findings: [
                { field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }
            ]
        };
    }
    const record = body as Record<string, unknown>;

    // Closed contract. This is the single check that neutralizes browser-supplied
    // price, tenant, market, environment, state and every field not yet invented.
    for (const key of Object.keys(record)) {
        if (!DECLARED.has(key)) {
            findings.push({
                field: key,
                code: "UNDECLARED_FIELD",
                message: `${key} is not part of the customer intake contract and is not accepted`
            });
        }
    }

    const serviceCode = requireString(record, "serviceCode", findings, 64);
    const region = requireString(record, "region", findings, 80);
    const customerName = requireString(record, "customerName", findings, NAME_MAX);
    const locale = requireString(record, "locale", findings, 16);

    const requestedDate = requireString(record, "requestedDate", findings, 10);
    if (requestedDate !== null && !DATE_RE.test(requestedDate)) {
        findings.push({
            field: "requestedDate",
            code: "FIELD_INVALID",
            message: "requestedDate must be YYYY-MM-DD"
        });
    }

    const requestedTime = requireString(record, "requestedTime", findings, 5);
    if (requestedTime !== null && !TIME_RE.test(requestedTime)) {
        findings.push({
            field: "requestedTime",
            code: "FIELD_INVALID",
            message: "requestedTime must be HH:MM in 24-hour form"
        });
    }

    const rawContact = requireString(record, "contactHandle", findings, 32);
    let contactHandle: string | null = null;
    if (rawContact !== null) {
        contactHandle = normalizeContactHandle(rawContact);
        if (contactHandle === null) {
            findings.push({
                field: "contactHandle",
                code: "FIELD_INVALID",
                message: "contactHandle must be an international number, e.g. +6281234567890"
            });
        }
    }

    // Optional: absent and null both mean "not stated".
    let accommodationType: string | null = null;
    const rawAccommodation = record["accommodationType"];
    if (rawAccommodation !== undefined && rawAccommodation !== null) {
        if (typeof rawAccommodation !== "string" || rawAccommodation.trim() === "") {
            findings.push({
                field: "accommodationType",
                code: "FIELD_INVALID",
                message: "accommodationType must be a non-empty string when present"
            });
        } else {
            accommodationType = rawAccommodation.trim();
        }
    }

    const extraCodes: string[] = [];
    const rawExtras = record["extraCodes"];
    if (rawExtras !== undefined && rawExtras !== null) {
        if (!Array.isArray(rawExtras)) {
            findings.push({
                field: "extraCodes",
                code: "FIELD_INVALID",
                message: "extraCodes must be an array of strings"
            });
        } else if (rawExtras.length > 16) {
            findings.push({
                field: "extraCodes",
                code: "FIELD_INVALID",
                message: "extraCodes exceeds the maximum of 16 entries"
            });
        } else {
            for (const entry of rawExtras) {
                if (typeof entry !== "string" || entry.trim() === "") {
                    findings.push({
                        field: "extraCodes",
                        code: "FIELD_INVALID",
                        message: "every extraCodes entry must be a non-empty string"
                    });
                } else {
                    extraCodes.push(entry.trim());
                }
            }
        }
    }

    let idempotencyKey: string | null = null;
    const rawKey = record["idempotencyKey"];
    if (rawKey !== undefined && rawKey !== null) {
        if (typeof rawKey !== "string" || !IDEMPOTENCY_RE.test(rawKey)) {
            findings.push({
                field: "idempotencyKey",
                code: "FIELD_INVALID",
                message:
                    "idempotencyKey must be 8-128 characters of [A-Za-z0-9._:-] starting alphanumerically"
            });
        } else {
            idempotencyKey = rawKey;
        }
    }

    if (
        findings.length > 0 ||
        serviceCode === null ||
        region === null ||
        customerName === null ||
        locale === null ||
        requestedDate === null ||
        requestedTime === null ||
        contactHandle === null
    ) {
        return { ok: false, findings };
    }

    return {
        ok: true,
        intent: {
            serviceCode,
            extraCodes,
            requestedDate,
            requestedTime,
            region,
            accommodationType,
            customerName,
            contactHandle,
            locale,
            idempotencyKey
        }
    };
}

/**
 * Deterministic digest of the materially-identifying intent, scoped to the
 * runtime that accepted it. Two structurally identical submissions produce the
 * same fingerprint; a reused idempotency key carrying anything else does not,
 * which is what makes a replay distinguishable from a collision.
 *
 * `customerName` and `idempotencyKey` are excluded: a name is presentation, and
 * including the key would make every fingerprint trivially unique.
 */
export function intentFingerprint(input: {
    tenantId: string;
    marketId: string;
    environment: string;
    intent: CustomerIntent;
}): string {
    const i = input.intent;
    return createHash("sha256")
        .update(
            JSON.stringify({
                tenantId: input.tenantId,
                marketId: input.marketId,
                environment: input.environment,
                serviceCode: i.serviceCode,
                // Selection is a set; the order a form emitted it in is not
                // material to what was requested.
                extraCodes: [...i.extraCodes].sort(),
                requestedDate: i.requestedDate,
                requestedTime: i.requestedTime,
                region: i.region,
                accommodationType: i.accommodationType,
                contactHandle: i.contactHandle,
                locale: i.locale
            }),
            "utf8"
        )
        .digest("hex");
}

/** Server-generated idempotency key, used when the caller supplied none. */
export function deriveIdempotencyKey(fingerprint: string, correlationId: string): string {
    return `di:${fingerprint.slice(0, 32)}:${correlationId}`;
}
