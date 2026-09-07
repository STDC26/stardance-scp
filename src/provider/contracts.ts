// SCP-G5-E — the Partner intake contracts.
//
// Every provider command is a CLOSED contract, for the same reason G5-D's
// customer intake is: a denylist has to anticipate every field a client might
// invent, while an allowlist answers `supplyStatus`, `providerId`, `publicId`,
// `state`, `confirmedBy` and everything nobody has thought of yet the same way.
//
// Deliberately absent from every contract, and why:
//   supplyStatus / approved   approval is an Owner act on the server; there is
//                             no field in which a provider could assert it
//   publicId / partnerId      the Partner ID is server-assigned at Owner
//                             approval (C03)
//   providerId                taken from the server-verified session, never
//                             from the body (SEC01)
//   tenantId / marketId /     resolved once at runtime startup and bound to the
//   environment               process (P02)
//   confirmedBy / confirmedAt Owner confirmation is a separate governed command
//   entryMode                 apply-to-all is a UI convenience; the wire always
//                             carries seven explicit days, so there is exactly
//                             one canonical representation (A04)

import { createHash } from "node:crypto";

export interface ContractFinding {
    field: string;
    code: "UNDECLARED_FIELD" | "FIELD_INVALID";
    message: string;
}

/** Reports every field the body carries that the contract does not declare. */
export function undeclaredFields(
    body: Record<string, unknown>,
    declared: readonly string[]
): ContractFinding[] {
    const allowed = new Set<string>(declared);
    return Object.keys(body)
        .filter((key) => !allowed.has(key))
        .map((key) => ({
            field: key,
            code: "UNDECLARED_FIELD" as const,
            message: `${key} is not part of this command's contract and is not accepted`
        }));
}

export function asObject(body: unknown): Record<string, unknown> | null {
    return typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(
    body: Record<string, unknown>,
    field: string,
    findings: ContractFinding[],
    options: { max?: number; required?: boolean } = {}
): string | null {
    const max = options.max ?? 200;
    const required = options.required ?? true;
    const value = body[field];
    if (value === undefined || value === null || value === "") {
        if (required) {
            findings.push({
                field,
                code: "FIELD_INVALID",
                message: `${field} is required and must be a non-empty string`
            });
        }
        return null;
    }
    if (typeof value !== "string") {
        findings.push({ field, code: "FIELD_INVALID", message: `${field} must be a string` });
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        if (required) {
            findings.push({ field, code: "FIELD_INVALID", message: `${field} must not be blank` });
        }
        return null;
    }
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

function stringArray(
    body: Record<string, unknown>,
    field: string,
    findings: ContractFinding[],
    maxEntries: number
): string[] {
    const raw = body[field];
    if (raw === undefined || raw === null) {
        return [];
    }
    if (!Array.isArray(raw)) {
        findings.push({
            field,
            code: "FIELD_INVALID",
            message: `${field} must be an array of strings`
        });
        return [];
    }
    if (raw.length > maxEntries) {
        findings.push({
            field,
            code: "FIELD_INVALID",
            message: `${field} exceeds the maximum of ${maxEntries} entries`
        });
        return [];
    }
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== "string" || entry.trim() === "") {
            findings.push({
                field,
                code: "FIELD_INVALID",
                message: `every ${field} entry must be a non-empty string`
            });
            return [];
        }
        out.push(entry.trim());
    }
    return out;
}

function idempotencyKey(
    body: Record<string, unknown>,
    findings: ContractFinding[]
): string | null {
    const raw = body["idempotencyKey"];
    if (raw === undefined || raw === null) {
        return null;
    }
    if (typeof raw !== "string" || !IDEMPOTENCY_RE.test(raw)) {
        findings.push({
            field: "idempotencyKey",
            code: "FIELD_INVALID",
            message:
                "idempotencyKey must be 8-128 characters of [A-Za-z0-9._:-] starting alphanumerically"
        });
        return null;
    }
    return raw;
}

function uuid(
    body: Record<string, unknown>,
    field: string,
    findings: ContractFinding[],
    required: boolean
): string | null {
    const raw = body[field];
    if (raw === undefined || raw === null) {
        if (required) {
            findings.push({ field, code: "FIELD_INVALID", message: `${field} is required` });
        }
        return null;
    }
    if (typeof raw !== "string" || !UUID_RE.test(raw)) {
        findings.push({
            field,
            code: "FIELD_INVALID",
            message: `${field} must be a UUID`
        });
        return null;
    }
    return raw;
}

// -----------------------------------------------------------------------------
// Profile submission
// -----------------------------------------------------------------------------

