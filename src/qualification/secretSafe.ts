// SCP-RUNTIME-Q01B-QCP2A-R02 — secret-safe evidence serialization.
//
// Qualification proof infrastructure only. No product code path uses this.
//
// WHY THIS FILE EXISTS. Fresh Codex IRF ran the pinned G11 battery and found a
// live qualification PostgreSQL password in the raw stderr (QCP2A-D03). The
// mechanism was not a logging mistake — nobody ever wrote `console.log(password)`.
// A pg error object carries a reference to the `client` that raised it, and a
// pg Client holds `connectionParameters.password`. When six 57P01 errors escaped
// unhandled, Vitest's reporter deep-serialized them for its "Serialized Error"
// dump and walked straight into the credential.
//
// So the primary control is NOT redaction. It is: never hand a secret-bearing
// object graph to a generic serializer. `describeError` below is an allowlist —
// it copies named scalar fields and nothing else, so nested client/pool/config
// state cannot be reached no matter what is attached to the error.
//
// `redact` is defence in depth for text that was produced by something outside
// our control (a child process's stdout/stderr). It is deliberately second, not
// first: anything relying on redaction alone is one unknown field away from
// leaking.

/**
 * R02 §14 — the only error fields that may be serialized into evidence.
 *
 * Every entry is a scalar diagnostic value from the PostgreSQL error protocol or
 * a JS Error. Notably absent, and absent on purpose: `client`, `connection`,
 * `pool`, `config`, `connectionParameters`, `_events`, `stack`-attached objects.
 */
const ALLOWED_ERROR_FIELDS = [
    "name",
    "message",
    "code",
    "severity",
    "detail",
    "hint",
    "position",
    "where",
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
    "file",
    "line",
    "routine"
] as const;

/** Values that must never reach evidence, gathered at call time from the environment. */
function secretValues(): string[] {
    const out: string[] = [];
    for (const key of ["PGPASSWORD", "IRF_BRIDGE_TOKEN", "DATABASE_URL", "POSTGRES_PASSWORD"]) {
        const v = process.env[key];
        // Very short values would redact half the document; a real secret is not 6 chars.
        if (v && v.length >= 8) out.push(v);
    }
    return out;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const REDACTION_MARK = "[REDACTED-QCP2A-R02]";

/**
 * R02 §15 — defence-in-depth redaction over free text.
 *
 * Covers the literal secret, its URL-encoded form (a password inside a
 * connection string is percent-encoded), embedded `postgres://user:pass@host`
 * credentials, and `Authorization: Bearer` values.
 */
export function redact(text: string): string {
    if (!text) return text;
    let out = text;

    for (const secret of secretValues()) {
        out = out.split(secret).join(REDACTION_MARK);
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret) out = out.split(encoded).join(REDACTION_MARK);
        // JSON-escaped form, e.g. a password containing a quote or backslash.
        const jsonEscaped = JSON.stringify(secret).slice(1, -1);
        if (jsonEscaped !== secret) out = out.split(jsonEscaped).join(REDACTION_MARK);
    }

    // Structural patterns, so a rotated-but-still-present or unknown credential
    // is still caught even though it is not in this process's environment.
    out = out.replace(
        /(postgres(?:ql)?:\/\/[^:@\s"']+:)([^@\s"']+)(@)/gi,
        `$1${REDACTION_MARK}$3`
    );
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTION_MARK}`);
    out = out.replace(
        /(["']?(?:password|pgpassword|postgres_password)["']?\s*[:=]\s*["']?)([^\s,"'}]{8,})/gi,
        `$1${REDACTION_MARK}`
    );

    return out;
}

/** True if any known live secret still appears in the text. Used for scan gates. */
export function containsSecret(text: string): boolean {
    if (!text) return false;
    for (const secret of secretValues()) {
        if (text.includes(secret)) return true;
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret && text.includes(encoded)) return true;
    }
    return false;
}

/**
 * R02 §14 — allowlisted error description.
 *
 * Copies only named scalar fields. Anything non-scalar is dropped rather than
 * stringified, because "stringify whatever is there" is precisely the behaviour
 * that leaked the password.
 */
export function describeError(e: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const src = (e ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const field of ALLOWED_ERROR_FIELDS) {
        const v = src[field];
        if (v === undefined || v === null) continue;
        if (typeof v === "string") out[field] = redact(v);
        else if (typeof v === "number" || typeof v === "boolean") out[field] = v;
        // Objects are deliberately dropped, not serialized.
    }

    if (out["message"] === undefined) {
        // Non-Error throwables still need a message, but it goes through redact
        // and is length-capped so a stray object dump cannot become a payload.
        out["message"] = redact(String(e)).slice(0, 2000);
    }

    out["timestamp"] = new Date().toISOString();
    for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        out[k] = typeof v === "string" ? redact(v) : v;
    }
    return out;
}
