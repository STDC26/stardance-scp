// G5-E — provider profile ingress, Provider Card and the separate Owner approval.
//
// BP01 profile submission is not approval
// BP02 card approval is a distinct, auditable act
// BP03 the Partner ID is server authority
// BP12 idempotency
// BP16 configuration consumption
// BP18 locale-neutral truth

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "../../src/db/pool";
import { FRESHLINE_BALI_V2 } from "../../src/config/tenant/freshline";
import { approvedSupply } from "../../src/provider/supply";
import type { PartnerHost } from "../../src/host/partnerHost";
import {
    SCOPE,
    activate,
    bundleAtVersion,
    call,
    enrol,
    futureMonday,
    getProviderPool,
    ownerSession,
    resetProvider,
    startPartnerOrThrow,
    validProfile,
    week
} from "./providerTestDb";

const RUN = process.env["RUN_INTEGRATION"] === "1";
const d = RUN ? describe : describe.skip;

async function supplyStatus(pool: Pool, providerId: string): Promise<string> {
    const { rows } = await pool.query<{ supply_status: string }>(
        `SELECT supply_status FROM core_provider WHERE provider_id = $1`,
        [providerId]
    );
    return rows[0]!.supply_status;
}

async function count(pool: Pool, table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params
    );
    return Number(rows[0]!.n);
}