export const DECLARED_PROFILE_FIELDS = [
    "legalName",
    "displayName",
    "contactHandle",
    "roleCode",
    "serviceCodes",
    "howYouWork",
    "aboutMe",
    "profileChips",
    "portraitMediaId",
    "locale",
    "idempotencyKey"
] as const;

export interface ProfileIntent {
    legalName: string;
    displayName: string;
    contactHandle: string;
    roleCode: string;
    serviceCodes: string[];
    howYouWork: string | null;
    aboutMe: string | null;
    profileChips: string[];
    portraitMediaId: string | null;
    locale: string;
    idempotencyKey: string | null;
}

export type ParseResult<T> = { ok: true; intent: T } | { ok: false; findings: ContractFinding[] };

const CONTACT_RE = /^\+[1-9]\d{7,14}$/;

/** Normalizes to E.164 shape without guessing a country from a local number. */
export function normalizeContact(raw: string): string | null {
    const stripped = raw.replace(/[\s()\-.]/g, "");
    const candidate = stripped.startsWith("+") ? stripped : `+${stripped}`;
    return CONTACT_RE.test(candidate) ? candidate : null;
}

export function parseProfileIntent(body: unknown): ParseResult<ProfileIntent> {
    const record = asObject(body);
    if (!record) {
        return {
            ok: false,
            findings: [
                { field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }
            ]
        };
    }
    const findings = undeclaredFields(record, DECLARED_PROFILE_FIELDS);

    const legalName = text(record, "legalName", findings, { max: 160 });
    const displayName = text(record, "displayName", findings, { max: 80 });
    const roleCode = text(record, "roleCode", findings, { max: 8 });
    const locale = text(record, "locale", findings, { max: 16 });
    const howYouWork = text(record, "howYouWork", findings, { max: 2000, required: false });
    const aboutMe = text(record, "aboutMe", findings, { max: 2000, required: false });

    const rawContact = text(record, "contactHandle", findings, { max: 32 });
    let contactHandle: string | null = null;
    if (rawContact !== null) {
        contactHandle = normalizeContact(rawContact);
        if (contactHandle === null) {
            findings.push({
                field: "contactHandle",
                code: "FIELD_INVALID",
                message: "contactHandle must be an international number, e.g. +6281234567890"
            });
        }
    }

    const serviceCodes = stringArray(record, "serviceCodes", findings, 32);
    if (serviceCodes.length === 0 && !findings.some((f) => f.field === "serviceCodes")) {
        findings.push({
            field: "serviceCodes",
            code: "FIELD_INVALID",
            message: "at least one service capability is required"
        });
    }
    if (new Set(serviceCodes).size !== serviceCodes.length) {
        findings.push({
            field: "serviceCodes",
            code: "FIELD_INVALID",
            message: "serviceCodes must not repeat a code"
        });
    }

    const profileChips = stringArray(record, "profileChips", findings, 24);
    const portraitMediaId = uuid(record, "portraitMediaId", findings, false);
    const key = idempotencyKey(record, findings);

    if (
        findings.length > 0 ||
        legalName === null ||
        displayName === null ||
        contactHandle === null ||
        roleCode === null ||
        locale === null
    ) {
        return { ok: false, findings };
    }

    return {
        ok: true,
        intent: {
            legalName,
            displayName,
            contactHandle,
            roleCode,
            serviceCodes,
            howYouWork,
            aboutMe,
            profileChips,
            portraitMediaId,
            locale,
            idempotencyKey: key
        }
    };
}

export function profileFingerprint(scope: ProviderScope, intent: ProfileIntent): string {
    return digest({
        command: "PROVIDER_PROFILE_SUBMIT",
        ...scope,
        legalName: intent.legalName,
        displayName: intent.displayName,
        contactHandle: intent.contactHandle,
        roleCode: intent.roleCode,
        // Capability is a set; the order a form emitted it in is not material.
        serviceCodes: [...intent.serviceCodes].sort(),
        howYouWork: intent.howYouWork,
        aboutMe: intent.aboutMe,
        profileChips: [...intent.profileChips].sort(),
        portraitMediaId: intent.portraitMediaId
    });
}

// -----------------------------------------------------------------------------
// Card submission
// -----------------------------------------------------------------------------

export const DECLARED_CARD_SUBMIT_FIELDS = ["idempotencyKey"] as const;

export interface CardSubmitIntent {
    idempotencyKey: string | null;
}

/**
 * A Card submission carries nothing but an idempotency key. The Card is a
 * PROJECTION over the current profile version, so there is no card field a
 * client could author that could diverge from profile truth (C01).
 */
export function parseCardSubmitIntent(body: unknown): ParseResult<CardSubmitIntent> {
    const record = asObject(body) ?? {};
    const findings = undeclaredFields(record, DECLARED_CARD_SUBMIT_FIELDS);
    const key = idempotencyKey(record, findings);
    if (findings.length > 0) {
        return { ok: false, findings };
    }
    return { ok: true, intent: { idempotencyKey: key } };
}

