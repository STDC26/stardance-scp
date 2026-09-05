# AGENTS.md — Freshline Studio Bali / MSOS Core

Repository-wide rules for any agent (human or AI) making behavioral or
structural changes to this codebase. These are invariants, not
suggestions — a change that violates one of these should not be merged
without an explicit, documented exception from a human maintainer.

## Multi-Market Configuration Invariant

**Architecture strategy: 1:MANY INSIDE, 1:1 OUTSIDE.**

- **1:MANY INSIDE** — this is a single codebase. Core services
  (`src/services/*`) are written once and must run correctly for every
  market this business operates in. Do not fork a service file per market
  ("`bookingValidator.bangkok.ts`"). If a market genuinely needs different
  *logic* (not just different parameters), that is a design escalation, not
  a copy-paste.
- **1:1 OUTSIDE** — every market's parameters live in exactly one file:
  `config/<marketId>.market.json`. There is no fallback, no merge, and no
  inheritance between market config files. A request for market A must
  never silently read a value from market B's config, including as an
  error-recovery default.

### Rule 1 — Read market state through the config plane, not around it

Any future behavioral modification or feature expansion **must** read its
market-specific parameters (timezone, operating hours, dispatch timeout,
billing code format, currency, feature flags) from the active
`config/<marketId>.market.json` file, via `src/config/marketConfig.ts`
(`getActiveMarketConfig()` / `loadMarketConfig(marketId)`).

- Do not import a `config/*.market.json` file directly from a service —
  always go through `marketConfig.ts`, so there is exactly one chokepoint
  that can validate shape, log the resolved market, and enforce the
  no-fallback rule above.
- Do not read `process.env.ACTIVE_MARKET` (or any market-selection signal)
  from more than one place. `marketConfig.ts` is that one place.
- Adding a market means adding one new `config/<marketId>.market.json` file
  and registering it in `marketConfig.ts`'s `REGISTRY`. It must never
  require editing an existing market's file or a core service's logic.

### Rule 2 — No hardcoded currency, locale, or geography in core services

Hardcoding a local currency symbol/code, a country name, a UTC offset, a
business-hours number, or any other market-specific literal directly
inside `src/services/*` (or any future core service) is **strictly
prohibited**. This includes, non-exhaustively:

- Currency strings/symbols (`"Rp"`, `"IDR"`, `"฿"`, `"THB"`, ...)
- Country or city names used for anything other than logging/display of a
  value that itself came from config (`"Bali"`, `"Bangkok"`, `"Indonesia"`,
  `"Thailand"`, ...)
- Timezone identifiers (`"Asia/Makassar"`, `"Asia/Bangkok"`, ...) — these
  must come from `config.timezone`, not a literal in service code
- Fixed clock-hour numbers for opening/closing (`23`, `9`, ...)
- The billing-code prefix/pattern (`"FL-"`, the `FL-######-XXXX` regex) —
  these must come from `config.billing`, not a literal in service code
- Dispatch/timeout minute counts

**Why:** the moment a second market (Bangkok) exists, a hardcoded literal
that happened to be correct for the first market becomes a silent
correctness bug for every other market that hits that code path — exactly
the class of bug the closing-ceiling and billing-code validators in Phase
0/1 were built to prevent, reintroduced at the config layer instead of the
business-logic layer.

Existing Phase 0/1 constants (`STUDIO_TIMEZONE`, `CLOSING_HOUR`,
`OPENING_HOUR` in `src/services/bookingValidator.ts`;
`DEFAULT_TIMEOUT_MINUTES` in `src/services/timeoutRecovery.ts`; the
`FL-[0-9]{6}-[A-Z0-9]{4}` pattern in `src/services/whatsappParser.ts` and
`db/schema.sql`) predate this invariant and were written when Bali was the
only market. **They are grandfathered, not exempt** — the first change
that touches any of those modules for a market-expansion reason must
migrate that constant to read from `getActiveMarketConfig()` as part of
the same change, not defer it.

### Rule 3 — Localized strings follow the same isolation principle

Customer-facing text must be sourced from `src/localization/strings.json`
(keyed by field, then by locale), never inlined per-market in a service or
frontend component. See that file's `_meta.reviewStatus` before treating
any non-English string as production-verified — draft translations require
native-speaker QA before shipping to customers.

## Enforcement

There is no automated lint rule for Rule 2 yet (grep for common offenders —
currency symbols, `Asia/`, raw two-letter country codes — during review
until one exists). Flag any hardcoded market literal found in review as a
blocking comment, not a nit.
