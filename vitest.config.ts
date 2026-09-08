import { defineConfig } from "vitest/config";

/**
 * SCP-R36 — the test timezone is declared here, before any worker forks.
 *
 * `TZ` was previously pinned nowhere, so whatever timezone the developer's or
 * CI machine happened to be in silently became part of every proof. That is
 * how the R42 calendar-date defect stayed hidden for a whole gate: the suite
 * was green on a negative-offset host and red in the market's own timezone,
 * and nothing said which one a green result meant.
 *
 * Setting it in this file — which is evaluated in the runner process before
 * test workers are created — is what makes it stick; workers inherit the
 * environment. `tests/support/timezoneGuard.ts` then verifies it actually
 * took, because a silently-ignored pin is worse than none.
 *
 * Override the ordinary way: `TZ=Asia/Makassar npx vitest run`. The production
 * runtime timezone is untouched; it comes from market configuration.
 */
process.env["TZ"] = process.env["TZ"] ?? "UTC";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 20_000,
    setupFiles: ["./tests/support/timezoneGuard.ts"]
  }
});
