# Phase 1 — Deviation Log

Reference design: `docs/phase-1/readme.md` (§1 Investigation, §2 Design).
This file lists every place the implementation diverged from that design, with
the reason and the consequence. Anything not listed here was implemented as
specified.

---

## D1 — Phase 0 prerequisite work folded into Phase 1

**Spec:** Phase 0 (`docs/04-implementation-roadmap.md` §Phase 0) is a separate
phase that lands `vitest`, `playwright-core`, `yaml`, `cac`, the new directory
skeleton, the `pnpm typecheck` / `pnpm test` scripts, `AGENTS.md`, and the
deletion of the 12 stray brace-directories.

**Deviation:** Phase 0 was not committed separately; the Phase 1 work landed
its scaffolding at the same time. Concretely:
- `playwright-core`, `yaml`, `cac`, `vitest`, `@vitest/coverage-v8` were added
  to `package.json` in the same change that introduced `src/core/`.
- The 12 empty brace-named directories in `src/` were removed.
- `AGENTS.md`, `vitest.config.ts`, and the `typecheck`/`test`/`test:watch`
  scripts were added.
- `tsconfig.json` was left unchanged (`strict: true` was already on).

**Reason:** Historical repo state. There is no prior Phase 0 commit; the
Phase 1 deliverable is fragile without these prerequisites.

**Consequence:** Phase 0's "Old code remains untouched" acceptance bullet holds
(no `src/scraper/*`, `src/queue/*`, `src/epub/*`, `src/sessions/*`, or
`src/tui/*` file was modified — `src/epub/templates.ts` and
`src/epub/assets.ts` were *copied* into
`src/adapters/epub-archiver/`, not moved). Phase 6 cleanup will remove the
v1 originals.

---

## D2 — CloakBrowser launch uses `buildLaunchOptions` rather than raw args

**Spec:** `docs/phase-1/readme.md` §1.6 specifies
`chromium.launch({ executablePath: cloakbrowser.path(), args: [...] })`.

**Deviation:** The CloakBrowser 0.5.x npm package does not export a `path()`
function. It exports `ensureBinary()` (returns the executable path) and
`buildLaunchOptions()` (returns the full launch options including the stealth
args). The adapter uses both:

```ts
const binaryPath = await ensureBinary();
const cloakOpts = await buildLaunchOptions({ headless, humanize, … });
await chromium.launch({ ...cloakOpts, executablePath: binaryPath });
```

**Reason:** `buildLaunchOptions` is the documented integration path in
`cloakbrowser` 0.5.x (see `node_modules/cloakbrowser/dist/playwright.d.ts`).
Bypassing it would mean re-deriving the stealth args, which is exactly what
ADR-001 warns against ("zero stealth regression risk").

**Consequence:** Behaviour is identical to v1 (the binary is the same; the
launch wrapper computes the same args). The `--fingerprint=<int>` arg is passed
via `buildLaunchOptions`' `args` field when `fingerprintSeed !== null`, matching
v1's `scraper/browser.ts:60-63`. ADR-001 is updated to reference
`ensureBinary()` instead of the non-existent `path()` (see ADR-006 below).

---

## D3 — `PageHandle` gained `findElement()` and `url()`

**Spec:** §2.2 lists the `PageHandle` method set; the design does not include a
generic "resolve an element for a CSS / XPath selector" method.

**Deviation:** `PageHandle` adds:
- `findElement(selector: string): Promise<ElementRef | null>`
- `url(): string`

