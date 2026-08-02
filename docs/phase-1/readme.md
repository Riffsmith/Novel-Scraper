# Phase 1 — Headless Core Engine: Investigation & Design

Roadmap reference: `docs/04-implementation-roadmap.md` §"Phase 1".
Governing ADRs: ADR-001 (playwright-core), ADR-003 (hexagonal core/ports/adapters), ADR-005 (CLI dogfood).

**Goal in one sentence:** the whole scrape pipeline — TOC/sequential discovery, anti-bot wait-out,
sanitisation, queue, resume checkpoints, EPUB pack — runs end-to-end with **zero TUI imports**, driven
by `app/runJob.ts` and a YAML-parseable `JobConfig`, with progress delivered as **events** through a
`UIAdapter` port.

---

## 1. Investigation — what Phase 1 must faithfully port

Phase 1 owns parity for audit sections *Scraping engine*, *Browser & stealth*, *Concurrency & resilience*,
*Resumability*, and *EPUB 3 output* (roadmap traceability table, `04` §"Traceability"). Reading the v1
sources, the concrete behaviors that must survive the port are:

### 1.1 Chapter extraction (`src/scraper/chapter.ts`, 314 LOC)

- **Challenge detection is 3-tiered** (`chapter.ts:66-98`): DOM markers → title regexes → body regexes
  *gated on `body < 2,000 chars`*. That length gate exists because legitimate prose can contain the
  phrase "just a moment" — losing it is a silent regression.
- `SecurityChallengeError` is thrown only when a detected challenge **does not clear within 30 s**
  (`:100-123`). The queue listens for this exact type and applies a **45 s backoff multiplier**
  (`queue/index.ts:20,159-167`). The error type is therefore part of the *core* contract, not an
  implementation detail.
- **Sanitisation allow-list** is fixed (`chapter.ts:133-185`) and includes `ruby/rb/rt/rp` tags —
  critical for CJK novels. Post-clean passes: collapse `<p></p>`, cap `<br>` runs at 2, cap newlines.
- Title fallback chain: separate selector → `"Chapter N"` → `page.title()` (`:244-296`).
- Hidden removal: `[style*="display:none"]`, `[hidden]`, `[aria-hidden="true"]` removed from the
  extracted fragment *after* exclusion selectors run against the live DOM.

### 1.2 Selector engine (`src/scraper/selectors.ts`, 169 LOC)

- XPath auto-detection: `//`, `(//`, or `xpath=` prefix (`selectors.ts:14-21`). All three kinds must
  keep working because site profiles store user-typed selector strings without a kind tag.
- `findAnchorByRegex` (`:122-151`) matches regexes against `textContent` **and** `title` — used by
  sequential mode. It runs inside `page.evaluateHandle`; this function *does* take a closure, and it
  works today only because it has no named inner functions (P4 footgun — see §1.6).
- `removeFromDom` uses `document.evaluate` for XPath and `querySelectorAll` for CSS, both inside
  `page.evaluate` — this keeps CSS and XPath exclusion behavior identical for a single page snapshot.

### 1.3 Discovery: TOC mode (`src/scraper/toc.ts`, 149 LOC)

- Collect every `a[href]`, filter to same-origin, drop `NON_CHAPTER_PATTERNS` (login/register/tag/…),
  de-dupe preserving *discovery order*.
- Pagination: follow `<a rel="next">` **only** when its path stays under the TOC path base
  (`toc.ts:104-125`) — otherwise a chapter page with `rel="next"` would poison the queue.
- Currently calls `ora` directly (`spinner()` import) — this is exactly the coupling Phase 1 removes:
  the port emits a `discovery.progress` event instead.

### 1.4 Discovery: sequential mode (`src/scraper/sequential.ts`, 244 LOC)

- Ordered locator fallback with usage telemetry (`hits[]` array logged at end).
- **Strategy A first** (resolve `href` without clicking — cheap), Strategy B (click + waitForLoadState)
  only when href is unusable.
- Reduced jitter during sequential walking (`delayMin*0.3`, `delayMin*0.4`) — *not* the normal scrape
  jitter. This asymmetry must be preserved or discovery becomes 3× slower than v1 for the same config.
