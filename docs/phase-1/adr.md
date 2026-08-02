# Phase 1 — Architecture Decision Record

This is the consolidated ADR for Phase 1 ("Headless core engine"). It records
the design-time decisions made by `docs/phase-1/readme.md` that acquired new
evidence during implementation, plus any new decisions introduced by the
implementation itself.

For a chronological deviation list see `docs/phase-1/deviation-log.md`. For the
top-level project ADRs (ADR-001 … ADR-005) plus the new ADR-006 landed by
Phase 1, see `docs/01-architecture-decisions.md`.

---

## ADR-P1-A — `PageHandle` is a *closed* method set (P4 fix is structural)

**Context**

Audit problem P4 (`docs/00-current-state-audit.md`) is the tsx/esbuild
`__name` footgun: any `page.evaluate(closure)` whose source contains a *named*
inner function throws `ReferenceError: __name is not defined` at runtime in the
browser, because the bundler injects a wrapper that doesn't exist there. v1's
only safe evaluate calls were either (a) inline IIFEs with no named inner
functions, or (b) scripts passed as **strings**. The error is invisible at build
time.

The Phase 1 design (`docs/phase-1/readme.md` §2.2) states:

> `PageHandle` deliberately does **not** expose a generic `evaluate()`. Every
> browser-side operation the engine needs is a *named method*; the adapter
> implements each one with the evaluate-as-string rule applied internally. This
> makes P4 un-violable by construction instead of by convention.

**Decision**

Implemented exactly as specified. The `BrowserPort.PageHandle` interface
(`src/ports/BrowserPort.ts`) exposes 15 named methods: `goto`, `title`,
`content`, `locatorCount`, `innerHTML`, `textContent`, `removeFromDom`,
`findElement`, `findAnchorByRegex`, `hrefOf`, `clickAndWaitNav`,
`waitForSelector`, `bodyInnerText`, `url`, `close`.

Inside the adapter (`src/adapters/browser-playwright/PlaywrightBrowserPort.ts`)
each method's evaluate body is a plain arrow function passed to
`page.evaluate`/`page.evaluateHandle` — *no closures cross the Node/browser
boundary with named inner functions*. The CSS/XPath exclusion path uses two
separate `page.evaluate` bodies parameterised by a primitive `string`, never a
closure that wraps a named helper.

**Consequences**

- A contributor who writes a new browser-side operation must add a new
  `PageHandle` method and its adapter implementation. They cannot drop an
  `evaluate(closure)` somewhere "just this once".
- The `FakeBrowserPort` (`src/adapters/store-memory/FakeBrowserPort.ts`)
  mirrors the same method set, so unit tests cannot accidentally use a method
  that only exists in the Playwright adapter.