// -----------------------------------------------------------------------------
// Owner card decision
// -----------------------------------------------------------------------------

export const DECLARED_CARD_DECISION_FIELDS = ["cardId", "reason", "idempotencyKey"] as const;

export interface CardDecisionIntent {
    cardId: string;
    reason: string | null;
    idempotencyKey: string | null;
}

export function parseCardDecisionIntent(body: unknown): ParseResult<CardDecisionIntent> {
    const record = asObject(body);
    if (!record) {
        return {
            ok: false,
            findings: [
                { field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }
            ]
        };
    }
    const findings = undeclaredFields(record, DECLARED_CARD_DECISION_FIELDS);
    const cardId = uuid(record, "cardId", findings, true);
    const reason = text(record, "reason", findings, { max: 500, required: false });
    const key = idempotencyKey(record, findings);
    if (findings.length > 0 || cardId === null) {
        return { ok: false, findings };
    }
    return { ok: true, intent: { cardId, reason, idempotencyKey: key } };
}

// -----------------------------------------------------------------------------
// Availability submission
// -----------------------------------------------------------------------------

export const DECLARED_AVAILABILITY_FIELDS = ["weekStartDate", "days", "idempotencyKey"] as const;
export const DECLARED_AVAILABILITY_DAY_FIELDS = [
    "isoDay",
    "available",
    "startTime",
    "endTime",
    "regions"
] as const;

export interface AvailabilityDayIntent {
    isoDay: number;
    available: boolean;
    startTime: string | null;
    endTime: string | null;
    regions: string[];
}

export interface AvailabilityIntent {
    weekStartDate: string;
    days: AvailabilityDayIntent[];
    idempotencyKey: string | null;
}

export function parseAvailabilityIntent(body: unknown): ParseResult<AvailabilityIntent> {
    const record = asObject(body);
    if (!record) {
        return {
            ok: false,
            findings: [
                { field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }
            ]
        };
    }
    const findings = undeclaredFields(record, DECLARED_AVAILABILITY_FIELDS);

    const weekStartDate = text(record, "weekStartDate", findings, { max: 10 });
    if (weekStartDate !== null && !DATE_RE.test(weekStartDate)) {
        findings.push({
            field: "weekStartDate",
            code: "FIELD_INVALID",
            message: "weekStartDate must be YYYY-MM-DD"
        });
    }

    const rawDays = record["days"];
    const days: AvailabilityDayIntent[] = [];
    if (!Array.isArray(rawDays)) {
        findings.push({
            field: "days",
            code: "FIELD_INVALID",
            message: "days must be an array of exactly seven day objects"
        });
    } else if (rawDays.length !== 7) {
        findings.push({
            field: "days",
            code: "FIELD_INVALID",
            message: `days must contain exactly seven entries, received ${rawDays.length}`
        });
    } else {
        for (let index = 0; index < rawDays.length; index += 1) {
            const dayRecord = asObject(rawDays[index]);
            const path = `days[${index}]`;
            if (!dayRecord) {
                findings.push({
                    field: path,
                    code: "FIELD_INVALID",
                    message: `${path} must be an object`
                });
                continue;
            }
            for (const finding of undeclaredFields(dayRecord, DECLARED_AVAILABILITY_DAY_FIELDS)) {
                findings.push({ ...finding, field: `${path}.${finding.field}` });
            }

            const isoDay = dayRecord["isoDay"];
            if (typeof isoDay !== "number" || !Number.isInteger(isoDay) || isoDay < 1 || isoDay > 7) {
                findings.push({
                    field: `${path}.isoDay`,
                    code: "FIELD_INVALID",
                    message: "isoDay must be an integer 1 (Monday) through 7 (Sunday)"
                });
                continue;
            }

            const available = dayRecord["available"];
            if (typeof available !== "boolean") {
                findings.push({
                    field: `${path}.available`,
                    code: "FIELD_INVALID",
                    message: "available must be a boolean"
                });
                continue;
            }

            const dayFindings: ContractFinding[] = [];
            const startTime = available
                ? text(dayRecord, "startTime", dayFindings, { max: 5 })
                : null;
            const endTime = available ? text(dayRecord, "endTime", dayFindings, { max: 5 }) : null;
            const regions = stringArray(dayRecord, "regions", dayFindings, 32);
            for (const finding of dayFindings) {
                findings.push({ ...finding, field: `${path}.${finding.field}` });
            }

            if (available) {
                if (startTime !== null && !TIME_RE.test(startTime)) {
                    findings.push({
                        field: `${path}.startTime`,
                        code: "FIELD_INVALID",
                        message: "startTime must be HH:MM in 24-hour form"
                    });
                }
                if (endTime !== null && !TIME_RE.test(endTime)) {
                    findings.push({
                        field: `${path}.endTime`,
                        code: "FIELD_INVALID",
                        message: "endTime must be HH:MM in 24-hour form"
                    });
                }
                if (regions.length === 0) {
                    findings.push({
                        field: `${path}.regions`,
                        code: "FIELD_INVALID",
                        message: "an available day must state at least one coverage region"
                    });
                }
                if (new Set(regions).size !== regions.length) {
                    findings.push({
                        field: `${path}.regions`,
                        code: "FIELD_INVALID",
                        message: "regions must not repeat"
                    });
                }
            } else {
                // An unavailable day states nothing else. Accepting hours or
                // regions on a day off would leave two readings of the same day.
                for (const stray of ["startTime", "endTime"] as const) {
                    if (dayRecord[stray] !== undefined && dayRecord[stray] !== null) {
                        findings.push({
                            field: `${path}.${stray}`,
                            code: "FIELD_INVALID",
                            message: `${stray} must be absent on an unavailable day`
                        });
                    }
                }
                if (Array.isArray(dayRecord["regions"]) && dayRecord["regions"].length > 0) {
                    findings.push({
                        field: `${path}.regions`,
                        code: "FIELD_INVALID",
                        message: "regions must be empty on an unavailable day"
                    });
                }
            }

            days.push({
                isoDay,
                available,
                startTime: available ? startTime : null,
                endTime: available ? endTime : null,
                regions: available ? regions : []
            });
        }

        const seen = new Set(days.map((d) => d.isoDay));
        if (days.length === 7 && seen.size !== 7) {
            findings.push({
                field: "days",
                code: "FIELD_INVALID",
                message: "days must cover each of the seven ISO days exactly once"
            });
        }
    }

    const key = idempotencyKey(record, findings);

    if (findings.length > 0 || weekStartDate === null) {
        return { ok: false, findings };
    }

    return {
        ok: true,
        // Canonical order, always. Whether the client sent Sunday first or used
        // apply-to-all, the stored week is the same week.
        intent: {
            weekStartDate,
            days: [...days].sort((a, b) => a.isoDay - b.isoDay),
            idempotencyKey: key
        }
    };
}