- Loop guard: visited-URL set and `MAX_CHAPTERS = 10_000`.

### 1.5 Queue & resume (`src/queue/index.ts`, 218 LOC)

The queue is the heart of Phase 1. Behaviors that must be identical:

| Behavior | Evidence | Design consequence |
|---|---|---|
| Slots seeded by **1-based** `Chapter.index` | `queue/index.ts:67-77` | Resume never perturbs EPUB order; the service accepts `previousChapters` on input. |
| One `BrowserContext` per worker slot; cookies injected once per context | `:103-111` | `BrowserPort` must expose `createContext(cookies)` — not `createContext()` + per-page injection. |
| Per-task retry, backoff = `retries * delayMax`; challenge backoff = 45 s × retries | `:139-167` | Retry policy lives in `ScrapeService`, configured by `JobConfig.behavior` + `AppConfig.maxRetries`. |
| Checkpoint throttle 4 s + forced final save | `:86-101, 202` | Becomes a `checkpoint` callback the service invokes; the *SessionStore adapter* owns the file write. |
| `progressBar.update(completed …)` inside the queue | `:81-84, 181-184` | Replaced by `UIAdapter.emit({ type: 'progress', done, total, current })` — the TUI (Phase 4) or CLI `--json` (Phase 5) subscribes. |
| Context pool closed after run | `:204-207` | Service owns pool lifecycle; fatal if leaked during SIGINT — see §2.4. |

### 1.6 Browser & stealth (`src/scraper/browser.ts`, 225 LOC)

- v1 launches CloakBrowser via `import("cloakbrowser")`'s own `launch()` and casts the result to
  Playwright's `Browser`. Phase 1 replaces this with **playwright-core + explicit `executablePath`**
  per ADR-001: `chromium.launch({ executablePath: cloakbrowser.path(), args: [...] })`.
