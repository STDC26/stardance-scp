// SCP-R36 — the host timezone is a declared test input, not an accident.
//
// Before this, `TZ` was pinned nowhere: whatever timezone the developer's or
// CI machine happened to be in silently became part of every proof. That is
// how the R42 calendar-date defect stayed hidden for a whole gate — the suite
// was green on a negative-offset host and red in the market's own timezone,
// and nothing in the configuration said which one a green result meant.
//
// The zone itself is declared in `vitest.config.ts`, which is evaluated before
// any worker forks. This file verifies it actually took. Verification matters
// as much as the setting: Node resolves its timezone lazily and caches it, so a
// runner that failed to apply the value would fall back to the machine's own
// zone and every proof would silently be about the wrong place. A run that
// cannot honour its declared timezone fails loudly instead.
//
// Overriding is the ordinary thing: `TZ=Asia/Makassar npx vitest run`. The
// timezone a result was produced under is therefore always visible and
// reproducible. None of this touches the production runtime timezone, which
// comes from market configuration and is unchanged.

import { beforeAll } from "vitest";

/** UTC by default so an unpinned machine cannot decide what a proof means. */
export const DECLARED_TZ = process.env["TZ"] ?? "UTC";

function effectiveZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

if (effectiveZone() !== DECLARED_TZ) {
    throw new Error(
        `test timezone control failed at load: declared TZ=${DECLARED_TZ} but the ` +
            `runtime resolved ${effectiveZone()}.`
    );
}

beforeAll(() => {
    const effective = effectiveZone();
    if (effective !== DECLARED_TZ) {
        throw new Error(
            `test timezone control failed: declared TZ=${DECLARED_TZ} but the runtime ` +
                `resolved ${effective}. A proof produced under an undeclared timezone is ` +
                `not a proof — fix the runner configuration rather than the assertion.`
        );
    }
});
