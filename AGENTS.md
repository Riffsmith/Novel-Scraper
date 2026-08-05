# AGENTS.md

## Project

- `webnovel-scraper` (`wnscrape` / `wns`) — personal Node.js/TypeScript CLI that scrapes web
  novels and packages them as EPUB 3 files. Playwright/CloakBrowser-powered scraping,
  concurrency-controlled queue, resumable sessions, named per-domain cookie profiles.
- Requires Node.js >= 20 (see `.nvmrc` = 22), pnpm >= 9.
- **Mid-migration.** v1 is a working monolith (`src/index.ts`, `src/scraper|queue|epub|sessions|tui`).
  v2 is a hexagonal rewrite (`src/core/`, `src/ports/`, `src/adapters/`, `src/app/`) landing in
  phases — see `docs/04-implementation-roadmap.md` for the phase list and
  `docs/phase-*/readme.md` + `docs/phase-*/adr.md` + `docs/phase-*/deviation-log.md` for what
  each phase actually shipped vs. deviated from. **Always check the latest phase's deviation
  log before assuming a design doc reflects the real code** — implementation details (e.g.
  CloakBrowser's actual npm API) routinely differ from the original design doc.
- v1 code under `src/scraper/`, `src/queue/`, `src/epub/`, `src/sessions/`, `src/tui/` is the
  **reference oracle** for parity tests and stays untouched until the Phase 6 cleanup pass.
  Never "clean up" or refactor v1 files as a side effect of unrelated v2 work.

**Local dev commands:**

- `pnpm dev` — run v1 TUI directly via `tsx src/index.ts`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` / `pnpm test:watch` — vitest (`tests/**/*.test.ts`)
- `pnpm build` — `tsc` → `dist/`
- `pnpm start` — run built output (`node dist/index.js`)
- `docker compose run --rm wns` — daily containerized run command
- Acceptance tests that spin up the real CloakBrowser binary are gated behind
  `CLOAKBROWSER_BINARY_AVAILABLE=1` (see `tests/acceptance.test.ts`) — do not assume they run in
  a plain `pnpm test` pass.

## Architecture — v2 layout rules (ADR-003)

```
src/core/      pure domain — imports NOTHING from adapters/, playwright, fs, or chalk/ora
src/ports/     interfaces only (BrowserPort, CookieStore, ProfileStore, SessionStore,
               EpubWriter, UIAdapter, Logger)
src/adapters/  one directory per adapter (browser-playwright, store-json, store-memory,
               epub-archiver, ui-noop, logger-winston, …)
src/app/       composition root — wires adapters into core (runJob.ts, cli.ts, loadJobFile.ts)
```

- `core/` must never import from `adapters/`, `playwright`/`playwright-core`, `fs`, or any
  console/TUI library. Core services take a `Logger` port via constructor DI, not a winston
  import (`ports/Logger.ts` + `adapters/logger-winston/WinstonLogger.ts`).
- Progress/status is communicated as a typed `ScrapeEvent` union
  (`core/services/events.ts`) emitted through `UIAdapter.emit()` — never `console.log`,
  `ora`, or `cli-progress` calls inside `core/`.
- When adding a new cross-boundary type (cookies, job config, sessions), define it in
  `core/domain/`, not inline in an adapter or in `src/types.ts` (which is v1-only).
- Before writing new v2 code, check whether the equivalent v1 module already encodes the
  correct behavior (challenge detection thresholds, retry backoff math, checkpoint throttle
  interval, etc.) — v2 services are **ports of v1 logic**, not new designs. Deviating from v1
  behavior requires a deviation-log entry, not a silent change.

## Hard constraints (never violate these)

- **`playwright-core` only in new code** — never `playwright` (ADR-001). `playwright` stays a
  dependency solely because v1 imports it; v2 code must not add new imports of it.
- **`page.evaluate()` string-constant rule.** Any script sent into the browser context must be a
  plain string constant, never a function reference or a closure with named inner functions.
  tsx/esbuild's `keepNames` transform injects a `__name()` helper into the function's source text
  that does not exist in browser scope, causing a silent `ReferenceError`. This is invisible at
  build time. `PageHandle` (`ports/BrowserPort.ts`) deliberately exposes **no generic
  `evaluate()`** — every browser-side operation is a named method, so this rule is enforced by
  construction. If a new browser-side operation is needed, add a named `PageHandle` method and
  implement it in `PlaywrightBrowserPort.ts` (string-based) — do not thread a closure through.
- **Session files are deleted only after the EPUB build succeeds**, whether v1
  (`sessions/store.ts`) or v2 (`JsonSessionStore` via `ScrapeService.run`). A partial/failed
  scrape must always leave a resumable checkpoint on disk.
- **CloakBrowser integration goes through `ensureBinary()` + `buildLaunchOptions()`**
  (`cloakbrowser` npm package), never hand-rolled launch args (ADR-006). Never set
  `userAgent`, `viewport`, or `addInitScript` on a CloakBrowser context — these fight its
  coherent fingerprint profile (documented in `scraper/browser.ts` and
  `PlaywrightBrowserPort.ts`).
- **All persistent user data lives under XDG-standard directories** —
  `XDG_DATA_HOME` for cookies/profiles/sessions, `XDG_CONFIG_HOME` for app config — resolved by
  the _same_ `resolveDataDir()`/`resolveConfigDir()` logic in every store. Getting this wrong
  means v2 writes to a different directory than v1 reads, which is the worst-case migration bug
  (see `docs/05-migration-guide.md` §1).
- **`enquirer@2.4.1` is pinned** (v1 TUI only). Empirically verified, not just read from source:
  `require("enquirer").prompt` returns a new object on every access (so a listener attached to
  one instance is invisible to prompts built via another), and a cancelled prompt always rejects
  with a bare empty string `''`, never the triggering key. `tui/keys.ts` patches
  `Enquirer.prototype.ask` once at boot for exactly this reason — don't add a second, per-call
  patch elsewhere. This whole file is deleted in Phase 3 when Enquirer is replaced by
  `@clack/prompts` (ADR-002) — don't invest in extending it further.

## Data & migration compatibility

Every store change must satisfy `docs/05-migration-guide.md`: a v2 build must be able to run
against an existing v1 data directory with **zero manual steps and zero data loss**.

- Schema additions are **additive-optional only** — new fields must default on read. Never
  rename or retype an existing field without a migration entry.
- Migrations follow the chain pattern from `docs/05-migration-guide.md` §9 /
  `docs/phase-2/readme.md` §2.2: one `StoreMigration { fromVersion, toVersion, migrate(raw) }`
  per schema bump, applied in sequence — never an in-place rewrite of the whole store.
- The legacy flat-array cookie format (`Record<domain, StoredCookie[]>`) must keep
  auto-migrating to the named-profile format (`cookies/store.ts` — discriminated by
  `Array.isArray()`, which is airtight because the two shapes can never be confused).
- Unknown keys in any JSON/YAML store must round-trip untouched on write (v1's `writeConfig`
  behavior) — don't strip fields you don't recognize.
- `JsonSessionStore.save()` warns (does not refuse) when a session's `config` contains unknown
  keys, matching v1's actual tolerant behavior rather than the stricter wording in the original
  phase design doc (see `docs/phase-1/deviation-log.md` D6) — prefer the deviation log's
  documented actual behavior over the design doc when the two disagree.
- Config format: **YAML for anything a human edits** (global config, job files), **JSON for
  machine-only stores** (cookies, sessions, site profiles) — per ADR-004. Don't introduce a new
  human-facing config file in JSON, or a new machine store in YAML.

## Browser & scraping conventions

- Resource blocking (fonts, media, known ad/analytics domains), cookie injection, and
  `Accept-Language`/`Accept`/`DNT` headers are the app's responsibility at the context layer —
  fingerprinting itself is CloakBrowser's job. Don't duplicate fingerprint-spoofing logic in
  app code.
- Anti-bot challenge detection is **three-tiered, checked in this order**: structural DOM
  markers (cheapest, most reliable) → `document.title` regex → `document.body.innerText` regex,
  and the body-text check is only trusted when the page is short
  (`CHALLENGE_BODY_TEXT_MAX_LEN`, currently 2000 chars) so that long chapter prose containing
  phrases like "just a moment" can never false-trigger. Preserve this ordering and the length
  gate in any port of this logic.
- `SecurityChallengeError` is a load-bearing type, not an implementation detail: the queue
  (`ScrapeService`/`queue/index.ts`) applies a distinct, longer backoff multiplier
  (`CHALLENGE_BACKOFF_MS`, 45s) when a retry was caused by a stuck challenge vs. an ordinary
  error. Don't collapse this into a generic error path.
- New site adapters implement `SiteAdapter` (`sites/types.ts`): `matches()` as a hostname regex
  test (never a substring test), `getTocUrl()`, `scrapeMetadata()`, `scrapeChapterLinks()`, and
  the four `default*` selector fields. Always de-dupe chapter links and enforce a hard cap.
  Follow the checklist in `docs/02-site-adapters.md` §3 and update that doc in the same commit
  that adds or fixes an adapter — it's the only place site-specific selector evidence lives.

## Testing

- Vitest, config in `vitest.config.ts`, tests in `tests/**/*.test.ts`, fixtures in
  `tests/fixtures/`.
- Prefer `FakeBrowserPort`/`FakePage` (`adapters/store-memory/FakeBrowserPort.ts`) for unit
  tests of core services — no real browser, no network. Real-binary tests
  (challenge wait-out over time, full ≥50-chapter runs, sequential-walk fallback) belong in
  `tests/acceptance.test.ts` gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`, so `pnpm test` stays
  green in any environment.
- Resume/checkpoint tests must assert on **behavior**, not implementation: e.g. that
  already-completed chapter URLs are never re-visited (`browser.visitedUrls` in
  `tests/scrape-service-resume.test.ts`), not just that the function returns without throwing.
- New adapters need parity tests against the v1 reference oracle where one exists (EPUB
  structure, cookie-store migration, session round-trip) — see `tests/epub-archiver.test.ts`
  and `tests/session-store.test.ts` as the pattern to follow.

## Code delivery conventions

- Error tolerance is very low on this project — audit changes before delivering, don't
  double back on a wrong answer, and flag uncertainty honestly rather than guessing.
- For substantial rewrites, deliver drop-in replacement files; for single-line fixes, prefer a
  precise, targeted edit (`str_replace`) over a full-file diff.
- Architectural decisions with real trade-offs are flagged and confirmed before implementation,
  not decided silently mid-change.
- Work proceeds one concern at a time — don't bundle unrelated changes into a single pass.
- When auditing the codebase for a pattern (stale references, banned imports, etc.), exclude
  comment lines from the match set to avoid false positives.
- Never claim a v2 port is "done" without checking it against the relevant phase's test plan
  table (e.g. `docs/phase-1/readme.md` §3) and updating the phase's deviation log if the
  implementation diverged from the design doc for a good reason.

  **General**

- No god methods or classes. If it's hard to name, it's doing too much.
- Communicate through exported services or shared interfaces only.
- Don't over-engineer. Introduce patterns only when the complexity REALLY justifies it.
- Split code when it improves naming, testability, or ownership.

Implementation Scope

For every coding task, write the minimum code that solves the requested problem.

    Do not add features beyond what was asked.
    Do not add abstractions for single-use code.
    Do not add flexibility or configurability unless requested.
    Do not add error handling for impossible scenarios.
    If a solution is much longer than necessary, simplify it before finishing.
    Before shipping, ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## Code Style

- Never add unnecessary comments. Only add a comment when the logic is genuinely non-obvious or when it explains a tricky decision that cannot be inferred from the code itself. Do not describe what the code does - only explain why if the reason is not self-evident.
- Always run Prettier before committing (`cd server && npx prettier --write .` and `cd client && npx prettier --write .` as applicable).
- Always run ESLint before committing (`cd server && npx eslint .` and `cd client && npx eslint .` as applicable). Fix any errors before committing. if eslint not there, install it.
- Never use em dashes anywhere: UI text, strings, comments, PR descriptions, commit messages, or any other written output. Use a regular hyphen, colon, or rewrite the sentence.