d("G5-E / provider ingress — profile submission is an application, not supply", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    it("BP01 — a valid profile creates a Provider that is NOT approved or dispatchable", async () => {
        const { token } = await enrol(host.origin);
        const response = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });

        expect(response.status).toBe(201);
        expect(response.body["version"]).toBe(1);
        expect(response.body["supplyStatus"]).toBe("SUBMITTED");

        const providerId = response.body["providerId"] as string;
        expect(await supplyStatus(pool, providerId)).toBe("SUBMITTED");

        // Nothing that could make this provider dispatchable exists yet.
        expect(await count(pool, "core_provider_public_id")).toBe(0);
        expect(await count(pool, "core_provider_service")).toBe(0);
        expect(await count(pool, "core_capacity_window")).toBe(0);
        // And the identity holds no PROVIDER role, so it has no authority to
        // respond to a dispatch offer either.
        expect(
            await count(
                pool,
                "core_identity_role r JOIN core_provider p ON p.identity_id = r.identity_id",
                "p.provider_id = $1",
                [providerId]
            )
        ).toBe(0);
    });

    it("stores the accepted Freshline profile fields as canonical truth", async () => {
        const { token } = await enrol(host.origin);
        const response = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile({
                profileChips: ["CALM", "PUNCTUAL"],
                howYouWork: "I bring everything with me.",
                aboutMe: "Ten years in Seminyak."
            })
        });
        const { rows } = await pool.query<{
            legal_name: string;
            display_name: string;
            contact_handle: string;
            role_code: string;
            service_codes: string[];
            how_you_work: string;
            about_me: string;
            profile_chips: string[];
            tenant_id: string;
            market_id: string;
            environment: string;
        }>(`SELECT * FROM core_provider_profile WHERE profile_id = $1`, [response.body["profileId"]]);
        const row = rows[0]!;

        expect(row.legal_name).toBe("I Wayan Sudiarta");
        expect(row.display_name).toBe("Wayan");
        expect(row.contact_handle).toBe("+628131234567");
        expect(row.role_code).toBe("BB");
        expect(row.service_codes).toEqual(["FRESH_CUT", "FRESH_CUT_BEARD"]);
        expect(row.how_you_work).toBe("I bring everything with me.");
        expect(row.about_me).toBe("Ten years in Seminyak.");
        expect(row.profile_chips).toEqual(["CALM", "PUNCTUAL"]);
        expect({ t: row.tenant_id, m: row.market_id, e: row.environment }).toEqual({
            t: SCOPE.tenantId,
            m: SCOPE.marketId,
            e: SCOPE.environment
        });
    });

    it("BP16 — refuses a role code or capability the governed configuration does not carry", async () => {
        const { token } = await enrol(host.origin);
        expect(
            (
                await call(host.origin, "POST", "/api/partner/profile", {
                    token,
                    body: validProfile({ roleCode: "ZZ" })
                })
            ).body["error"]
        ).toBe("ROLE_CODE_UNSUPPORTED");

        expect(
            (
                await call(host.origin, "POST", "/api/partner/profile", {
                    token,
                    body: validProfile({ serviceCodes: ["NOT_A_SERVICE"] })
                })
            ).body["error"]
        ).toBe("SERVICE_CODE_UNKNOWN");

        expect(
            (
                await call(host.origin, "POST", "/api/partner/profile", {
                    token,
                    body: validProfile({ locale: "fr" })
                })
            ).body["error"]
        ).toBe("LOCALE_UNSUPPORTED");

        expect(await count(pool, "core_provider")).toBe(0);
    });

    it("refuses a capability withdrawn by a later governed configuration version", async () => {
        await activate(
            pool,
            bundleAtVersion(3, (b) => {
                b.planes.CATALOGUE.services[0]!.active = false;
            })
        );
        await host.close();
        host = await startPartnerOrThrow(pool);

        const { token } = await enrol(host.origin);
        const response = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile({ serviceCodes: ["FRESH_CUT"] })
        });
        expect(response.body["error"]).toBe("SERVICE_CODE_INACTIVE");
    });

    it("appends a new profile version on edit rather than rewriting the old one", async () => {
        const { token } = await enrol(host.origin);
        const first = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const second = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile({ aboutMe: "Now also doing beards." })
        });

        expect(first.body["providerId"]).toBe(second.body["providerId"]);
        expect(second.body["version"]).toBe(2);
        expect(await count(pool, "core_provider_profile")).toBe(2);

        // The first version is immutable history, not a row to be edited.
        await expect(
            pool.query(`UPDATE core_provider_profile SET about_me = 'x' WHERE profile_id = $1`, [
                first.body["profileId"]
            ])
        ).rejects.toThrow(/append-only/);
    });

    it("BP12 — an idempotent replay reuses the provider rather than duplicating it", async () => {
        const { token } = await enrol(host.origin);
        const body = validProfile({ idempotencyKey: "pp-replay-0001" });

        const first = await call(host.origin, "POST", "/api/partner/profile", { token, body });
        const second = await call(host.origin, "POST", "/api/partner/profile", { token, body });

        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body["replay"]).toBe(true);
        expect(second.body["providerId"]).toBe(first.body["providerId"]);
        expect(await count(pool, "core_provider")).toBe(1);
        expect(await count(pool, "core_provider_profile")).toBe(1);
    });

    it("a reused key carrying different intent fails deterministically", async () => {
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile({ idempotencyKey: "pp-conflict-0001" })
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const conflict = await call(host.origin, "POST", "/api/partner/profile", {
                token,
                body: validProfile({ idempotencyKey: "pp-conflict-0001", roleCode: "MS" })
            });
            expect(conflict.status).toBe(409);
            expect(conflict.body["error"]).toBe("IDEMPOTENCY_KEY_CONFLICT");
        }
        expect(await count(pool, "core_provider_profile")).toBe(1);
    });

    it("simultaneous identical submissions create exactly one Provider", async () => {
        const { token } = await enrol(host.origin);
        const body = validProfile({ idempotencyKey: "pp-race-0001" });
        const responses = await Promise.all(
            Array.from({ length: 8 }, () =>
                call(host.origin, "POST", "/api/partner/profile", { token, body })
            )
        );
        const created = responses.filter((r) => r.status === 201);
        expect(created).toHaveLength(1);
        for (const response of responses) {
            expect([200, 201]).toContain(response.status);
            expect(response.body["providerId"]).toBe(created[0]!.body["providerId"]);
        }
        expect(await count(pool, "core_provider")).toBe(1);
        expect(await count(pool, "core_provider_profile")).toBe(1);
    });
});

