// LAB-INFRA-01 §16 — proof for the Experience Lab transport.
//
// These tests exercise the handler the way the platform does, over a real
// socket, because the defect this work exists to fix was never a compilation
// defect — it was a runtime-detection defect. A test that called the handler
// function directly would have passed just as happily on the deployment that
// failed.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleLabsRequest, LABS_HEALTH_PATH } from "../../src/server";

let server: Server;
let origin: string;

/**
 * The structural guards below are about what the transport DOES, so they must
 * read code and not prose — a comment explaining that the config plane is off
 * limits is evidence of the boundary, not a breach of it.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

beforeEach(async () => {
    server = createServer(handleLabsRequest);

    await new Promise<void>((resolve) => {
        // Port 0 — the OS picks a free port, so the suite never collides with a
        // developer's running host.
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

describe("LAB-INFRA-01 T1 — health endpoint", () => {
    it("answers GET /labs/health with 200 and the declared payload", async () => {
        const response = await fetch(`${origin}${LABS_HEALTH_PATH}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        // A cached health answer is a memory, not a measurement.
        expect(response.headers.get("cache-control")).toBe("no-store");

        await expect(response.json()).resolves.toEqual({
            service: "stardance-scp",
            environment: "experience-lab",
            status: "ok"
        });
    });

    it("refuses a non-read method on the health route", async () => {
        const response = await fetch(`${origin}${LABS_HEALTH_PATH}`, { method: "POST" });

        expect(response.status).toBe(405);
    });
});

describe("LAB-INFRA-01 T2 — unknown route", () => {
    it("answers GET /unknown with 404", async () => {
        const response = await fetch(`${origin}/unknown`);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "NOT_FOUND" });
    });

    it("does not treat the /labs namespace as a wildcard", async () => {
        // `/labs` is a path namespace the router may discriminate (spec §10),
        // not a catch-all that answers for routes nobody has built yet.
        for (const path of ["/labs", "/labs/", "/labs/freshline", "/labs/athena"]) {
            const response = await fetch(`${origin}${path}`);
            expect(response.status).toBe(404);
        }
    });
});

describe("LAB-INFRA-01 T3 — no business mutation", () => {
    it("serves health with no database configuration present at all", async () => {
        const pgKeys = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "DATABASE_URL"];
        const saved = new Map(pgKeys.map((key) => [key, process.env[key]]));

        for (const key of pgKeys) {
            delete process.env[key];
        }

        try {
            const response = await fetch(`${origin}${LABS_HEALTH_PATH}`);
            expect(response.status).toBe(200);
        } finally {
            for (const [key, value] of saved) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    it("keeps the transport free of persistence, config-plane and domain imports", () => {
        // A structural guard, not a runtime one. The point is to fail the build
        // the first time someone reaches for the database or the config plane
        // from the transport — spec §17 INFRA-01-08 and AGENTS.md Rule 1 — at
        // which moment this file stops being a transport.
        const code = stripComments(readFileSync(join(__dirname, "..", "..", "src", "server.ts"), "utf8"));
        const imports = code.match(/^\s*import[\s\S]*?from\s+"([^"]+)";/gm) ?? [];

        const forbidden = imports.filter((line) => !line.includes('from "node:'));

        expect(forbidden).toEqual([]);
        expect(code).not.toMatch(/\bmarket\.json\b/);
        expect(code).not.toMatch(/getActiveMarketConfig|loadMarketConfig/);
    });

    it("exposes no credential or host material in the health payload", async () => {
        const body = await (await fetch(`${origin}${LABS_HEALTH_PATH}`)).text();

        for (const forbidden of ["PGPASSWORD", "password", "postgres://", "postgresql://", "railway.internal"]) {
            expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
    });
});

describe("LAB-INFRA-01 — Vercel adapter parity", () => {
    it("delegates to the same handler rather than routing on its own", () => {
        const source = stripComments(readFileSync(join(__dirname, "..", "..", "api", "index.ts"), "utf8"));

        expect(source).toContain("handleLabsRequest");
        // No second route table. If the adapter starts deciding paths, the Lab
        // and local development can disagree and the tests would not know.
        expect(source).not.toMatch(/pathname|writeHead|createServer/);
    });
});