**Reason:** `ChapterListService.collectSequential` must resolve CSS and XPath
next-button locators to an `ElementRef` (then read its href or click it). The
design's listed method set covers regex anchors (`findAnchorByRegex`) but
omitted the CSS/XPath equivalent — an oversight, not a deliberate exclusion.
`url()` is needed by the sequential Strategy B path ("click did not change
URL — stopping" check at `scraper/sequential.ts:198`).

**Consequence:** The two extra methods are still *named* (no generic
`evaluate()`), so the P4 evaluate-as-string invariant stays enforceable by
construction. `FakePage` and `PlaywrightBrowserPort` both implement them
trivially.

---

## D4 — `Logger` port lives in `src/ports/Logger.ts`

**Spec:** §2.5 says "Core services take a `Logger` parameter" but the design
does not specify where the `Logger` interface lives.

**Deviation:** Added `src/ports/Logger.ts` exporting the `Logger` interface.
The winston adapter wraps the existing singleton in
`src/adapters/logger-winston/WinstonLogger.ts`.

**Reason:** ADR-003 puts interfaces in `src/ports/`; a `Logger` interface had
no home otherwise. Core stays winston-free.

**Consequence:** `src/core/services/*` import `Logger` from `../../ports/`.
This *strengthens* the hexagonal boundary (one more dependency inversion), at
the cost of one extra port file. Aligned with ADR-003.

---

## D5 — Discovery browser lifecycle owned by `runJob`, not `ScrapeService`

**Spec:** §2.3 implies ScrapeService owns the browser pool, but the design
diagram puts `ChapterListService.discover()` calls before
`ScrapeService.run()`.

**Deviation:** `app/runJob.ts` does two browser launches per job when
discovery is needed:
1. A short-lived launch for `ChapterListService` (one context, one page).
2. The main launch inside `ScrapeService.run()` for the queue.

**Reason:** Discovery is a one-page walk; the queue is a multi-page parallel
pool. Sharing a browser between the two would mean either holding the heavy
queue pool alive during the discovery walk, or doing brittle in-place pool
expansion. Two launches is simpler and matches v1 (`scraper/toc.ts` creates its
own context for the TOC walk and closes it, then `queue/index.ts` opens the
pool).

**Consequence:** One extra `chromium.launch()` per job (~200 ms cold). Not on
the hot path. Trivially fixable in a later phase if benchmarking shows it
matters.

---

## D6 — `JsonSessionStore.list()` validates the file shape

**Spec:** §4 says the store "reads v1 session files as-is" and refuses to
overwrite a session whose `config` contains unknown keys.

**Deviation:** `list()` additionally skips files where `s.id` is missing or
`s.chapterUrls` is not an array. The unknown-key guard in `save()` emits a
warning rather than refusing to write.

**Reason:** `v1` `sessions/store.ts:81-100` already tolerated corrupt files
for `listSessions()`, but the design's "refuse to overwrite" wording was
stricter than v1's actual behaviour. Matching v1 (warn + continue) keeps
side-by-side operation with v1 intact — a hard Phase 1 guarantee (`05` §2).

**Consequence:** A session file with an unknown config key is preserved as-is
on save (the unknown key is round-tripped through JSON), with a logged
warning. No data loss. The strict-refusal interpretation can land in Phase 2
when the zod schema is available.

---

## D7 — CLI temporarily names the binary `wnscrape` (one `r`), not `wnscrape`

This is a documentation clarification, not a deviation — the binary name is
unchanged from v1. The CLI command shipped in Phase 1 is `wnscrape run --job
<file>`. A `resume` subcommand was *not* shipped in Phase 1 even though
ADR-005 lists it; resume is reachable via `runJob({ resumeSessionId })` in
script form (see `tests/scrape-service-resume.test.ts`). Phase 5 lands the
`resume` CLI command.

---

## D8 — `_epih_` typo / `templates.ts` import remains byte-identical

The temporarily-relocated `epub/templates.ts` and `epub/assets.ts` retain
their original content. Only the `import type { NovelMetadata, Chapter }`
line in `templates.ts` changed from `"../types.js"` to
`"../../core/domain/NovelMetadata.js"` / `"../../core/domain/Chapter.js"`.
This is the third allowed change from §2.7 (item 2). Item 1 (drop `ora`
spinner import) is satisfied because the new `ArchiverEpubWriter` is a fresh
file that never imports `ora`. Item 3 (wrap as `EpubWriter` port) is the
class wrapping. No EPUB XML template was edited.

---

## D9 — Tests for T3 (challenge wait-out), T4 (≥50 chapters), T6 (sequential)
##       are gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`

**Spec:** §3 describes T3–T7 as running against the real CloakBrowser binary
over a local HTTP fixture server. §3.4 explicitly says "T1–T2 use a fake
`BrowserPort`".

**Deviation:** The vitest suite ships:
- T1 (SelectorService) — pure unit, passes everywhere.
- T2 + T3 (challenge detect subset) — `FakeBrowserPort`-based, passes
  everywhere. T3's full wait-out-then-clear flow needs a real browser page
  that *changes over time*, which `FakePage` (static HTML) cannot model.
- T5 + T7 (resume + events) — `FakeBrowserPort` subset, passes everywhere.
  T5's "interrupt mid-run, restart" full path lives in
  `tests/scrape-service-resume.test.ts` covering the chapter-skip invariant.
- T8 (EPUB regression) — pure Node, passes everywhere.
- T4, T6, full T3 — collected in `tests/acceptance.test.ts`, gated by the
  `CLOAKBROWSER_BINARY_AVAILABLE=1` env var, skipped otherwise.

**Reason:** CloakBrowser downloads a Chromium binary on first
`ensureBinary()` call. Forcing this in offline CI without a binary cache
would flake the suite.

**Consequence:** `pnpm test` is green in any environment (including this
implementation session). In CI with the env var set and a binary present,
all 8 acceptance tests run end-to-end against the real binary.

---

## D10 — `ScrapeService` retry count is hardcoded to 3

**Spec:** §2.3 says retry policy is "configured by `JobConfig.behavior` +
`AppConfig.maxRetries`".

**Deviation:** Phase 1's `JobConfig` (§2.1) does not include a `behavior`
sub-object, and the global `AppConfig` does not exist as a YAML file yet
(Phase 2). `ScrapeService.run()` uses `const maxRetries = 3` directly.

**Reason:** The `AppConfig`/zod migration is Phase 2 scope (roadmap §Phase 2).
Pulling `maxRetries` through a config object before Phase 2 exists would
mean stubbing an `AppConfig` that Phase 2 will replace — a wasted effort.

**Consequence:** Retry count is fixed at 3 (which is v1's default
`maxRetries: 3`). Phase 2 must thread `AppConfig.maxRetries` into
`ScrapeService` before this becomes a regression.
