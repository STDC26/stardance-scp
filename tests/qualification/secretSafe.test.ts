// SCP-RUNTIME-Q01B-QCP2A-R02 §23 — safe serialization proof.
//
// Qualification harness tests. These do not touch the pinned G11 battery.
//
// The defect being guarded against (QCP2A-D03) was subtle: nobody logged a
// password. A pg error carries a reference to the `client` that raised it, a
// pg Client holds `connectionParameters.password`, and a generic deep serializer
// — Vitest's uncaught-error reporter — walked the graph and printed it.
//
// So these tests build an error shaped exactly like the real one, with the
// credential buried at several depths, and assert it cannot escape through any
// surface R02 §13 names.

import { beforeAll, describe, expect, it } from "vitest";
import { describeError, redact, containsSecret, REDACTION_MARK } from "../../src/qualification/secretSafe";

const FAKE_PASSWORD = "s3cr3t-qualification-password-DO-NOT-LEAK";
const FAKE_TOKEN = "irf-bridge-token-abcdefghijklmnop-DO-NOT-LEAK";

/** Shaped after the real 57P01 error observed in the R01 evidence. */
function syntheticPgError(): Record<string, unknown> {
    const client = {
        _events: { error: () => undefined },
        connectionParameters: {
            user: "postgres",
            password: FAKE_PASSWORD,
            host: "postgres.railway.internal",
            port: 5432
        },
        password: FAKE_PASSWORD,
        connection: {
            stream: { _host: "postgres.railway.internal" },
            password: FAKE_PASSWORD
        }
    };
    const err = new Error("terminating connection due to administrator command") as Error &
        Record<string, unknown>;
    err.length = 116;
    err.severity = "FATAL";
    err.code = "57P01";
    err.file = "postgres.c";
    err.line = "3354";
    err.routine = "ProcessInterrupts";
    err.client = client;
    err.pool = { options: { password: FAKE_PASSWORD } };
    err.config = { connectionString: `postgres://postgres:${FAKE_PASSWORD}@postgres.railway.internal:5432/railway` };
    return err as unknown as Record<string, unknown>;
}

describe("QCP2A-R02 secret-safe evidence serialization", () => {
    beforeAll(() => {
        process.env["PGPASSWORD"] = FAKE_PASSWORD;
        process.env["IRF_BRIDGE_TOKEN"] = FAKE_TOKEN;
    });

    it("describeError does not leak a credential nested in the error's client graph", () => {
        const serialized = JSON.stringify(describeError(syntheticPgError()));
        expect(serialized).not.toContain(FAKE_PASSWORD);
        expect(containsSecret(serialized)).toBe(false);
    });

    it("describeError preserves the diagnostic fields evidence actually needs", () => {
        const d = describeError(syntheticPgError());
        expect(d["code"]).toBe("57P01");
        expect(d["severity"]).toBe("FATAL");
        expect(d["routine"]).toBe("ProcessInterrupts");
        expect(d["message"]).toBe("terminating connection due to administrator command");
        expect(d["file"]).toBe("postgres.c");
        expect(d["timestamp"]).toBeTypeOf("string");
    });

    it("describeError drops secret-bearing object graphs entirely rather than stringifying them", () => {
        const d = describeError(syntheticPgError());
        // The allowlist is the control: these keys must not survive at all.
        expect(d["client"]).toBeUndefined();
        expect(d["pool"]).toBeUndefined();
        expect(d["config"]).toBeUndefined();
        expect(d["connectionParameters"]).toBeUndefined();
    });

    it("redact removes the raw credential from free text", () => {
        const text = `error: password authentication failed for "${FAKE_PASSWORD}"`;
        const out = redact(text);
        expect(out).not.toContain(FAKE_PASSWORD);
        expect(out).toContain(REDACTION_MARK);
    });

    it("redact removes URL-encoded and connection-string credential forms", () => {
        const encoded = encodeURIComponent(FAKE_PASSWORD);
        expect(redact(`db=${encoded}`)).not.toContain(encoded);
        const conn = `postgres://postgres:${FAKE_PASSWORD}@postgres.railway.internal:5432/railway`;
        expect(redact(conn)).not.toContain(FAKE_PASSWORD);
    });

    it("redact removes Authorization Bearer values", () => {
        expect(redact(`authorization: Bearer ${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
    });

    it("redact catches a credential-shaped pattern even when the value is unknown to this process", () => {
        // An already-rotated or third-party credential is not in our env, so the
        // literal match cannot fire. The structural pattern still must.
        const foreign = "postgres://someuser:unknown-other-secret-value@host:5432/db";
        expect(redact(foreign)).not.toContain("unknown-other-secret-value");
    });

    it("redact leaves ordinary evidence text intact", () => {
        const text = "G11-T04 lostUpdates=7 finalCounter=1 exit_code=0";
        expect(redact(text)).toBe(text);
    });

    it("a full stderr-shaped dump containing the credential is scrubbed", () => {
        const dump = `Serialized Error: { severity: 'FATAL', code: '57P01', client: { connectionParameters: { password: '${FAKE_PASSWORD}' } } }`;
        const out = redact(dump);
        expect(out).not.toContain(FAKE_PASSWORD);
        expect(containsSecret(out)).toBe(false);
    });
});
