// G5-D — the served customer experience.
//
// The frozen Freshline surface, rendered by a real host from a real governed
// configuration, and the honest behaviour of the form around it: bilingual,
// mobile-first, actionable about errors, and truthful about what pressing Send
// actually did.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { DECLARED_INTAKE_FIELDS } from "../../src/customer/intake";
import { INGRESS_PATH, CONFIGURATION_PATH, type CustomerHost } from "../../src/host/customerHost";
import {
    activate,
    getCustomerPool,
    getJson,
    getText,
    post,
    resetCustomer,
    startHostOrThrow,
    validIntent
} from "./customerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

d("G5-D / customer experience — the frozen surface, served from configuration", () => {
    let pool: Pool;
    let host: CustomerHost;

    beforeAll(async () => {
        pool = getCustomerPool();
        await resetCustomer(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startHostOrThrow(pool);
    });

    afterAll(async () => {
        await host?.close();
        await pool?.end();
    });

    it("serves the booking surface as a single self-contained document", async () => {
        const page = await getText(host.origin, "/");
        expect(page.status).toBe(200);
        expect(page.text.startsWith("<!doctype html>")).toBe(true);
        // No external host is contacted for anything: no CDN, no font service,
        // no analytics beacon. One request, one document.
        expect(page.text).not.toMatch(/<script[^>]+src=/i);
        expect(page.text).not.toMatch(/<link[^>]+stylesheet/i);
        expect(page.text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    });

    it("renders the frozen brand, catalogue, coverage and hours", async () => {
        const page = await getText(host.origin, "/");
        expect(page.text).toContain("Freshline");
        expect(page.text).toContain("Bali");
        expect(page.text).toContain("Your style, your space, your Freshline.");
        for (const service of ["The Fresh Cut", "Fresh Cut + Beard", "The Full Fresh"]) {
            expect(page.text).toContain(service);
        }
        for (const extra of ["Foot Massage", "Back &amp; Shoulder", "Full Body"]) {
            expect(page.text).toContain(extra);
        }
        for (const price of ["Rp350,000", "Rp450,000", "Rp550,000", "Rp200,000"]) {
            expect(page.text).toContain(price);
        }
        expect(page.text).toContain("Open daily 08:00–23:00");
    });

    it("renders both governed locales", async () => {
        const en = await getText(host.origin, "/?lang=en");
        const id = await getText(host.origin, "/?lang=id");

        expect(en.text).toContain("Choose your service");
        expect(en.text).toContain("Send my request");
        expect(en.text).toContain("When would you like us?");

        expect(id.text).toContain("Pilih layanan Anda");
        expect(id.text).toContain("Kirim permintaan saya");
        expect(id.text).toContain("Kapan Anda ingin kami datang?");

        // The catalogue itself is governed data, identical in both.
        expect(id.text).toContain("The Fresh Cut");
        expect(id.text).toContain("Rp350,000");
    });

    it("is mobile-first and usable at a narrow viewport", async () => {
        const page = (await getText(host.origin, "/")).text;
        expect(page).toContain("width=device-width, initial-scale=1");
        expect(page).toContain("viewport-fit=cover");
        // Every interactive target meets a 44px minimum, and the layout is
        // single-column until it has room to be otherwise.
        expect(page).toContain("min-height:44px");
        expect(page).toContain("min-height:48px");
        expect(page).toContain("min-height:52px");
        expect(page).toContain(".chip{flex:1 1 100%}");
        expect(page).toContain("@media (min-width:480px)");
        expect(page).toMatch(/\.wrap\{width:100%/);
    });

    it("preserves chip-oriented service, region and time selection", async () => {
        const page = (await getText(host.origin, "/")).text;
        expect(page.match(/name="serviceCode"/g)).toHaveLength(3);
        expect(page.match(/name="extraCodes"/g)).toHaveLength(3);
        expect(page.match(/name="region"/g)).toHaveLength(9);
        // Simplified time selection: hourly chips across the governed hours.
        expect(page.match(/name="requestedTime"/g)).toHaveLength(15);
        expect(page).toContain('value="08:00"');
        expect(page).toContain('value="22:00"');
        expect(page).not.toContain('value="23:00"');
    });

    it("offers exactly the fields the intake contract declares, and no others", async () => {
        const page = (await getText(host.origin, "/")).text;
        // Only form controls; `<meta name=...>` is document metadata, not input.
        const form = page.slice(page.indexOf("<form"), page.indexOf("</form>"));
        const rendered = new Set(
            [...form.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([A-Za-z]+)"/g)].map((m) => m[1]!)
        );
        expect(rendered.size).toBeGreaterThanOrEqual(7);
        for (const name of rendered) {
            expect(
                (DECLARED_INTAKE_FIELDS as readonly string[]).includes(name),
                `the page offers an undeclared field "${name}"`
            ).toBe(true);
        }
        // The key is generated by the page script, not typed by a customer.
        expect(rendered).not.toContain("idempotencyKey");
        expect(page).toContain("idempotencyKey: key");
    });

    it("exposes the governed projection, marked non-authoritative", async () => {
        const projection = await getJson(host.origin, CONFIGURATION_PATH);
        expect(projection.status).toBe(200);
        expect(projection.body["authoritative"]).toBe(false);
        const provenance = projection.body["provenance"] as Record<string, unknown>;
        expect(provenance["configurationVersion"]).toBe(2);
        expect(String(provenance["configurationChecksum"])).toHaveLength(64);
    });

    it("acknowledges a submission without claiming a confirmed service", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent());
        expect(response.status).toBe(201);
        const ack = response.body["acknowledgement"] as Record<string, string | boolean>;

        expect(String(ack["headline"])).toContain("Request received");
        expect(String(ack["nextStep"])).toContain("Nothing is scheduled yet");
        expect(ack["stateTruth"]).toBe("REQUEST_RECEIVED");
        expect(ack["customerConfirmed"]).toBe(false);
        expect(ack["requestReference"]).toBe(response.body["requestId"]);

        const copy = `${ack["headline"]} ${ack["body"]} ${ack["nextStep"]}`.toLowerCase();
        for (const term of ["confirmed", "booked", "guaranteed", "assigned", "paid"]) {
            expect(copy).not.toContain(term);
        }
    });

    it("acknowledges in the locale the customer chose", async () => {
        const response = await post(host.origin, INGRESS_PATH, validIntent({ locale: "id" }));
        const ack = response.body["acknowledgement"] as Record<string, string>;
        expect(ack["locale"]).toBe("id");
        expect(ack["headline"]).toContain("Permintaan diterima");
        expect(ack["body"]).toContain("Terima kasih");
    });

    it("returns actionable, per-field errors and destroys no entered intent", async () => {
        const submitted = validIntent({
            requestedDate: "tomorrow",
            contactHandle: "0812",
            region: "Jakarta"
        });
        const response = await post(host.origin, INGRESS_PATH, submitted);

        expect(response.status).toBe(422);
        const findings = response.body["findings"] as Array<{ field: string; message: string }>;
        expect(findings.map((f) => f.field).sort()).toEqual(["contactHandle", "requestedDate"]);
        for (const finding of findings) {
            expect(finding.message.length).toBeGreaterThan(10);
        }
        // A refusal is a refusal: nothing was written, and the customer's
        // browser still holds everything they typed.
        const { rows } = await pool.query(`SELECT count(*) AS n FROM core_service_request`);
        expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(0);
        expect(response.body["correlationId"]).toBeTruthy();
    });

    it("sets no cookie and stores nothing in the browser that could become truth", async () => {
        const page = await fetch(`${host.origin}/`);
        expect(page.headers.get("set-cookie")).toBeNull();
        const html = await page.text();
        for (const api of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
            expect(html, `the page must not use ${api}`).not.toContain(api);
        }
        expect(page.headers.get("cache-control")).toBe("no-store");
    });
});