- `--fingerprint=<int>` arg is passed only when `fingerprintSeed !== null` (`browser.ts:60-63`).
- Resource blocking list (`:185-202`): media, fonts, and 8 tracker/ads domains. This lives in the
  adapter (it's a CDP-level behavior), not in core config.
- Context headers: `Accept-Language` derived from locale, `Accept`, `DNT`, `Upgrade-Insecure-Requests`.
- **Do not port:** userAgent/viewport overrides, `addInitScript` — v1's comment (`:152-154`) is explicit
  that these would *fight* CloakBrowser's coherent fingerprint.
- Ephemeral headed browser (cookie capture) is **Phase 3 scope**; Phase 1's `BrowserPort` must merely
  not preclude it (i.e. expose `launchEphemeral` in the interface but the TUI doesn't exist yet to call it).

**`evaluate`-as-string rule (P4):** the `BrowserPort` docstring must state verbatim: *any script passed
to `evaluate` that contains a named closure must be written as a string template*, citing
`sites/wtrLab.ts:61-73` as evidence. Provide a lint rule or code-review checklist item — this error is
invisible at build time and runtime-silent in minified tsx output.

### 1.7 EPUB (`src/epub/builder.ts`, 148 LOC + `templates.ts` 805 LOC)

- **Moved, not rewritten** (roadmap Phase 1 scope bullet). Only three changes allowed:
  1. Remove the `ora` spinner import — progress goes through `UIAdapter`.
  2. Import `Chapter`/`NovelMetadata` from `core/domain` instead of `src/types.ts`.
  3. Wrap as `EpubWriter` port implementation: `write(chapters, meta, dest): Promise<{ path: string }>`.
- Mimetype-first-uncompressed (EPUB spec), NCX + nav, cover-from-URL failure non-fatal,
  FoglihtenNo07 font subset embedded — all stay byte-identical behavior.

### 1.8 Sessions (`src/sessions/store.ts`, `active.ts`)

- `ScrapeSession` schema (`types.ts:188-203`) is the resume contract: `config`, `chapterUrls`,
  `completedChapters[]` (full chapters, not indices), `errors[]`.
- Deletion rule: session file deleted **only after** EPUB build succeeds.
- Phase 1 implements **SessionStore only** (JSON file adapter); CookieStore/ProfileStore are Phase 2 —
  so Phase 1's `runJob` accepts cookies as an *injected array* (sourced from a `--cookies` file or empty),
  not from a store lookup. This keeps Phase 1 free of Phase 2 migration concerns while the port shape
  stays final.

---

## 2. Design — target structure

Everything below lands under the Phase 0 skeleton (`src/core/`, `src/ports/`, `src/adapters/`, `src/app/`).
Legacy `src/scraper/*`, `src/queue/*`, `src/epub/*` stay untouched until Phase 6 cleanup so v1 remains
runnable as a reference oracle for tests (§3.4).

```
src/
├── core/
│   ├── domain/
│   │   ├── Chapter.ts            # from types.ts:144-150 — verbatim
│   │   ├── NovelMetadata.ts      # types.ts:95-104
│   │   ├── JobConfig.ts          # superset of ScraperConfig — see §2.1
│   │   ├── Session.ts            # ScrapeSession + SessionSummary
│   │   ├── Cookie.ts             # StoredCookie shape — NO playwright import (P7)
│   │   └── Locator.ts            # NextLocator, LocatorKind
│   ├── services/
│   │   ├── SelectorService.ts    # port of selectors.ts (pure where possible)
│   │   ├── ChapterExtractor.ts   # port of chapter.ts (challenge detect + sanitise)
│   │   ├── ChapterListService.ts # toc.ts + sequential.ts unified behind discover()
│   │   ├── ScrapeService.ts      # the queue — orchestrates everything via ports
│   │   └── events.ts             # ScrapeEvent union type
│   └── errors.ts                 # SecurityChallengeError, ScrapeError taxonomy
├── ports/
│   ├── BrowserPort.ts
│   ├── CookieStore.ts            # interface only; impl in Phase 2
│   ├── ProfileStore.ts           # interface only; impl in Phase 2
│   ├── SessionStore.ts
│   ├── EpubWriter.ts
│   └── UIAdapter.ts
├── adapters/
│   ├── browser-playwright/
│   │   ├── PlaywrightBrowserPort.ts   # playwright-core + cloakbrowser binary
│   │   └── playwrightPage.ts          # Page façade w/ evaluate-string helpers
│   ├── store-json/
│   │   └── JsonSessionStore.ts        # v1-compatible reader/writer (schemaVersion passthrough)
│   ├── store-memory/                  # CookieStore/ProfileStore stubs for Phase 1 tests
│   │   └── NullStores.ts
│   ├── epub-archiver/
│   │   ├── ArchiverEpubWriter.ts      # moved builder.ts, de-orafied
│   │   ├── templates.ts               # moved verbatim
│   │   └── assets.ts                  # moved verbatim
│   └── ui-noop/
│       └── NoopUIAdapter.ts           # default sink; CLI --json wraps it later
└── app/
    ├── runJob.ts                 # JobConfig → ScrapeResult (composition root)
    └── loadJobFile.ts            # YAML → JobConfig (zod schema lands in Phase 2; Phase 1 uses a plain parser + manual checks)
```

### 2.1 `JobConfig` — the one new type

`ScraperConfig` (`types.ts:107-141`) assumes a TUI assembled it. Phase 1 needs a file-loadable shape.
It is `ScraperConfig` plus: `jobId?`, `cookiesFile?` (path to a v1-format cookie JSON snippet to inject),
`resumeFromSessionId?`, and `output.epub: boolean`. `ScraperConfig` itself becomes a *subset* used
internally. Phase 2's zod schema will validate `JobConfig`; Phase 1 ships a hand-rolled validator in
`loadJobFile.ts` (exactly one place — no scattered checks) so the phase isn't blocked on the full
schema work.

### 2.2 Port signatures (normative)

```ts
// ports/BrowserPort.ts
export interface BrowserPort {
  launch(opts: BrowserLaunchOpts): Promise<BrowserHandle>;
  createContext(browser: BrowserHandle, cookies?: DomainCookie[]): Promise<ContextHandle>;
  newPage(ctx: ContextHandle): Promise<PageHandle>;
  closeAll(): Promise<void>;
}

export interface PageHandle {
  goto(url: string, opts: { waitUntil: WaitUntil; timeoutMs: number }): Promise<void>;
  title(): Promise<string>;
  content(): Promise<string>;
  locatorCount(cssSelector: string): Promise<number>;
  innerHTML(selector: string, timeoutMs: number): Promise<string | null>;   // CSS or XPath — detection inside adapter
  textContent(selector: string, timeoutMs: number): Promise<string | null>;
  removeFromDom(selectors: string[]): Promise<void>;
  findAnchorByRegex(pattern: string, flags: string): Promise<ElementRef | null>;
  hrefOf(el: ElementRef): Promise<string | null>;
  clickAndWaitNav(el: ElementRef, timeoutMs: number): Promise<string>;      // returns new URL
  waitForSelector(selector: string, timeoutMs: number): Promise<void>;
  bodyInnerText(): Promise<string>;
  close(): Promise<void>;
}
```

Rationale: `PageHandle` deliberately does **not** expose a generic `evaluate()`. Every browser-side
operation the engine needs is a *named method*; the adapter implements each one with the
evaluate-as-string rule applied internally. This makes P4 un-violable by construction instead of by
convention — that's the fix, not a comment (audit P4 asked for "documented and enforced").

`DomainCookie` in `core/domain/Cookie.ts` is v1's `StoredCookie` plus the `domain` field reattached —
the JSON session/cookie files stay v1-shaped; only the in-memory cross-port type changes (fixes P7).

```ts
// ports/UIAdapter.ts
export type ScrapeEvent =
  | { type: 'discovery.started'; url: string }
  | { type: 'discovery.progress'; found: number; pages: number }
  | { type: 'discovery.done'; urls: string[] }
  | { type: 'chapter.done'; index: number; title: string; words: number }
  | { type: 'chapter.retry'; index: number; attempt: number; max: number; challenge: boolean; backoffMs: number }
  | { type: 'chapter.failed'; index: number; url: string; error: string }
  | { type: 'challenge.waiting'; url: string }
  | { type: 'checkpoint.saved'; sessionId: string; done: number }
  | { type: 'epub.started' } | { type: 'epub.done'; path: string };

export interface UIAdapter {
  emit(e: ScrapeEvent): void;
  onProgress?(cb: (done: number, total: number) => void): void;  // convenience for bars
}
```

```ts
// ports/SessionStore.ts
export interface SessionStore {
  save(s: ScrapeSession): Promise<void>;
  load(id: string): Promise<ScrapeSession | null>;
  list(): Promise<SessionSummary[]>;
  findByEntryUrl(url: string): Promise<ScrapeSession | null>;
  delete(id: string): Promise<boolean>;
}
```

### 2.3 `ScrapeService` — the ported queue

```
class ScrapeService {
  constructor(deps: { browser: BrowserPort; sessions: SessionStore;
                      epub: EpubWriter; ui: UIAdapter; logger: Logger })
  run(job: JobConfig, resume?: { session: ScrapeSession }): Promise<ScrapeResult>
  cancel(): Promise<void>   // replaces installScrapeQuitKey + SIGINT path
}
```

Internally it is `runScrapeQueue` lifted almost line-for-line: same slot-seeding, same p-queue, same
retry math (including the 45 s challenge multiplier), same 4 s checkpoint throttle. Three deliberate
changes only:

1. **Cancellation is a first-class method** (`cancel()` flips an abort flag; the task loop checks it
   between page loads and after each chapter). Today Ctrl+C works only because `process.exit` is wired
   globally — Phase 1 makes the service testable for "interrupt mid-run, restart, no re-downloads"
   (roadmap Phase 1 test bullet) without process suicide.
2. **Checkpoint callback becomes `sessions.save()`** with the session object assembled by the service
   (id, entryUrl, chapterUrls, completedChapters from filled slots). First save happens *before* the
   first chapter task starts (parity with `index.ts:216-233`).
3. **Context pool moved behind BrowserPort** — one context per concurrency slot, cookies applied at
   context creation, pool drained + closed in a `finally`.

### 2.4 Lifecycle & graceful shutdown (headless)

`app/runJob.ts` installs `SIGINT/SIGTERM/uncaughtException` handlers that call, in order:
`scrapeService.cancel()` → final checkpoint write → `browserPort.closeAll()`. This reproduces
`sessions/active.ts` + `index.ts:67-100` semantics without global singletons: the composition root owns
the wiring, the service owns the data. Session file stays on disk exactly like v1 (deleted only after
EPUB build — parity `sessions/store.ts` note).

### 2.5 Logging

Core services never import winston. They take a `Logger` (`debug/info/warn/error`) parameter — the app
root passes the existing winston logger (moved to `adapters/logger-winston/` in Phase 0, unchanged
transports so `logs/*.log` files keep appending — migration guide §6). Error paths keep v1's message
shapes where feasible (`"Queue complete: X ok, Y failed"`) so log-diffing v1 vs v2 runs is a viable
test technique.

---

## 3. Test plan (maps 1:1 to roadmap acceptance)

| # | Test | Fixture | Asserts |
|---|------|---------|---------|
| T1 | SelectorService CSS + XPath + regex anchor | happy-dom / static strings | parity with `selectors.ts` truth table; XPath prefixes `// (// xpath=` |
| T2 | ChapterExtractor vs static page | local HTTP server serving `fixtures/site/ch-1.html` incl. hidden nodes, exclusions, `<ruby>` | sanitised HTML equals golden file; word count stable |
| T3 | Challenge wait-out | fixture serves `<title>Just a moment…</title>` then switches after 3 polls | service waits, does not throw; then a "stuck" variant throws `SecurityChallengeError` and queue backoff is 45 s-scaled |
| T4 | Full scrape ≥ 50 chapters | fixture site w/ 60 chapters, TOC page + pagination | EPUB built; nav.xhtml spine order == URL list order |
| T5 | Resume | kill service after chapter 20 (via `cancel()`, not process kill); re-run with `resumeFromSessionId` | chapters 1–20 never re-requested (server access log assert); final EPUB identical to uninterrupted run's EPUB except timestamps |
| T6 | Sequential walk | fixture chain pages with `rel=next` + one page where primary CSS locator misses → fallback regex used | warning event emitted for fallback #1; links complete |
| T7 | Progress events | `UIAdapter` recording stub | monotonic `done`, one `checkpoint.saved` ≥ every 4 s during run + exactly one final |
| T8 | EPUB regression | byte-compare structure (zip listing, mimetype stored-first) against a v1-built EPUB of same chapters | same entries; OPF/nav/template equality modulo UUIDs |

Network isolation: all fixtures served from `node:http` on 127.0.0.1; **no test touches the public
internet** (roadmap Phase 1 requirement). The playwright-core adapter points at real CloakBrowser for
T3–T7 (challenge/spinner behavior isn't reproducible in happy-dom), T1–T2 use a fake `BrowserPort`.

## 4. Migration touchpoints in Phase 1

Deliberately minimal — Phase 2 owns migrations:

- `JsonSessionStore` **reads** v1 session files as-is (schema is forward-compatible per `05` §5) and
  **writes** with no `schemaVersion` addition yet — a Phase 1 `runJob` resume of a v1 session must not
  produce a file v1 can no longer read (side-by-side operation guarantee, `05` §2 rollback note).
- Output EPUBs land in the configured dir; nothing v1-owned is renamed or moved (`05` §6).
- One guard only: `JsonSessionStore` refuses to overwrite a session whose `config` contains keys it
  doesn't recognise **unless** they're preserved verbatim on write (v1's `writeConfig` unknown-key rule,
  applied at session level for consistency).

## 5. Work breakdown (suggested commit order)

1. `core/domain/*` + `ports/*` (types only; repo compiles).
2. `adapters/browser-playwright` + fake port + SelectorService + T1.
3. ChapterExtractor + T2/T3.
4. ChapterListService (TOC + sequential) + T6.
5. ScrapeService (queue port) + NoopUI + JsonSessionStore + T4/T5/T7.
6. epub-archiver move + T8.
7. `app/runJob.ts` + `loadJobFile.ts` + acceptance run: `node dist/app/cli-shim.js run --job fixtures/job.yaml` producing a valid EPUB (temporary shim until Phase 5 wires `cac` — or land `cac` with the single `run` command now, per ADR-005's dogfooding note).

**Phase 1 done when:** `pnpm test` green, acceptance bullets in `04` §Phase 1 demonstrable in CI,
and a maintainer can resume a *v1-created* session file through v2's `runJob` without v1 losing the
ability to resume it afterwards.
