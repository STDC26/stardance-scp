// SCP-RUNTIME-Q01B-QCP2A-R02 — qualification-only Vitest config.
//
// Used ONLY by the IRF proof bridge when it runs the pinned G11 battery. The
// default `vitest.config.ts` is untouched, so `npm test`, CI and every other
// run are completely unaffected by this file.
//
// It exists because `--setupFiles` is not a Vitest CLI option in 1.6.1 —
// setup files can only be declared in config. Rather than edit the shared
// config (which would change how the battery runs for everyone, and is not
// qualification-only code), this extends it.
//
// The extension is deliberately minimal and additive: it appends the harness
// containment setup file and changes nothing else. In particular the SCP-R36
// timezone pin and `tests/support/timezoneGuard.ts` are preserved in their
// original position and order, because dropping either would silently change
// the battery's execution semantics — exactly the class of defect R36 existed
// to close.

import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Importing the base config also executes its TZ pin, which must happen before
// any worker forks.
const baseTest = baseConfig.test ?? {};

export default defineConfig({
    ...baseConfig,
    test: {
        ...baseTest,
        setupFiles: [
            // Unchanged, and still first.
            "./tests/support/timezoneGuard.ts",
            // QCP2A-R02-D02: contains the connection terminations G11-T11
            // deliberately causes. Adds pg error listeners only — no test,
            // assertion or T11 semantics are modified.
            "./src/qualification/g11HarnessSetup.ts"
        ]
    }
});