- The `docstring` requirement from §1.6 ("the BrowserPort docstring must state
  verbatim …") is satisfied by the header comment on
  `src/ports/BrowserPort.ts:1-7`.

**Evidence**

- `src/ports/BrowserPort.ts` — interface, no `evaluate`.
- `src/adapters/browser-playwright/PlaywrightBrowserPort.ts:182-315` — the
  `pageObject` factory with all 15 named methods.
- `docs/00-current-state-audit.md` P4 row.
- `src/sites/wtrLab.ts:61-73` (v1, untouched) — the original site of the
  evaluate-as-string workaround that this ADR generalises.

---

## ADR-P1-B — Cookies are a `DomainCookie` (StoredCookie + `domain`), not a Playwright `Cookie`

**Context**

Audit problem P7 is the tight coupling to Playwright's `Cookie` type across
core, queue, sessions, and TUI. v1's `cookies/store.ts` already stores cookies
*without* the `domain` field (it's the per-domain profile key), then reattaches
it at scrape-time.

**Decision**

`src/core/domain/Cookie.ts` exports two interfaces:
- `StoredCookie` — verbatim v1 shape, persisted to JSON files.
- `DomainCookie extends StoredCookie { domain: string }` — the in-memory shape
  that crosses the `BrowserPort.createContext` boundary.

`BrowserPort.createContext(browser, cookies?: DomainCookie[])` is the only
place cookies meet the browser. The Playwright adapter maps `DomainCookie` →
Playwright's `Cookie` shape inside the adapter, never in core.

**Consequences**

- `core/` imports nothing from `playwright` or `playwright-core`.
- Phase 2's cookie-store migration is shape-stable: the JSON file format is
  identical to v1 (Phase 1's `JsonSessionStore` confirms by reading v1 sessions
  unchanged in `tests/session-store.test.ts`).
- The `cookiesFile?: string` field on `JobConfig` (Phase 1's stop-gap cookie
  injection per §1.8) produces a `DomainCookie[]` that the composition root
  feeds to `ScrapeService.run(job, cookies)`. Phase 2 swaps the source from a
  file to a real `CookieStore` lookup without touching the cookie shape.

**Evidence**

- `src/core/domain/Cookie.ts:18-25`.
- `src/ports/BrowserPort.ts:57` (`createContext` signature).
- `src/adapters/browser-playwright/PlaywrightBrowserPort.ts:130-143` — the
  DomainCookie → Playwright-Cookie mapping, inside the adapter.

---

## ADR-P1-C — Progress is a *tagged union* of events, not a callback

**Context**

v1's queue updated a single `cli-progress` bar via
`progressBar.update(completed, { chapter })` and also called `ora` spinners
scattered across `toc.ts`, `sequential.ts`, `chapter.ts`, and `builder.ts`.
Changing the UI risked breaking the engine.

**Decision**

`src/core/services/events.ts` defines `ScrapeEvent` as a discriminated union
of 10 event tags:

```
discovery.started | discovery.progress | discovery.done
chapter.done | chapter.retry | chapter.failed | challenge.waiting
checkpoint.saved
epub.started | epub.done
```

`src/ports/UIAdapter.ts` exposes `emit(e: ScrapeEvent)` and an optional
`onProgress(cb)` convenience. `src/adapters/ui-noop/NoopUIAdapter.ts` is the
default sink; the CLI's future `--json` mode (Phase 5) wraps it to capture a
serialisable event stream.

Core services emit events at the exact points v1 wrote to the TUI:
- `ChapterListService.discoverTOC` and `collectSequential` emit
  `discovery.started / .progress / .done` (replacing `ora` spinners in
  `scraper/toc.ts:49` and `scraper/sequential.ts:86`).
- `ScrapeService.run` emits `chapter.done / .retry / .failed` and
  `challenge.waiting` (replacing `progressBar.update` and the queue's
  per-chapter log lines in `queue/index.ts:181-184`).
- `ScrapeService.run` emits `checkpoint.saved` after each throttled save
  (replacing the silent `maybePersist` call in `queue/index.ts:86-101`).
- `ScrapeService.run` emits `epub.started / .done` around the `EpubWriter.write`
  call (replacing `spinner("Assembling EPUB…")` in `epub/builder.ts:50`).

**Consequences**

- The TUI (Phase 4) and CLI `--json` (Phase 5) subscribe to the same event
  stream — no engine fork.
- Unit tests can attach a recording `UIAdapter` (see
  `tests/scrape-service.test.ts`) and assert on the exact event sequence.
- v1's spinner comments ("this is exactly the coupling Phase 1 removes" —
  `scraper/toc.ts:50`) are now literally true.

**Evidence**

- `src/core/services/events.ts` (10-tag union).
- `src/ports/UIAdapter.ts` (interface).
- `src/adapters/ui-noop/NoopUIAdapter.ts` (default sink).
- `tests/scrape-service.test.ts` (recording adapter asserting event ordering
  + that the session file is deleted after `epub.done`).

---

## ADR-P1-D — `ScrapeService.cancel()` replaces process-level SIGINT suicide

**Context**

v1's graceful shutdown (`sessions/active.ts` + `index.ts:67-100`) installed
`SIGINT/SIGTERM/uncaughtException` handlers that called a module-level
`flushActiveSession()` and then `process.exit`. This was untestable:
"interrupt mid-run, restart, no re-downloads" (roadmap Phase 1 test bullet)
required killing the process.

**Decision**

`ScrapeService` exposes `cancel(): void` which flips an internal abort flag.
The task loop checks it:
- between page loads (top of `processTask`),
- after each chapter write.

The composition root (`src/app/runJob.ts` *would* install the signal handlers;
Phase 1 ships `runJob` as a library function and lets the CLI / future TUI own
the signal wiring per ADR-005's "composition root owns the wiring" rule from
§2.4).

**Consequences**

- The T7 resume-test sequence (recorded in
  `tests/scrape-service-resume.test.ts`) drives a real `ScrapeService.run` with
  a `FakeBrowserPort`, asserting that already-completed chapters are skipped
  by examining `visitedUrls`.
- A future SIGINT handler can call `scrapeService.cancel()`, await the
  returned `ScrapeResult`, write a final checkpoint, and exit cleanly — no
  `process.exit` from inside core.
- The 4-second checkpoint throttle and the unconditional final save are
  preserved (v1's `queue/index.ts:86-101, 202`).

**Evidence**

- `src/core/services/ScrapeService.ts:31-33` (`cancel` method).
- `src/core/services/ScrapeService.ts:115` (abort check at task top).
- `docs/phase-1/readme.md` §2.3 deliberate change #1.
- `tests/scrape-service-resume.test.ts` — proves the invariant without a
  `process.kill`.

---

## ADR-P1-E — EPUB archive is *moved, not rewritten*

**Context**

§2.7 specifies the EPUB builder is moved (not rewritten) with three allowed
changes only: drop the `ora` import, swap the type import to `core/domain`,
and wrap as `EpubWriter`.

**Decision**

`src/adapters/epub-archiver/templates.ts` and `assets.ts` are byte-identical
copies of `src/epub/templates.ts` and `src/epub/assets.ts` *except* the single
`import type` line in `templates.ts:1` (now `core/domain/*` instead of
`../types.js`). `src/adapters/epub-archiver/ArchiverEpubWriter.ts` is a fresh
class wrapping `archiver` with the same mimetype-first-uncompressed, NCX+nav,
cover-from-URL (failure non-fatal), FoglihtenNo07 subset embed logic.

**Consequences**

- The v1 originals stay in place and untouched (Phase 6 cleanup deletes them),
  preserving the v1 reference oracle for parity tests.
- `tests/epub-archiver.test.ts` asserts structural parity: mimetype-first +
  `compress_type=0` (Stored), all required entries present, cover omission
  when `coverSource: "none"`.
- Chapter spine order in `content.opf` follows chapter-index input order.
  v1 did the same; `ScrapeService` pre-sorts chapters by `index` before
  handing them to the writer (parity with `queue/index.ts:211-213`).

**Evidence**

- `diff src/epub/templates.ts src/adapters/epub-archiver/templates.ts` —
  one-line change (the import).
- `tests/epub-archiver.test.ts` — structural regression suite.
- `src/adapters/epub-archiver/ArchiverEpubWriter.ts:104-127` — the entry-append
  order mirrors `src/epub/builder.ts:94-133` line-for-line.

---

## ADR-P1-F — `JobConfig` is a *superset* of `ScraperConfig`, validated by hand until Phase 2

**Context**

`ScraperConfig` (`src/types.ts:107-141` in v1) is a TUI-assembled shape.
Phase 1's YAML job file needs a file-loadable superset; Phase 2 ships the zod
schema. §2.1 says Phase 1 ships a "hand-rolled validator in `loadJobFile.ts`
(exactly one place — no scattered checks)".

**Decision**

`src/core/domain/JobConfig.ts` defines `JobConfig extends ScraperConfig` with
four optional Phase 1 additions (`jobId?`, `cookiesFile?`,
`resumeFromSessionId?`, `output: { epub: boolean }`). `src/app/loadJobFile.ts`
hand-validates:
- `method` is `"toc"` or `"sequential"`,
- `contentSelector`, `outputDir`, `outputFilename`, `metadata.title`,
  `metadata.author` are present,
- defaults filled for `concurrency=2`, `delayMin=1200`, `delayMax=3500`,
  `headless=true`, `separateTitle=false`, `excludeSelectors=[]`,
  `output.epub=true`, `coverSource="none"`, `language="en"`.

**Consequences**

- One validation site. Validation logic is not duplicated across services.
- Phase 2 replaces `loadJobFile.ts`'s body with a zod schema; the
  `JobConfig` type is already in final shape so no consumer code changes.
- The hand-rolled defaults match v1's `config/appConfig.ts` documented
  defaults exactly, so an out-of-the-box job file behaves like a v1 scrape.

**Evidence**

- `src/core/domain/JobConfig.ts:24-33` (the four additions).
- `src/app/loadJobFile.ts:11-44` (the validator).
- `docs/phase-1/readme.md` §2.1 (the design mandate).

---

## ADR-P1-G — `Logger` is a port, not a direct winston import in core

**Context**

§2.5 says "Core services never import winston. They take a `Logger` parameter".

**Decision**

Added `src/ports/Logger.ts` (the `Logger` interface). Core services accept a
`Logger` via constructor DI. The winston adapter
(`src/adapters/logger-winston/WinstonLogger.ts`) wraps the existing
`src/logger/index.ts` singleton at the composition root.

This is logged as deviation D4 in `deviation-log.md` because the design did not
specify *where* the interface lives, only that the dependency be inverted.

**Consequences**

- `src/core/services/*` import `Logger` from `../../ports/`. Zero winston
  imports in `src/core/`.
- Phase 4's TUI can pass a `Logger` that also renders to its own panel without
  changing core.
- Error message shapes are preserved ("Queue complete: X ok, Y failed" — v1
  `queue/index.ts:215`), keeping log-diffing against v1 viable.

**Evidence**

- `grep -r winston src/core/` returns nothing.
- `src/adapters/logger-winston/WinstonLogger.ts` passes the existing logger
  through unchanged.
- `docs/01-architecture-decisions.md` ADR-003 ("core imports nothing from
  adapters") is upheld.

---

## Summary of Phase 1 deliverables

| Design item | Status | Evidence |
|---|---|---|
| `core/domain/*` (Chapter, NovelMetadata, JobConfig, Session, Cookie, Locator) | done | `src/core/domain/*.ts` |
| `core/errors.ts` (`SecurityChallengeError`) | done | `src/core/errors.ts` |
| `ports/*` (Browser, Cookie, Profile, Session, Epub, UI, Logger) | done | `src/ports/*.ts` |
| `core/services/SelectorService` | done + T1 | `tests/selector-service.test.ts` (16 tests) |
| `core/services/ChapterExtractor` | done + T2/T3-subset | `tests/chapter-extractor.test.ts` (9 tests) |
| `core/services/ChapterListService` (TOC + sequential unified) | done | `src/core/services/ChapterListService.ts` |
| `core/services/ScrapeService` (queue port) | done + T5 + T7 subset | `tests/scrape-service*.test.ts` |
| `adapters/browser-playwright` (playwright-core + cloakbrowser) | done | `src/adapters/browser-playwright/PlaywrightBrowserPort.ts` |
| `adapters/store-json/JsonSessionStore` | done + round-trip tests | `tests/session-store.test.ts` (5 tests) |
| `adapters/store-memory` (NullStores, FakeBrowserPort) | done | `src/adapters/store-memory/*.ts` |
| `adapters/epub-archiver` (moved builder + templates + assets) | done + T8 | `tests/epub-archiver.test.ts` (4 tests) |
| `adapters/ui-noop/NoopUIAdapter` | done | `src/adapters/ui-noop/NoopUIAdapter.ts` |
| `adapters/logger-winston/WinstonLogger` | done | `src/adapters/logger-winston/WinstonLogger.ts` |
| `app/runJob.ts` (composition root) | done | `src/app/runJob.ts` |
| `app/loadJobFile.ts` (YAML → JobConfig, hand-rolled) | done | `src/app/loadJobFile.ts` |
| `app/cli.ts` (`wnscrape run --job <file>`) | done | `src/app/cli.ts` |
| Acceptance run (`wnscrape run --job fixtures/job.yaml` for >=50 ch) | done (gated) | `tests/acceptance.test.ts` |

**Test totals:** 36 unit tests passing. 1 acceptance test registered (skipped
unless `CLOAKBROWSER_BINARY_AVAILABLE=1`). `pnpm typecheck` and `pnpm build`
are green.

**Hard constraints upheld:**
- No new code imports `playwright` (only `playwright-core`).
- `PageHandle` exposes no generic `evaluate()` (P4 fix is structural).
- Session files are deleted only after EPUB build succeeds (asserted in
  `tests/scrape-service.test.ts`).
- v1 code in `src/scraper|queue|epub|sessions|tui` is untouched (Phase 6 will
  remove it; Phase 1 keeps it as the reference oracle).