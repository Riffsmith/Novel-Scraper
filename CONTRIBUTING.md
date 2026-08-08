# Contributing to WebNovel Scraper

Thanks for pitching in. This file crystallizes the rules an outside contributor needs before opening a PR. The canonical rules also live in `AGENTS.md`; this is the contributor-facing summary.

## Repo layout (the hexagon, ADR-003)

```
src/core/      pure domain. Imports NOTHING from adapters/, playwright, fs, or any console/TUI library.
src/ports/     interfaces only (BrowserPort, CookieStore, ProfileStore, SessionStore,
               EpubWriter, UIAdapter, Logger).
src/adapters/  one directory per adapter (browser-playwright, store-json, store-memory,
               epub-archiver, ui-noop, ui-clack, logger-winston, cli-json, config-yaml, schemas).
src/app/       composition root. Wires adapters into core (cli.ts, runJob.ts, tui.ts, loadJobFile.ts,
               cliCommands/*).
```

Import rules:

- `core/` imports nothing from `adapters/`, `playwright`/`playwright-core`, `fs`, or `chalk`/`ora`/any console library. Core services take a `Logger` port via constructor DI, not a winston import.
- Progress and status cross boundaries as a typed `ScrapeEvent` union (`core/services/events.ts`) emitted through `UIAdapter.emit()`. Never `console.log`, `ora`, or `cli-progress` inside `core/`.
- A new cross-boundary type (cookies, job config, sessions) is defined in `core/domain/`, never inline in an adapter or in `src/types.ts`.

## `playwright-core` only

All new code imports `playwright-core`, never `playwright` (ADR-001). `playwright` stays a dependency solely as a transitive of v1 code; never add a new import of it. A repo-wide `rg "from ['\"]playwright['\"]" src/` sweep must find zero hits after Phase 6.

## The `page.evaluate()` string-constant rule

Any script sent into the browser context must be a plain string constant, never a function reference or a closure with named inner functions. tsx/esbuild's `keepNames` transform injects a `__name()` helper into a function's source text that does not exist in browser scope, producing a silent `ReferenceError` at runtime, invisible at build time.

`PageHandle` (`ports/BrowserPort.ts`) deliberately exposes **no generic `evaluate()`** - every browser-side operation is a named method, so this rule is enforced by construction. If a new browser-side operation is needed:

1. Add a named `PageHandle` method.
2. Implement it in `PlaywrightBrowserPort.ts` with a string-based `page.evaluate(theScriptString)`.
3. Never thread a closure through.

## CloakBrowser integration

CloakBrowser is the stealth layer - it owns fingerprinting. The app layer owns resource blocking (fonts, media, known ad/analytics domains), cookie injection, and `Accept-Language`/`Accept`/`DNT` headers at the context layer. Never duplicate fingerprint-spoofing logic in app code.

- Use CloakBrowser via `ensureBinary()` + `buildLaunchOptions()` from the `cloakbrowser` npm package, never hand-rolled launch args (ADR-006).
- Never set `userAgent`, `viewport`, or `addInitScript` on a CloakBrowser context - these fight its coherent fingerprint profile.

## Challenge detection (three-tier, checked in this order)

1. Structural DOM markers (cheapest, most reliable).
2. `document.title` regex.
3. `document.body.innerText` regex - the body-text check is only trusted when the page is short (`CHALLENGE_BODY_TEXT_MAX_LEN`, currently 2000 chars), so long chapter prose containing phrases like "just a moment" never false-triggers.

Preserve this ordering and the length gate in any port of this logic. `SecurityChallengeError` is a load-bearing type: the queue applies a distinct, longer backoff multiplier (`CHALLENGE_BACKOFF_MS`, 45s) when a retry was caused by a stuck challenge vs. an ordinary error. Don't collapse it into a generic error path.

## XDG directory rules

All persistent user data lives under XDG-standard directories - `XDG_DATA_HOME` for cookies/profiles/sessions, `XDG_CONFIG_HOME` for app config - resolved by the _same_ `resolveDataDir()` / `resolveConfigDir()` logic in every store. Getting this wrong means a store writes to a different directory than the others read, which is the worst-case migration bug. See `docs/05-migration-guide.md` section 1.

## Config + store format

- YAML for anything a human edits (global config, job files); JSON for machine-only stores (cookies, sessions, site profiles). Per ADR-004. Don't introduce a new human-facing config file in JSON, or a new machine store in YAML.
- Schema additions are additive-optional only - new fields must default on read. Never rename or retype an existing field without a migration entry. See the chain migration pattern in `docs/phase-2/readme.md` section 2.2.
- Unknown keys in any JSON/YAML store round-trip untouched on write.

## Adding a site adapter

See `docs/sites/adding-a-site.md`. Two built-ins ship (WTR-Lab, NovelFire); the evidence cookbook for them is `docs/02-site-adapters.md`, which you update in the same commit that adds or fixes an adapter.

## Pre-commit checks

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- `pnpm typecheck` runs `tsc --noEmit`.
- `pnpm lint` runs `eslint .` - fix every error before pushing.
- `pnpm test` runs Vitest. Acceptance tests that spin up the real CloakBrowser binary are gated behind `CLOAKBROWSER_BINARY_AVAILABLE=1` (see `tests/acceptance.test.ts`) and do not run in a plain `pnpm test` pass, so a green local suite is not a green acceptance run.

A future contributor can't re-add a banned import or dep without a test failure (see `tests/phase-6-sweep.test.ts` when present).

## Dev workflow

1. Branch from `main`.
2. Make the minimum change that solves the problem - no features beyond the request, no abstractions for single-use code, no error handling for impossible scenarios. If a solution is much longer than necessary, simplify before finishing. Ask: "Would a senior engineer say this is overcomplicated?"
3. One concern per commit - don't bundle unrelated changes into a single pass.
4. Commit with a clear message. Don't commit secrets, don't push or open a PR unless explicitly asked (the same rule applies to humans as to AI agents on this repo).
5. Open a PR and describe the trade-offs of any design decision you made mid-change - if a decision has real trade-offs, flag it in the PR description rather than deciding silently.

## Hard rules at a glance

- `playwright-core` only, never `playwright`.
- `page.evaluate()` runs string constants, never closures or named inner functions.
- CloakBrowser via `ensureBinary()` + `buildLaunchOptions()` only.
- Session files deleted only after the EPUB build succeeds.
- XDG dir resolution is shared - never inline your own path logic in a new store.
- Config: YAML human, JSON machine.
- Never use em dashes anywhere. Use a regular hyphen, a colon, or rewrite the sentence.
