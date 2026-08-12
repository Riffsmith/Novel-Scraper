# 01 — Architecture Decision Records (ADR)

Format: **Context → Decision → Consequences → Evidence**. Each decision is independently reversible.

---

## ADR-001 — Use `playwright-core`, not full Playwright and not Puppeteer

**Context**

WebNovel Scraper's anti-bot value comes from **CloakBrowser**, a C++-patched Chromium binary that
spoofs canvas/WebGL/audio/screen fingerprints and removes `navigator.webdriver`. The current
code integrates it through the full `playwright` package (`playwright` + its own Chromium
download, test runner, etc.). The overhaul's stated goal is **performance**, which usually
suggests Puppeteer.

Research summary:

| Driver | Pros | Cons for this project |
|--------|------|----------------------|
| **Full `playwright`** | Cross-browser, rich wait model, tracing, codegen | Large install; downloads 3 browser binaries we never use. |
| **`playwright-core`** | Same Chromium automation API; **no browser downloads, no test runner**; tiny upgrade surface | Nothing CloakBrowser-specific; still need to point it at the patched binary. |
| **`puppeteer`** | Leanest install; fastest cold-start in benchmarks | CDP-specific launch assumptions have not been validated against CloakBrowser's patched binary; would need a full stealth re-test. |

Benchmark consensus ([qaskills.sh](https://qaskills.sh/blog/playwright-vs-puppeteer-bundle-size-2026),
[webscraper.app](https://webscraper.app/headless-browser-benchmark-for-web-scraping),
[skyvern.com](https://www.skyvern.com/blog/puppeteer-vs-playwright-complete-performance-comparison-2025/))
is that Puppeteer is lighter and starts faster — but **a faster scrape that triggers a CAPTCHA is slower overall**.
Stealth fidelity is the real performance metric here.

**Decision**

1. Depend on **`playwright-core`** (not `playwright`).
2. Launch CloakBrowser binary explicitly via `playwright-core`'s `launch({ executablePath })`.
3. Keep a thin `BrowserPort` interface in the core so Puppeteer (or a raw CDP client) can be
   evaluated later without rewriting the queue or cookie/session code.

**Consequences**

- Install footprint drops: no `~/.cache/ms-playwright` with unused Firefox/WebKit.
- Cold-start improves vs. full Playwright (fewer core module checks, no registry sync).
- CloakBrowser integration stays exactly as it is today — zero stealth regression risk.
- If Puppeteer ever proves compatible and faster with CloakBrowser, only the `BrowserPort`
  adapter changes (`adapters/playwright/*` → `adapters/puppeteer/*`).

**Evidence**

- Current working integration: `src/scraper/browser.ts:58-78` (`launch({ args: ['--fingerprint=…'] })`).
- Playwright vs Puppeteer bundle-size gap: qaskills.sh 2026 data.
- CloakBrowser stealth requires binary-level patches that Puppeteer's default CDP launch flags
  have never been tested against in this codebase.

---

## ADR-002 — Replace Enquirer with `@clack/prompts` + screen-shell

**Context**

The current TUI is built on `enquirer`, which required a **prototype patch** of
`Enquirer.prototype.ask` (`src/tui/keys.ts:14-56`) plus a verbatim copy of enquirer's private
ctrl-combo map just to make Ctrl+Q/Ctrl+C quit gracefully. The file itself warns:

> *"Pin the enquirer dependency and re-check this file … none of the above is documented public API."*

opencode hit the same class of problems on a larger scale (flicker, race conditions between
streaming logs and prompt state) and migrated to a component-based renderer. For a scraper —
menus, forms, progress bars, but no streaming chat — a full React/Ink application is overkill
(extra runtime, reconciler, JSX build step).

`@clack/prompts` is purpose-built for this exact wizard/menu/progress pattern, is typed, and
has first-class `isCancel()` semantics.

**Decision**

- Use **`@clack/prompts`** as the only prompt library.
- Introduce a **screen-shell** layout:
  - **Header:** app name + active task summary (queue depth, running novel).
  - **Body:** current screen (main menu, wizard, cookie manager, task view, …).
  - **Footer:** status line + hints (`Esc back`, `Ctrl+Q quit`, `:` commands).
- Implement a tiny `Screen` interface (`render()`, `handleInput()`); navigation is a stack
  of screens, not a cascade of standalone `prompt()` calls.

**Consequences**

- Removes the entire `tui/keys.ts` patching surface.
- Cancel/back semantics become consistent (`isCancel` everywhere instead of custom `WizardBack`).
- Task-based progress can be shown in a dedicated screen instead of a global `cli-progress`
  bar hijacking stdout.
- Incremental: Clack does not take over the terminal raw mode for the whole app, so we can
  still print log lines above the UI when needed.

**Evidence**

- Enquirer fragility: `src/tui/keys.ts` comment block + P1 in `00-current-state-audit.md`.
- opencode issue [#11762](https://github.com/anomalyco/opencode/issues/11762): proof that ad-hoc
  terminal rendering eventually needs a component model; we adopt the *minimal* version of that lesson.
- `@clack/prompts` is the de-facto modern replacement for prompts/enquirer (used by Astro, Svelte CLI, etc.).

---

## ADR-003 — Hexagonal architecture: core / ports / adapters

**Context**

Today the domain is tangled with adapters:

- `src/index.ts` (864 lines) knows about Playwright `Cookie`, session JSON schema, *and* menu flow.
- `cookies/store.ts:25`, `queue/index.ts:3` import `Cookie` directly from `playwright`.
- Changing a menu risks breaking the scraping orchestrator.

This makes unit testing nearly impossible and blocks future UIs (web dashboard, Electron).

**Decision**

Adopt a **ports & adapters (hexagonal)** layout:

```
src/
├── core/           # pure domain — zero imports from playwright/clack/fs
│   ├── domain/     # Chapter, NovelMetadata, Session, Profile, JobConfig
│   ├── services/   # ScrapeService, ChapterListService, EpubService (orchestrate ports)
│   └── errors.ts
├── ports/          # interfaces
│   ├── BrowserPort.ts      # launch, context, page, evaluate-as-string contract
│   ├── CookieStore.ts      # domain Cookie interface, not playwright.Cookie
│   ├── ProfileStore.ts
│   ├── SessionStore.ts
│   ├── EpubWriter.ts
│   └── UIAdapter.ts        # progress events, not console.log
├── adapters/
│   ├── browser-playwright/ # playwright-core + CloakBrowser
│   ├── ui-clack/           # new TUI
│   ├── store-json/         # cookies, profiles, sessions (fs, versioned)
│   └── epub-archiver/      # archiver + templates (moved, not rewritten)
└── app/            # composition root — wires adapters into core, starts CLI or TUI
```

- `core/` imports **nothing** from `adapters/`.
- All cross-boundary types (`Cookie`, `JobConfig`) are defined in `core/`.

**Consequences**

- Scraping logic can be tested with a fake `BrowserPort` (happy DOM / recorded pages).
- A future web UI only writes a new `adapters/ui-web/`.
- The esbuild/tsx `evaluate-as-string` constraint is documented **once** inside the
  `BrowserPort` docstring, not scattered in adapter files.

**Evidence**

- P3, P7 in `00-current-state-audit.md`.
- `src/tui/prompts.ts` shows wizard logic and domain config assembly are impossible to separate today.

---

## ADR-004 — YAML for humans, JSON for machines

**Context**

The project currently has:

- **Human-edited global config** — JSON, silently tolerant of comments being stripped by round-trips.
- **Future job files** (needed for Phase 5 CLI automation) — will be handwritten frequently.
- **Machine stores** — cookies, sessions, site profiles (already JSON, read/written by app only).

**Decision**

| Data | Format | Reason |
|------|--------|--------|
| Global config | **YAML** (`config.yaml`) | Comments, anchors, less syntax noise. |
| Job files (`jobs/*.yaml`) | **YAML** | Hand-written; must support comments and readable multi-line selectors. |
| Cookies / sessions / profiles | **JSON** (unchanged) | Already working; no user edits expected; keeps store code minimal. |

Use the `yaml` npm package (small, actively maintained, ESM-friendly).

**Consequences**

- Existing `config.json` is auto-migrated to `config.yaml` on first run (see `05-migration-guide.md`).
- Schemas are validated with `zod` at the YAML boundary, not inside every module.

**Evidence**

- Your approval in planning discussion (option chosen: YAML).
- Current `appConfig.ts:131-145` already preserves unknown keys; yaml→json mapping preserves that behavior.

---

## ADR-005 — Add a non-interactive CLI alongside the TUI

**Context**

The current app has **no CLI flags** — running `wnscrape` immediately enters the menu. That means
it cannot be scheduled with cron, tested in CI, or chained into other scripts.

**Decision**

Use `cac` (tiny, typed, already ESM-friendly) to expose subcommands:

```
wnscrape                    # default: launch TUI
wnscrape run --job <file>   # non-interactive job run
wnscrape run --job <file> --json
wnscrape resume [--id <id>] # list/resume sessions headlessly
wnscrape cookies ls
wnscrape config get <key>
wnscrape doctor             # validates config + CloakBrowser binary path
```

**Consequences**

- Phase 1 (`core` headless engine) can be dogfooded immediately by `wnscrape run`.
- Every acceptance criterion in `04-implementation-roadmap.md` can be verified in CI via CLI.
- TUI and CLI share the same `ScrapeService`; behavior cannot diverge.

**Evidence**

- P6 in `00-current-state-audit.md`.
- opencode, GitHub CLI, and Vite all follow this "TUI for humans, CLI flags for scripts" pattern.

---

## ADR-006 — CloakBrowser integration via `ensureBinary()` + `buildLaunchOptions()`

**Context**

ADR-001 specifies `playwright-core` + explicit `executablePath` pointing at the
CloakBrowser binary. The original design doc (`docs/phase-1/readme.md` §1.6)
named the path source as `cloakbrowser.path()`. After implementing against the
real `cloakbrowser@0.5.x` npm package, the API is:

- `ensureBinary(licenseKey?, browserVersion?) => Promise<string>` — returns the
  path to the patched Chromium executable, downloading it on first use.
- `buildLaunchOptions(opts?) => Promise<PlaywrightLaunchOptions>` — returns the
  full Playwright launch options including the stealth args (`--fingerprint=*`,
  humanize hooks, pro-license routing, etc.).
- `getDefaultStealthArgs()` — exports the raw args list (not used here).

Calling `chromium.launch()` without `buildLaunchOptions` would require
re-deriving the stealth args ourselves, which is exactly the stealth-regression
risk ADR-001 warned against.

**Decision**

The `PlaywrightBrowserPort` adapter (`src/adapters/browser-playwright/`) launches
via:

```ts
const binaryPath = await ensureBinary();
const cloakOpts = await buildLaunchOptions({ headless, humanize, humanPreset,
                                              timezone, locale, args });
await chromium.launch({ ...cloakOpts, executablePath: binaryPath });
```

The `--fingerprint=<int>` arg is passed through `buildLaunchOptions`' `args`
field only when `fingerprintSeed !== null`, preserving v1's gating exactly
(v1 `scraper/browser.ts:60-63`).

This file updates ADR-001's evidence section in-place: the integration path is
no longer `cloakbrowser.path()` (which never existed) but `ensureBinary()` +
`buildLaunchOptions()`. ADR-001's *decision* is unchanged.

**Consequences**

- Stealth args are owned by the cloakbrowser wrapper, not by this repo. Any
  future stealth-arg change ships via a `cloakbrowser` version bump — no app
  edit needed.
- The `PlaywrightBrowserPort` is the only file that imports `cloakbrowser`.
  Everything else sees only `BrowserPort` — the hexagonal boundary holds.
- If `cloakbrowser` ever drops `buildLaunchOptions`, the adapter picks up its
  args from `getDefaultStealthArgs()` + a hand-rolled `executablePath` field;
  the rest of the app is unaffected.

**Evidence**

- `node_modules/cloakbrowser/dist/playwright.d.ts` — `buildLaunchOptions`
  declaration ("Build Playwright launch options for CloakBrowser without
  starting Chromium. Useful when integrating CloakBrowser with a custom
  Playwright build").
- `node_modules/cloakbrowser/dist/download.d.ts` — `ensureBinary` declaration
  ("Returns the path to the chrome executable").
- `src/adapters/browser-playwright/PlaywrightBrowserPort.ts:73-93` — the launch
  wiring.
- `docs/phase-1/deviation-log.md` D2 — implementation-side record of the same.

---

## ADR-007 — Wire the existing challenge machinery into the discovery phase (bug fix)

**Context**

User report + investigation in `docs/fix-issue-tui-url-cleanliness.md` §3
land here. Manual sequential discovery (`ManualWizardScreen` →
`ManualDiscoveryScreen` → `discoverJobChapters`) closes the browser the moment
the first `page.goto` lands on a Cloudflare / anti-bot challenge page. The
existing challenge machinery (`ChapterExtractor.waitOutChallenge` + 30 s
in-page poll + `SecurityChallengeError` + 45 s
`CHALLENGE_BACKOFF_MS` retry in `ScrapeService.ts:233-275`) only ran in the
scrape phase, never in the discovery phase. Discovery had two asymmetric
lifecycle phases in `runJob.ts:54-56`:

1. **Discovery phase** (`discoverJobChapters`) launched its own browser, walked
   the TOC or next-button chain via `ChapterListService`, and unconditionally
   closed the browser in a `finally` block. Neither `DiscoveryService.ts`
   nor `ChapterListService.ts` imported or called `waitOutChallenge`,
   `detectChallenge`, or `SecurityChallengeError`.

2. **Scrape phase** (`ScrapeService.run`) calls `ChapterExtractor.extract`
   which calls `waitOutChallenge` after every `page.goto`
   (`ChapterExtractor.ts:169`) and `ScrapeService` applies the 45 s
   `CHALLENGE_BACKOFF_MS` retry on `SecurityChallengeError`
   (`ScrapeService.ts:233-275`).

Result: discovery returned a one-URL (or zero-URL) list with no retry,
forcing the user to restart manually. Same defect on the `toc`
discovery method (zero links collected because the CF page has no `<a href>`
anchors).

**Decision**

The minimal, in-pattern fix reuses the existing challenge machinery
verbatim at two seams in `core/services/`:

1. **`ChapterListService` constructor gains an optional `extractor?:
   ChapterExtractor` arg.** `collectSequential` and `discoverTOC` call
   `extractor.waitOutChallenge(page)` after every `page.goto` and throw
   `SecurityChallengeError` on a `"stuck"` outcome instead of silently
   breaking the walk. The existing catch block in `collectSequential`
   propagates `SecurityChallengeError` (instanceof check) so the caller's
   retry loop can handle it. Absent for callers that never present a
   challenge (preserves pre-fix behaviour exactly).

2. **`discoverJobChapters` wraps the discovery body in a retry loop.** It
   constructs a `ChapterExtractor` internally (mirroring `ScrapeService.ts:78`
   `new ChapterExtractor(this.deps.log, ...)`), launches a fresh browser per
   attempt, runs `discoverTOC` / `collectSequential`, and on
   `SecurityChallengeError` with `attempt <= DISCOVERY_MAX_RETRIES` emits
   `challenge.waiting`, backs off `attempt * 45_000ms`, and relaunches.
   Otherwise bubbles. This mirrors `ScrapeService.ts:233-275` line for line
   in shape: same backoff math, same `challenge.waiting` UI event, same
   `maxRetries = 3`. The relaunch is critical: a fresh browser context gets a
   fresh TLS session + fingerprint seed, which is the documented behavioural
   contract for a transient challenge (reusing a single context across
   retries would just keep hitting the same fingerprint).

**Rejected alternatives** (full reasoning in `docs/fix-issue-tui-url-cleanliness.md`
§3.6):

- **Reuse ScrapeService's wait-out by running discovery inside the scrape
  loop.** Discovery and scrape have fundamentally different per-iteration
  shapes (discovery walks a chain via `resolveNext`; scrape does `extract` on
  a known URL). Merging them forces ScrapeService to know about
  `nextButtonLocators`, which breaks the existing invariant that
  ScrapeService is method-agnostic (`grep job.method ScrapeService.ts`
  returns zero matches today).

- **Add a `gotoAndWaitOutChallenge` method on the `BrowserPort` interface.**
  Adds challenge-detection signatures to the port, which mixes domain
  semantics (challenges are an app-layer concept) into the browser
  abstraction. The existing design correctly keeps `waitOutChallenge` in
  `ChapterExtractor` (a core service). The proposed fix stays in that layer.

- **Per-URL retry inside `ChapterListService.collectSequential`.** Discovery
  walks a chain, not a fixed list, so retrying a single URL mid-walk just
  re-hits the same fingerprint on the same context. The full-relaunch retry
  in `discoverJobChapters` actually works because it gets a new context +
  browser per attempt.

- **Duplicate `CHALLENGE_MAX_WAIT_MS` / `CHALLENGE_BACKOFF_MS` constants in
  ChapterListService** instead of injecting `ChapterExtractor`. AGENTS.md
  mandates the three-tier ordering and the 2,000-char body-text length gate,
  and explicitly warns that challenge detection logic must not be silently
  diverged from the v1 baseline. `ChapterExtractor.detectChallenge` /
  `waitOutChallenge` are the canonical, tested implementation; injecting it
  preserves the existing detection semantics exactly.

**Consequences**

- Discovery that previously failed silently with a short / wrong URL list
  now waits up to ~30 s + 3x45 s for a Cloudflare challenge to clear,
  mirroring the scrape phase's existing behaviour. Users on sites that never
  present a challenge see no change (the `extractor?` arg is optional and
  the `if (this.extractor)` branch is a no-op when absent).
- A new `challenge.waiting` event fires on the discovery code path. The
  event type already existed in the `ScrapeEvent` union (scrape phase emits
  it). No new event type invented; `ClackUIAdapter.emit` already routes
  `challenge.waiting` to a `prompt.log("warn", ...)` row (`ClackUIAdapter.ts:57-58`),
  so the user already sees the wait without a redundant `onEvent` handler in
  `ManualDiscoveryScreen`. See `docs/bug-fix-discovery-deviation-log.md` D-FIX-1
  for the deviation from the proposal doc §3.5.3 (which pre-dated the
  ClackUIAdapter `challenge.waiting` log case).
- `ChapterListService` had zero tests of its own before this change; the fix
  ships the first ones (`tests/chapter-list-service.test.ts`,
  `tests/discovery-service.test.ts`). Both follow the parity-test pattern
  AGENTS.md specifies for new service code: in-memory `StaticPage` /
  `MutableFakePage` doubles, `vi.useFakeTimers()` to drive the 30 s poll and
  45 s backoff without wall-clock waits, no real browser, no network.

**Evidence**

- `src/core/services/ChapterListService.ts` constructor at line 36-40 gains
  the optional `extractor?: ChapterExtractor`; `collectSequential`
  (`ChapterListService.ts:178-192`) calls `waitOutChallenge` after each
  `page.goto` and re-throws `SecurityChallengeError`, propagating up through
  the existing `catch` block's `instanceof` check. `discoverTOC`
  (`ChapterListService.ts:69-74`) does the same.
- `src/core/services/DiscoveryService.ts:62-119` wraps the body in
  `while (true) { attempt++ }` and on caught `SecurityChallengeError` with
  `attempt <= DISCOVERY_MAX_RETRIES` (3) emits `challenge.waiting`, logs a warn,
  backs off `attempt * 45_000ms`, and `continue`s (the `finally` block then
  closes the old browser before the new launch). On the 4th attempt
  (or any non-challenge error) it `throw e` and bubbles.
- `src/core/services/DiscoveryService.ts:27-58` constructs the
  `ChapterExtractor` internally and threads it through `new ChapterListService(...)`.
- `tests/chapter-list-service.test.ts` covers the three contracts:
  stuck-challenge throws `SecurityChallengeError`; cleared-challenge
  proceeds with the walk; no-extractor (pre-fix behaviour) breaks silently
  on the first iteration and returns the first URL only.
- `tests/discovery-service.test.ts` covers: stuck-challenge retries up to
  4 total launches (attempt 4 bubbles `SecurityChallengeError`),
  second-attempt-succeeds (fresh browser on attempt 2 walks `ch1 → ch2`),
  and `job.chapterLinks` pre-resolved short-circuit (0 launches).
- `pnpm test` stays green: 14 files, 210 tests (previously 12 files, 204
  tests; new tests added 6 entries, no regressions).
- `pnpm typecheck` stays clean.
- Implementation record + divergence from `docs/fix-issue-tui-url-cleanliness.md`
  tracked in `docs/bug-fix-discovery-deviation-log.md`.