// -----------------------------------------------------------------------------
// Owner availability confirmation
// -----------------------------------------------------------------------------

export const DECLARED_AVAILABILITY_CONFIRM_FIELDS = [
    "availabilityVersionId",
    "idempotencyKey"
] as const;

export interface AvailabilityConfirmIntent {
    availabilityVersionId: string;
    idempotencyKey: string | null;
}

export function parseAvailabilityConfirmIntent(
    body: unknown
): ParseResult<AvailabilityConfirmIntent> {
    const record = asObject(body);
    if (!record) {
        return {
            ok: false,
            findings: [
                { field: "<body>", code: "FIELD_INVALID", message: "body must be a JSON object" }
            ]
        };
    }
    const findings = undeclaredFields(record, DECLARED_AVAILABILITY_CONFIRM_FIELDS);
    const availabilityVersionId = uuid(record, "availabilityVersionId", findings, true);
    const key = idempotencyKey(record, findings);
    if (findings.length > 0 || availabilityVersionId === null) {
        return { ok: false, findings };
    }
    return { ok: true, intent: { availabilityVersionId, idempotencyKey: key } };
}

// -----------------------------------------------------------------------------
// Shared
// -----------------------------------------------------------------------------

export interface ProviderScope {
    tenantId: string;
    marketId: string;
    environment: string;
}

export function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Deterministic digest of a canonical seven-day schedule.
 *
 * This is what makes A04 provable: apply-to-all and per-day editing produce the
 * same seven canonical days, so they produce the same digest, so they are
 * demonstrably the same schedule rather than merely intended to be.
 */
export function scheduleDigest(
    scope: ProviderScope,
    weekStartDate: string,
    days: readonly AvailabilityDayIntent[]
): string {
    return digest({
        command: "PROVIDER_AVAILABILITY_SUBMIT",
        ...scope,
        weekStartDate,
        days: [...days]
            .sort((a, b) => a.isoDay - b.isoDay)
            .map((d) => ({
                isoDay: d.isoDay,
                available: d.available,
                startTime: d.startTime,
                endTime: d.endTime,
                regions: [...d.regions].sort()
            }))
    });
}

export function deriveIdempotencyKey(command: string, fingerprint: string, correlationId: string): string {
    return `${command}:${fingerprint.slice(0, 24)}:${correlationId}`;
}
