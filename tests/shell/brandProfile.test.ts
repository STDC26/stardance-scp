// C5 — the Freshline byte-identity proof.
//
// EXE-01A §3.3 locks the extraction: "Extract the variability seam without
// redesigning Freshline", with acceptance that rendered output is byte-identical
// where technically practical.
//
// So this hash was recorded from `renderCustomerPage` BEFORE the Brand Experience
// Profile parameter existed, and it is asserted afterwards. If the extraction had
// changed one space, one attribute order or one hex value, this test would fail.
// That is the entire point: a claim of "unchanged" that nothing checks is a hope.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { renderCustomerPage } from "../../src/host/page";
import { FRESHLINE_PROFILE } from "../../src/host/brandProfile";
import { customerProjectionFixture } from "../support/customerProjectionFixture";

/** Recorded pre-extraction. Do not update without re-proving equivalence. */
const FRESHLINE_GOLDEN_SHA256 = "82e302f2711659cba18f95e0b18ea6c56670d85ab798aed14bebc29314d6163f";

/** Recorded alongside the hash, so a size change is legible in the failure. */
const FRESHLINE_GOLDEN_BYTES = 13_838;

function renderFreshline(): string {
    return renderCustomerPage({
        projection: customerProjectionFixture(),
        locale: "en-US",
        ingressPath: "/api/customer/requests"
    });
}

describe("C5 Freshline rendering equivalence", () => {
    it("renders byte-identically to the pre-extraction golden", () => {
        const html = renderFreshline();
        const digest = createHash("sha256").update(html, "utf8").digest("hex");

        expect(Buffer.byteLength(html, "utf8")).toBe(FRESHLINE_GOLDEN_BYTES);
        expect(digest).toBe(FRESHLINE_GOLDEN_SHA256);
    });

    it("still renders byte-identically when the Freshline profile is passed explicitly", () => {
        // The default and the explicit Freshline profile must be the same thing.
        // If they can diverge, the "default is Freshline" claim is unverified.
        const explicit = renderCustomerPage({
            projection: customerProjectionFixture(),
            locale: "en-US",
            ingressPath: "/api/customer/requests",
            brandExperienceProfile: FRESHLINE_PROFILE
        });

        expect(createHash("sha256").update(explicit, "utf8").digest("hex")).toBe(
            FRESHLINE_GOLDEN_SHA256
        );
    });

    it("is deterministic across renders", () => {
        expect(renderFreshline()).toBe(renderFreshline());
    });
});