d("G5-E / Provider Card — submission, Owner approval and activation are three acts", () => {
    let pool: Pool;
    let host: PartnerHost;
    let owner: { identityId: string; token: string };

    beforeEach(async () => {
        pool = getProviderPool();
        await resetProvider(pool);
        await activate(pool, FRESHLINE_BALI_V2);
        host = await startPartnerOrThrow(pool);
        owner = await ownerSession(pool, host);
    });

    afterEach(async () => {
        await host?.close();
        await pool?.end();
    });

    async function partnerWithCard() {
        const { token } = await enrol(host.origin);
        const profile = await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile()
        });
        const card = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        return {
            token,
            providerId: profile.body["providerId"] as string,
            cardId: card.body["cardId"] as string,
            card
        };
    }

    it("BP02 — submitting a card activates nothing", async () => {
        const { providerId, card } = await partnerWithCard();

        expect(card.status).toBe(201);
        expect(card.body["state"]).toBe("SUBMITTED");
        expect(card.body["supplyStatus"]).toBe("SUBMITTED");
        expect(card.body["publicId"]).toBeNull();

        expect(await supplyStatus(pool, providerId)).toBe("SUBMITTED");
        expect(await count(pool, "core_provider_public_id")).toBe(0);
        expect(await count(pool, "core_provider_service")).toBe(0);
    });

    it("BP02 — Owner approval is explicit, auditable and activates supply", async () => {
        const { providerId, cardId } = await partnerWithCard();

        const approved = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId, reason: "Documents verified in person." }
        });

        expect(approved.status).toBe(201);
        expect(approved.body["state"]).toBe("APPROVED");
        expect(approved.body["supplyStatus"]).toBe("APPROVED");
        expect(await supplyStatus(pool, providerId)).toBe("APPROVED");

        // The decision names who made it and when.
        const { rows } = await pool.query<{
            decided_by_identity_id: string;
            decided_at: Date;
            decision_reason: string;
        }>(`SELECT decided_by_identity_id, decided_at, decision_reason FROM core_provider_card WHERE card_id = $1`, [
            cardId
        ]);
        expect(rows[0]!.decided_by_identity_id).toBe(owner.identityId);
        expect(rows[0]!.decided_at).toBeInstanceOf(Date);
        expect(rows[0]!.decision_reason).toBe("Documents verified in person.");

        // The canonical PROVIDER event is written by the G2 Core command.
        const events = await pool.query<{ from_state: string; to_state: string; actor_role: string }>(
            `SELECT from_state, to_state, actor_role FROM core_event
              WHERE object_type = 'PROVIDER' AND object_id = $1`,
            [providerId]
        );
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0]).toMatchObject({
            from_state: "SUBMITTED",
            to_state: "APPROVED",
            actor_role: "OWNER"
        });

        // Capability becomes consumable only now.
        expect(await count(pool, "core_provider_service", "provider_id = $1", [providerId])).toBe(2);
    });

    it("BP02 — approving a card confirms no schedule", async () => {
        const { token, cardId, providerId } = await partnerWithCard();
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId }
        });
        const weekStartDate = futureMonday();
        await call(host.origin, "POST", "/api/partner/availability", {
            token,
            body: { weekStartDate, days: week() }
        });

        // Card approved, schedule submitted but unconfirmed: no approved supply.
        const supply = await withTransaction(pool, (client) =>
            approvedSupply(client, host.runtime.configuration, { weekStartDate })
        );
        expect(supply).toEqual([]);
        expect(await supplyStatus(pool, providerId)).toBe("APPROVED");
        expect(await count(pool, "core_capacity_window")).toBe(0);
    });

    it("BP03 — the Partner ID is server-assigned and follows the governed prefix map", async () => {
        const first = await partnerWithCard();
        const approvedFirst = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: first.cardId }
        });
        expect(approvedFirst.body["publicId"]).toBe("BB-0001");

        const second = await partnerWithCard();
        const approvedSecond = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: second.cardId }
        });
        expect(approvedSecond.body["publicId"]).toBe("BB-0002");

        // A different governed craft draws its own sequence.
        const { token } = await enrol(host.origin);
        await call(host.origin, "POST", "/api/partner/profile", {
            token,
            body: validProfile({ roleCode: "MS", serviceCodes: ["FULL_FRESH"] })
        });
        const masseur = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        const approvedThird = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: masseur.body["cardId"] }
        });
        expect(approvedThird.body["publicId"]).toBe("MS-0001");
    });

    it("BP03 — a client cannot propose, choose or overwrite a Partner ID", async () => {
        const { token } = await enrol(host.origin);
        // There is no contract field in which to try.
        for (const field of ["publicId", "partnerId", "sequence", "roleSequence"]) {
            const attempt = await call(host.origin, "POST", "/api/partner/profile", {
                token,
                body: validProfile({ [field]: "BB-9999" })
            });
            expect(attempt.status).toBe(422);
            expect(attempt.body["error"]).toBe("UNDECLARED_FIELD");
        }

        await call(host.origin, "POST", "/api/partner/profile", { token, body: validProfile() });
        const card = await call(host.origin, "POST", "/api/partner/card", {
            token,
            body: { publicId: "BB-9999" }
        });
        expect(card.status).toBe(422);
        expect(card.body["error"]).toBe("UNDECLARED_FIELD");

        const clean = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        const approved = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId: clean.body["cardId"], publicId: "BB-9999" }
        });
        expect(approved.status).toBe(422);
        expect(approved.body["error"]).toBe("UNDECLARED_FIELD");
    });

    it("refuses a second open card, so which card an Owner approved is never ambiguous", async () => {
        const { token } = await partnerWithCard();
        const second = await call(host.origin, "POST", "/api/partner/card", { token, body: {} });
        expect(second.status).toBe(409);
        expect(second.body["error"]).toBe("CARD_ALREADY_OPEN");
    });

    it("Owner rejection leaves supply unactivated and is separately attributable", async () => {
        const { providerId, cardId } = await partnerWithCard();
        const rejected = await call(host.origin, "POST", "/api/operations/cards/reject", {
            token: owner.token,
            body: { cardId, reason: "Portrait unreadable." }
        });
        expect(rejected.status).toBe(201);
        expect(rejected.body["state"]).toBe("REJECTED");
        expect(rejected.body["supplyStatus"]).toBe("SUBMITTED");
        expect(await supplyStatus(pool, providerId)).toBe("SUBMITTED");
        expect(await count(pool, "core_provider_public_id")).toBe(0);
    });

    it("BP12 — approving twice with the same key is a replay, not a second activation", async () => {
        const { providerId, cardId } = await partnerWithCard();
        const body = { cardId, idempotencyKey: "ca-replay-0001" };

        const first = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body
        });
        const second = await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body
        });

        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body["replay"]).toBe(true);
        expect(second.body["publicId"]).toBe(first.body["publicId"]);
        expect(await count(pool, "core_provider_public_id", "provider_id = $1", [providerId])).toBe(1);
        // One activation, one canonical event.
        expect(
            await count(pool, "core_event", "object_type = 'PROVIDER' AND object_id = $1", [providerId])
        ).toBe(1);
    });

    it("BP18 — the same profile in Indonesian produces identical canonical truth", async () => {
        const en = await enrol(host.origin);
        const enProfile = await call(host.origin, "POST", "/api/partner/profile", {
            token: en.token,
            body: validProfile({ locale: "en" })
        });
        const id = await enrol(host.origin);
        const idProfile = await call(host.origin, "POST", "/api/partner/profile", {
            token: id.token,
            body: validProfile({ locale: "id" })
        });

        const rows = await pool.query<{ role_code: string; service_codes: string[] }>(
            `SELECT role_code, service_codes FROM core_provider_profile
              WHERE profile_id = ANY($1::uuid[]) ORDER BY created_at`,
            [[enProfile.body["profileId"], idProfile.body["profileId"]]]
        );
        expect(rows.rows[0]!.role_code).toBe(rows.rows[1]!.role_code);
        expect(rows.rows[0]!.service_codes).toEqual(rows.rows[1]!.service_codes);
        // Locale is a presentation choice; it appears nowhere in canonical
        // provider truth.
        const columns = await pool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'core_provider_profile' AND column_name LIKE '%locale%'`
        );
        expect(columns.rows).toEqual([]);
    });

    it("records provider ingress as runtime evidence without granting it authority", async () => {
        const { cardId } = await partnerWithCard();
        await call(host.origin, "POST", "/api/operations/cards/approve", {
            token: owner.token,
            body: { cardId }
        });
        const { rows } = await pool.query<{ kind: string; outcome: string }>(
            `SELECT kind, outcome FROM core_runtime_evidence
              WHERE tenant_id = $1 ORDER BY evidence_id`,
            [SCOPE.tenantId]
        );
        const kinds = rows.map((r) => r.kind);
        expect(kinds).toContain("SERVICE_AREA_PROJECTED");
        expect(kinds).toContain("PROVIDER_SESSION_ISSUED");
        expect(kinds).toContain("PROVIDER_INGRESS_ACCEPTED");
        expect(kinds).toContain("PROVIDER_CARD_SUBMITTED");
        expect(kinds).toContain("PROVIDER_CARD_APPROVED");

        // The provider ingress envelope is append-only.
        await expect(
            pool.query(`UPDATE core_provider_ingress SET result_ref = 'x' WHERE ingress_id = 1`)
        ).rejects.toThrow(/append-only/);
    });
});
