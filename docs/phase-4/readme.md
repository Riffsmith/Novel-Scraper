# Phase 4 - Scraping Flows in the TUI: Investigation & Design

> **Status: proposal.** This is an investigation-and-design document written *before* the
> implementation, following the same shape as `docs/phase-1/readme.md`, `phase-2/readme.md`, and
> `phase-3/readme.md`. It proposes how Phase 4 ("Scraping flows in the TUI") should be built against
> the *current* v2 code. It does **not** modify any business logic. Design decisions with real
> trade-offs are flagged as ADR candidates (ADR-P4-*) rather than silently decided.

Roadmap reference: `docs/04-implementation-roadmap.md` §"Phase 4".
Design spec: `docs/03-tui-design.md` (screen shell + task model).
Governing ADRs: ADR-002 (@clack/prompts), ADR-003 (hexagonal), ADR-005 (TUI + CLI share `ScrapeService`).
Hard contracts: AGENTS.md - v1 `src/tui/` and `src/index.ts` stay byte-untouched until Phase 6.

**Goal in one sentence:** replace every remaining Phase 3 stub with a working scrape flow - the
NewScrape / ManualWizard / AutoProbe / AutoCustomize / ChapterList / Task screens - so a user can
start, customize, run, review, resume, and post-save a scrape entirely inside the new Clack shell,
ending in the same summary card + optional profile-save prompt as v1, with all three v1 entry paths
(manual, auto fast path, auto with customization) reaching a live `ScrapeService.run`.

---

## 1. Investigation - what Phase 4 must faithfully port

Phase 4 owns parity for audit sections *Entry flows*, *Chapter-list review*, *Progress bar*, and
*Profile-save prompt* (roadmap traceability table, `04` §"Traceability"). It completes the two
Phase 3 stubs (MainScreen's "Start a new scrape", ResumeScreen's "Resume now") and replaces
`tui/prompts.ts` / the non-screen remainder of `src/index.ts`. Reading the v1 sources, the concrete
behaviors that must survive are:

### 1.1 The auto-vs-manual entry split (`src/index.ts:162-183`)

`mainMenu()`'s scrape branch asks `mode: auto | manual` once, then routes. v2 already has this first
decision point its own way: `MainScreen` "Start a new scrape" currently renders a notice stub
(ADR-P3-E). Phase 4 wires that menu choice into a `NewScrapeScreen` that captures the **entry URL**
upfront (used for profile lookup, resume-offer matching, and domain derivation), then routes to the
manual or auto flow. The entry-URL capture is currently split between `startScrape`
(`index.ts:387-414`) and `startAutoScrape` (`index.ts:583-600`); Phase 4 unifies it into one screen
(03-tui-design §2 lists `NewScrapeScreen` = "Auto vs Manual entry, entry-URL prompt").

### 1.2 The manual wizard (`src/tui/prompts.ts:gatherConfig` `:280-735`, 456 LOC)

The "23-step" linear wizard. Because Escape must step back one *field* (not bail), v1 routes it
through `runWizard` (`tui/wizard.ts:57-88`). The behavior table that must survive:

| Behavior | v1 evidence | Design consequence |
|---|---|---|
| Method first (`toc`/`sequential`), pre-filled from profile | `:301-320` | Wizard groups in exact order: source → extraction → metadata → output → review. |
| Locator entry is its own sub-flow (kind → value → flags) | `promptLocator` `:62-159` | Regex needs a flags step; XPath strips `xpath=` prefix (`:115`); CSS/XPath don't ask for flags. |
| Fallback locators appended with a running "priority order" print | `appendFallbacks` `:191-229` | Loop of "add/# / stop" confirms; order is user-visible. |
| `contentSelector` required, title/exclusion gated by toggles | `:407-483` | `titleSelector` only when `separateTitle`; exclusions split by `,` and filtered. |
| Multiline text via one-paragraph-at-a-time editor | `promptMultilineText` `:161-184` | Blank line terminates; joins with `\n\n`. |
| Cover selector (`none`/`url`/`file`) gates two conditional fields | `:552-595` | `coverUrl` only when `url`, `coverPath` only when `file`. |
| Perf: concurrency 1-5, delay `min-max`, defaults from profile-or-global | `:622-656` | `profile?.c` ?? `appCfg.defaultC`; same for delay. |
| Review + final confirm | `:658-695` | Final card; a **false** confirm aborts (`process.exit`) - v2 must instead return a `Cancel`/abort result so the shell can recover. |
| Assembly into `ScraperConfig` with CHAPTERLINKS EMPTY | `:700-735` | Discovery runs *after* the wizard, feeding the chapter list. |

In v2 this whole function becomes `ManualWizardScreen`. Its `validateNonEmpty`, `validateRegex`,
`validateUrl`, and `defaultFilenameFor` are pure helpers that move into the ui-clack adapter
(`validation.ts` / `format.ts` or a new `wizardHelpers.ts`) - never into core.

### 1.3 The auto flow (`src/index.ts:startAutoScrape` `:579-846`, 268 LOC)

Two-phase: an adapter **probe** then a confirm/fast-path-or-customize split. Behaviors:

| Behavior | v1 evidence | Design consequence |
|---|---|---|
| Paste novel URL, find `SiteAdapter` by `matches()`, fallback to manual | `:588-617` | `findSiteAdapter` must be reachable from the TUI. |
| Probe via browser: `scrapeMetadata` then `scrapeChapterLinks` with spinners | `:663-709` | `AutoScrapeResult` populated; progress shown with `PromptProvider.spinner()`. |
| `AutoProbeScreen` summary (title/author/chapters/first/last/selector/cover) | `:719-739` | The "fast path's most important single line" = the content selector (03-tui-design §4.3). |
| Confirm #1: "use these as-is?" → `buildQuickAutoConfig` (no prompts) | `:741-752`, `:1145-1186` | Fast path = zero further questions besides final confirm. |
| Decline → chapter-list review then `gatherAutoConfig` | `:754-770` | Order matters: review links **before** the customize wizard. |
| Confirm #2: "start scraping N chapters now?" (fast path only) | `:805-827` | Customize path already asked its own final confirm - don't double-ask. |

`gatherAutoConfig` (`:764-1139`) shares ~60% of its steps with `gatherConfig` (audit P5 - the
"make twice" duplication). Phase 4 should keep the two screens but extract the common
extraction/metadata/output/perf group definitions so the duplication is one shared definition, not
two wall-of-code functions.

### 1.4 Chapter-list review (`src/tui/prompts.ts:editChapterLinks` `:1197-1294`)

A **non-wizard action loop** (03-tui-design §4.5): not a Clack `group()`, but a table with
modal actions. It must become `ChapterListScreen`, preserving:

- Table render of current links (numbered; `printChapterList`).
- Actions: `proceed`, `remove` (by `parseRanges` `:1279-1294`, supporting `5`, `10-20`, `5, 10-20, 99`),
  `add` (comma/newline URL list, valid-URL filter), `reverse` (**with confirm** - order is almost
  always intentional), `view` (full list).
- It operates on an in-memory mutable array and returns the final list when the user proceeds. In v2
  this is a pure-in-adapter helper consumed by both the manual (post-discovery) and auto
  (customize path) flows.

### 1.5 The scrape-and-package tail (`src/index.ts:scrapeAndPackage` `:196-324`)

Shared by manual, auto, and resume. With the v2 `ScrapeService`, most of it is already expression of
existing services; the TUI-owned pieces are: the `q`/cancel key, the live summary, and the
post-scrape profile save. Key contracts:

- A checkpoint is written **before** the first chapter and throttled while running; the session is
  deleted **only after** the EPUB build succeeds. `ScrapeService.run` already owns all of this
  (`scrape-service.ts:100-121`, `:238-265`). The TUI must not duplicate it.
- If zero chapters scrape, warn with the selector that failed and stop.
- If some chapters failed, list them.
- Post-scrape `promptSaveProfile` only fires when `domain && isNewDomain && appCfg.askSaveProfile`
  (`:298-323`) - see §1.8.

### 1.6 The resume path (`src/index.ts:resumeSession` `:332-376`)

`resumeSession(session)` reloads config + cookies for the session's domain, launches the browser,
then calls the shared tail. Two reachable entry points:
- ResumeScreen's "Resume now" (currently a Phase 3 stub notice).
- The **entry-URL resume offer** at the top of both `startScrape` (`:419-442`) and `startAutoScrape`
  (`:623-646`): if `findResumableSessionByUrl(entryUrl)` matches, offer to resume instead, else offer
  to discard the old checkpoint. `SessionStore.findByEntryUrl` already exists (Phase 1) - this is the
  consumed seam.

### 1.7 THE GAP - site adapters are not yet a v2 concern

Auto-scrape requires `SiteAdapter` (`sites/types.ts:24-50`) and the two implementations
(`sites/wtrLab.ts`, `sites/novelfire.ts`). **These still live in v1 oracle territory and import
`Page` from `playwright`** (`sites/types.ts:1`, `sites/wtrLab.ts:1`). They also embed the P4
evaluate-as-*string* footgun (`wtrLab.ts:61-73`). The roadmap's Phase 4 scope and parity lines do
**not** list `sites/*`, and AGENTS.md's oracle list is `scraper/queue/epub/sessions/tui` (not
`sites/`) - but **the auto flow cannot work end-to-end without a PageHandle-based adapter.**

This is the single most consequential finding of this investigation. **ADR-P4-A candidate:** Phase 4
must port the `SiteAdapter` interface and the two implementations into a v2 adapter
(`adapters/site-wtr-lab/` + `adapters/site-novelfire/` + a registry under `adapters/site-registry/`),
re-typed onto `PageHandle` so the probe goes through the port (P4-safe, driver-agnostic), keeping
the same `default*Selector` surface the review screens pre-fill from. The v1 `sites/*` files stay
untouched as the oracle until Phase 6 (same rule as every other v1 module). `matches()` stays a
hostname-closure test (`/(^|\.)wtr-lab\.com$/i`, etc.) - never a substring test (AGENTS.md).

### 1.8 Post-scrape profile save (`src/tui/configManager.ts:promptSaveProfile` `:654-698`)

Already called out by `phase-3/readme.md §1.2` as a Phase 4 deliverable. Confirm → optional label →
`ProfileStore.save`. The partial-profile cutoff that decides which perf fields are saved differs
from the global defaults (`index.ts:303-321`). v2 has `ProfileStore.save(domain, profile)` (Phase 2)
- this is the consumed seam. The "is new domain" flag (`hasProfile`) exists via
`ProfileStore.load(domain) === null`.

### 1.9 Progress rendering (`src/tui/display.ts:createProgressBar`, `summary`)

- v1's byte-dense progress bar (`cli-progress`, `display.ts:54-68`) becomes the **TaskScreen** body
  (03-tui-design §4.4): bar drawn by a custom renderable, not `cli-progress`, composed with the
  shell. `ScrapeService` emits `chapter.done` per chapter, and `UIAdapter.onProgress` gives a
  `(done, total)` convenience - the TaskScreen can count completions against `chapterUrls.length`.
- The post-scrape `summary` card (`display.ts:99-131`) becomes a renderable summary in the TaskScreen
  tail or a dedicated notice - same fields (title, chapters, words, duration, output, error note).
- The `q` quit-during-scrape key binds to `ScrapeService.cancel()` + the existing quilt hook
  (phase-3 §2.6 already reserves `flushOnQuit` for exactly this).

### 1.10 The discovery boundary - TUI runs it, `ScrapeService` does not

v1 does discovery *before* the queue (`scrapeTOC` / `collectLinksSequentially` in `startScrape`; the
adapter probe in `startAutoScrape`), then hands a static URL list to the queue. v2 mirrors this: the
TUI must run discovery via `ChapterListService` (TOC/sequential) or the ported SiteAdapter (auto)
**before** any `ChapterListScreen` / `ScrapeService.run` call, because `ScrapeService.run` deliberately
throws if given no `chapterLinks` and no resume session (`scrape-service.ts:67-70`). `runJob` already
does discovery+scrape in one call (`app/runJob.ts:54-101`); the TUI needs a **discovery-only** path
that returns the URL list so the ChapterListScreen can review/edit between discovery and scrape.
**ADR-P4-B candidate:** factor the discovery block out of `runJob` into a reusable
`DiscoveryService` (or an exported `discoverJobChapters(job, browser, cookies, ui, log)` helper)
that both `runJob` (Phase 5 CLI) and the TUI call.

---

## 2. Design

### 2.1 Module layout (additions to `src/adapters/ui-clack/` + one core type-population)

```
src/adapters/ui-clack/
├── screens/
│   ├── NewScrapeScreen.ts        # new - auto vs manual + entry URL + resume-offer
│   ├── ManualWizardScreen.ts     # new - grouped clack wizard -> JobConfig (contract, not prompts)
│   ├── AutoProbeScreen.ts        # new - probe summary + confirm #1 + route fast/customize
│   ├── AutoCustomizeScreen.ts    # new - gatherAutoConfig port (shares group defs)
│   ├── ChapterListScreen.ts      # new - table action loop (proceed/remove/add/reverse/view)
│   └── TaskScreen.ts             # new - live progress, q to cancel & checkpoint, summary tail
├── wizardGroups.ts               # NEW shared group/step definitions (kills the P5 duplication)
├── wizardShared.ts               # NEW locator/multiline/fallback sub-flows + validators moved here
├── scope.ts                      # NEW small pure helpers (defaultFilenameFor, ask-scrape tails)
├── TaskRegistry.ts               # NEW live TaskRegistry (populates the Phase 3 empty stub)
└── format.ts                     # EXTEND: taskBar(), summaryCard() renderables
```

Plus (ADR-P4-A):
```
src/adapters/site-registry/       # findSiteAdapter(SITE_ADAPTERS) over PageHandle
src/adapters/site-wtr-lab/        # wtrLab port onto PageHandle
src/adapters/site-novelfire/      # novelFire port onto PageHandle

src/core/domain/                 # SiteAdapter + AutoScrapeResult move HERE (PageHandle imports only)
```
- `core/domain/SiteAdapter.ts` - the ported interface, now referencing `PageHandle` (type-only,
  from `ports/BrowserPort.ts`). Core depends on the port, which is the correct hexagonal direction
  (an adapter protocol, not a driver). The `default*Selector` fields stay on the interface.
- There is **no `ports/` entry** for site adapters - they are a pluggable set, registered in
  `app/tui.ts` (and later `app/cli.ts` in Phase 5) alongside the other adapters.
- `AutoScrapeResult` moves to `core/domain/` too so both screen and service reference one shape.

`src/app/tui.ts` (**composition root**) wires: the four stores + `PlaywrightBrowserPort` + logger +
clack provider (Phase 3) **plus** a live `TaskRegistry` implementation passed as the `tasks` value in
`ShellDeps` (replacing the `{}` stub), the site registry, and runs discovery through the shared
`DiscoveryService`.

### 2.2 `TaskRegistry` - the populated Phase 3 stub

Phase 3 shipped `interface TaskRegistry {}` and `app/tui.ts` passes `const taskRegistry = {}`
(`tui.ts:37`). Phase 4 defines a live implementation (03-tui-design §6 task contract):

```ts
// adapters/ui-clack/TaskRegistry.ts
export interface ScrapeTask {
  id: string;
  title: string;
  status: "pending" | "running" | "paused" | "done" | "failed";
  progress: { done: number; total: number };
  cancel(): Promise<void>;
}
export interface TaskRegistryEvents {
  subscribe(fn: () => void): () => void;
  reset(): void;
  get(): ScrapeTask | null;
}

export class LiveTaskRegistry implements TaskRegistryEvents {
  // - starts a task with { id, title, total }
  // - progress comes from a UIAdapter wiring ScrapeEvent chapter.done / checkpoint.saved
  // - cancel() singularly owns ScrapeService.cancel() (the flushOnQuit hook calls it too)
}
```

The `ShellContext.tasks` field typo (`ShellContext.ts:45` "Empty in Phase 3") is filled in by
passing the live registry at the composition root. The `Shell`/headers read it to render the
`task: Shadow Slave - 1,203/2,500 ch` header strip (03-tui-design §3), keyed off
`task.progress` + a title. The `flushOnQuit` hook (`tui.ts:70-74`) becomes: if a task is running,
`task.cancel()` (which flips `ScrapeService.cancel()` and saves a final checkpoint) before
`browser.closeAll()` - exactly the phase-3 §2.6 reservation.

### 2.3 `NewScrapeScreen` (auto vs manual + entry URL + resume-offer)

```
render(ctx):
  choice = select(auto | manual)                  // MainScreen "new" pushes here
  entryUrl = text("Entry URL", validate: validateUrl)
  domain = hostnameFrom(entryUrl); profile = profiles.load(domain); isNewDomain = !profile
  existing = sessions.findByEntryUrl(entryUrl)     // §1.6 resume-offer
  if existing:
     resume?  -> push TaskScreen(resume: existing)   // and skip straight to scrape
     else discard? -> sessions.delete(existing.id)
  routes: auto -> AutoProbeScreen(entryUrl, domain, profile, isNewDomain)
          manual -> ManualWizardScreen(entryUrl, domain, profile, isNewDomain)
  return { action: "replace", screen: <route> }    // not push - main stays under the stack
```

Cancellation at each prompt returns `{ action: "pop" }` (back to main), respecting ADR-P3-H.

### 2.4 `ManualWizardScreen` - Clack `group()` mapping

The 23 linear steps compile into the grouped order from 03-tui-design §4.2. Escape on a group moves
back one *group* (the phase-3 §2.6 note that "the group-level split arrives with Phase 4's group()
wizards"). Concretely:

| Group | Questions | Source steps |
|---|---|---|
| Source | method; tocUrl OR (first/last chapter) | `:301-365` |
| Extraction | contentSelector; separateTitle; titleSelector (gated); exclusions | `:407-483` |
| Metadata | title, author, language, publisher, synopsis (editor), cover+conditional | `:485-595` |
| Output & performance | outputDir, outputFilename, concurrency, delayRange | `:597-656` |
| Review | final card + confirm | `:658-695` |

The locator sub-flow (`promptLocator`) lives only in the `Source` group for sequential: kind → value
→ flags → fallback loop. Because clack groups don't give the "skip back over skipped steps" of
`runWizard`, the screen keeps an in-memory answer object and a small back-stack that mirrors
`runWizard`'s skip-aware walk (`wizard.ts:63-85`) - Escape pops to the previous *applicable* group.
**A false final confirm** returns a sentinel result the shell maps to `pop` (abort to main) - never
`process.exit`.

Output: a `JobConfig` (empty `chapterLinks` + `output.epub: true`). The screen does **not** scrape.

### 2.5 `AutoProbeScreen` + `AutoCustomizeScreen`

`AutoProbeScreen`:
1. `probe(ctx, adapter, entryUrl, cookies)`: spinner "fetching metadata" → `adapter.scrapeMetadata(page, url)`
   → spinner "collecting chapter links" → `adapter.scrapeChapterLinks(page, url, {waitUntil, navTimeoutMs})`.
   Uses the browser port's `launch`/`createContext`/`newPage`; closes the probe context when done.
2. Render the §1.3 scan summary (title/author/chapters/first/last/content-selector/cover).
3. Confirm #1 "use these as-is and continue?":
   - yes → build *quick* `JobConfig` (port of `buildQuickAutoConfig`, zero prompts) → final confirm
     ("start N chapters now?") → `push TaskScreen(job, chapterLinks)`.
   - no → `replace ChapterListScreen()` → on proceed → `replace AutoCustomizeScreen(config, auto)`.
4. On `matches()` miss (unsupported site): offer "switch to manual setup?" exactly like v1
   (`index.ts:605-616`), routing to `ManualWizardScreen`.

`AutoCustomizeScreen` is the `gatherAutoConfig` port. It reuses the same group definitions as the
manual screen where the fields overlap (extraction/metadata/output/perf - the 60% shared by audit
P5), but seeds `initial` from the probe result (`auto.metadata`), the site defaults
(`adapter.default*Selector`), and the profile. It **ends with its own final confirm** (so the fast
path's second confirm is not double-asked - the two paths are mutually exclusive). Synopsis
auto-fetch behavior (`:946-966`: "edit the auto-fetched synopsis? No keeps it as fetched") must be
preserved. The chapter-list review happens **before** this screen, matching v1 ordering
(`index.ts:754-770`).

### 2.6 `ChapterListScreen` - table action loop

A single-screen loop (03-tui-design §4.5), not a wizard:

```
render(ctx, urls): Promise<{ action: "proceed" | "back"; urls: string[] }>
  current = [...urls]
  loop:
    render numbered table (format.chapterTable)
    select(proceed / remove / add / reverse / view / back)
    remove  -> text("indices/ranges", validate: parseRanges) -> filter
    add     -> text("URLs") -> validate-url filter -> push
    reverse -> confirm("reverse order?") -> current.reverse()
    view    -> render full table
    proceed -> return { action:"proceed", urls: current }
    cancel/back -> return { action:"back" }
```

`proceed` with zero chapters returns the caller a "nothing to scrape" notice (v1 `index.ts:540-542`).
`parseRanges` moves into this adapter (pure) so both manual and auto reach it.

### 2.7 `TaskScreen` - live progress + cancel + summary tail

```
render(ctx, params: { job, chapterUrls, resumeSession? }):
  browserLaunchOpts = fullLaunchOpts(ctx.config, job)     // ADR-P4-C, see §2.8
  cookies = domain ? selectCookieProfileForScrape(domain) : []
  task = tasks.start({ id, title: job.metadata.title, total: chapterUrls.length })
  // wire a UIAdapter that forwards ScrapeEvent -> task progress + this screen's render update
  result = await (params.resumeSession
        ? scrapeService.run(job, cookies, { session: resumeSession })
        : scrapeService.run(job, cookies))
  tasks.finish(task, result)
  render summary card (title/chapters/words/duration/output/errors)
  if errors.length: list failed URLs (§1.5)
  maybeSaveProfile(ctx, domain, isNewDomain, appCfg, config) when askSaveProfile && isNewDomain
  return { action: "pop" }                                // back to main, header now idle
```

- The `q` key is handled by the **shell-level** listener (phase-3 §2.6) calling `tasks.cancel()` /
  `task.cancel()` → `ScrapeService.cancel()`, saving the final checkpoint. No new global listener.
- Because `ScrapeService.run` owns browser lifecycle + context pool + checkpoints + EPUB + session
  deletion (`scrape-service.ts:91-96`, `:100-121`, `:241-273`), the TaskScreen is a thin *renderer*
  over it, not an orchestrator.
- **Live progress without corrupting log lines** (acceptance): the TaskScreen body is redrawn from
  `chapter.done`/`checkpoint.saved` events, while winston keeps writing to the log region above the
  header - the same separation ADR-P3-B / §2.7 already guarantees, since the TaskScreen goes through
  `PromptProvider` and `ClackUIAdapter`, not `console.log`/`cli-progress`.

### 2.8 Boundary changes required in `core/` (explicit, minimal)

Investigation found two places the current v2 core cannot yet serve the TUI end-to-end. Both are
**small, flagged changes**, not rewrites:

1. **Browser launch options are hardcoded.** `ScrapeService.run` launches with a constant
   `headless: job.headless, humanize:false, preset:"default", seed:null, tz:"America/New_York",
   locale:"en-US"` and `maxRetries: 3` (`scrape-service.ts:58-65`, `:73`; phase-1 deviation D10).
   v1 launches the scrape browser with the **user's** `humanize`/`humanPreset`/`fingerprintSeed`/
   `maxRetries` (`index.ts:487-494`; `config/appConfig.ts`). **ADR-P4-C candidate:** thread the full
   `AppConfig` browser/stealth pair into `ScrapeService` (via `JobConfig` additive options or a
   richer run signature) so the TUI honors the user's settings, while the Phase 5 CLI keeps defaults.
2. **Discovery is not exposed separately.** `runJob` runs discovery+scrape in one call
   (`app/runJob.ts:54-101`). The TUI needs discovery-only for the ChapterListScreen gap (ADR-P4-B,
   §1.10). No `ScrapeService` change - just extract/reuse.

Neither touches existing EPUB/store/session behavior; AGENTS.md v1 modules are unaffected.

### 2.9 Cookie resolution + resume + save-profile

- **Cookie resolution** (`selectCookieProfileForScrape`, `cookieManager.ts:712-753`) is *read-only*:
  0 profiles → none; 1 → auto-load + `markUsed`; N → picker (with cookie counts + lastUsed via
  `CookieStore.describeProfile`). Phase 3 deliberately "ported and consumed in Phase 4"
  (phase-3 §1.1). Phase 4 implements it in the adapter as `resolveCookiesForScrape(ctx, domain):
  Promise<DomainCookie[]>` used by both `TaskScreen` and the auto-probe.
- **Resume from ResumeScreen** replaces the stub notice (`ResumeScreen.ts:51-55`) with
  `push TaskScreen({ resumeSession: session })`, reusing §2.7. `getBrowser` cookie re-selection for
  the resumed domain carries over (§1.6).
- **Save-profile** (`promptSaveProfile`) becomes a small adapter helper `maybeSaveProfile(ctx,
  domain, isNewDomain, appCfg, config)` called from the TaskScreen tail. It builds the partial
  profile with the v1 "differs from global default" cutoff and saves via `Profiles.save`.

### 2.10 What Phase 4 does NOT own

- **Phase 5** owns the `wnscrape` bin repoint (`wnscrape` → TUI default), the cac CLI wiring, and
  the `run --job` share with `runJob`. Phase 4 stays reachable via `pnpm dev:tui` (phase-3 §2.9).
- **Phase 6** owns physical deletion of `src/tui/`, `sites/*` v1 originals keep parity duty until
  Phase 4's ports of them land; the roadmap's *"delete `tui/keys.ts`"* and Enquirer removal remain
  Phase 6 (ADR-P3-C). Phase 4 keeps `src/index.ts`, `src/tui/*`, `sites/*` byte-untouched.
- Site-adapters **beyond** the two existing ones, Manga mode, web UI, etc. (post-parity backlog).

---

## 3. Test plan (maps 1:1 to roadmap acceptance)

All tests are unit-level with `ScriptedPromptProvider` + `FakeBrowserPort` + real JSON/YAML stores
on isolated XDG dirs (the phase-2/phase-3 test pattern). No TTY, no clack rendering, no public
internet, no CloakBrowser binary. The real-binary paths (a live headed capture, a live site probe)
are manual QA / `CLOAKBROWSER_BINARY_AVAILABLE=1` gated (acceptance suite).

| # | Test | Fixture / harness | Asserts |
|---|---|---|---|
| T1 | **Manual walkthrough (toc) ends in a runnable `JobConfig`** | scripted prompts | group order exact; `chapterLinks` empty; `output.epub:true`; validators reject (bad URL, empty selector, out-of-range perf); Escape backs one group; false final confirm aborts to `pop`, never `process.exit` |
| T2 | **Manual (sequential) locator sub-flow** | scripted prompts | kind→value→[flags] for css/xpath/regex; `xpath=` prefix stripped; fallback loop preserves priority order; regex flags default `i` |
| T3 | **Auto fast path** | `FakeBrowserPort` + a fake `SiteAdapter`(page) | probe calls `scrapeMetadata`+`scrapeChapterLinks` via `PageHandle`; confirm #1→build quick config→confirm #2→TaskScreen with `chapterLinks`; selector line rendered |
| T4 | **Auto customize path** | fake adapter + scripted prompts | decline confirm #1→ChapterListScreen→AutoCustomizeScreen pre-filled from adapter+profile; synopsis "No keeps as fetched"; single final confirm |
| T5 | **Unsupported site auto → manual fallback** | prompt scripts | "not supported" → "switch to manual?" yes routes to `ManualWizardScreen`, no pops to main |
| T6 | **ChapterList editing** | scripted prompts | remove range `10-20`/`5, 10-20, 99` via `parseRanges`; add comma/newline URLs with invalid filtered; reverse confirms; proceed returns edited list; proceed-empty → "nothing to scrape" notice |
| T7 | **TaskScreen progress + cancel** | `FakeBrowserPort` + `FakePage` static fixture | `chapter.done` events advance the bar to `total`; `q`/cancel calls `ScrapeService.cancel()` and final checkpoint lands in `JsonSessionStore`; summary card fields match v1 `summary()`; errors listed when present |
| T8 | **Resume from ResumeScreen + entry-URL offer** | `JsonSessionStore` with a midpoint session + `FakeBrowserPort` | ResumeScreen "Resume now" pushes TaskScreen with `resumeSession`; already-done chapters NOT re-requested (assert `browser.visitedUrls`/access log); new-scrape entry-URL match offers resume then discard |
| T9 | **Post-scrape profile save** | `JsonProfileStore` | `askSaveProfile` + new domain → confirm+label → saved joint store shows profile; decline + `!askSaveProfile` → store untouched; perf fields omitted when equal to global defaults |
| T10 | **Cookie resolution** | `JsonCookieStore` (0/1/N profiles) | 0 → none; 1 → auto-load + `markUsed`; N → picker; "don't use any" → none |
| T11 | **SiteAdapter port parity** | static fixture HTML per adapter | wtr-lab/novelfire `scrapeMetadata`+`scrapeChapterLinks` return the same links/`AutoScrapeResult` shape as their v1 source against the probe page (page-shape fixtures) |
| T12 | **`TaskRegistry` + header strip** | live registry + fake stdin | task starts/publishes progress/no-op-quit; header shows `task: title - done/total`; cancel→quit flushes + `closeAll` once (re-entrant-safe) |

Network isolation: T3/T4/T7/T11 use a local `node:http` fixture server on 127.0.0.1 (phase-1
pattern); the `SiteAdapter` ports are tested against static HTML, not live sites. The scraper's own
queue/challenge/resume behavior is already covered by `phase-1`-era tests (`scrape-service*.test.ts`)
- Phase 4 tests assert **wiring and screen flow**, not re-testing the engine.

## 4. Acceptance mapping (roadmap Phase 4)

- *"All three v1 entry paths (manual, auto fast path, auto with customization) work end-to-end."*
  → T1-T5 + a manual QA run through `pnpm dev:tui` on a fixture/real site recorded in the PR.
- *"A long scrape shows continuous progress without corrupting log lines."* → T7 + §2.7's
  shell/log-region separation (ADR-P3-B).
- *"Confirming 'save profile' writes a v2 profile; decline leaves the store untouched."* → T9.
- Parity delivered: `tui/prompts.ts` (T1,T2,T6), `index.ts` remaining flows (T3-T5,T7-T10); the
  `sites/*` parity gap is closed by the ADR-P4-A port (T11).
- v1 oracle safety: `src/index.ts`, `src/tui/*`, `src/sites/*` stay byte-untouched and compiling;
  `pnpm dev` still runs v1 (ADR-P3-C extends to `sites/*` by the AGENTS oracle rule).
- Existing suites stay green: Phase 3's MainScreen/ResumeScreen "scraping flows in Phase 4" notice
  tests (`tests/phase-3-tui.test.ts` T2/T3/resume) are **updated** to assert the new navigation
  instead of the stub, and are part of this phase.

## 5. Work breakdown (suggested commit order)

1. **Foundation:** `core/domain/SiteAdapter.ts` + `AutoScrapeResult`, `wizardHelpers` split
   (validators, `defaultFilenameFor`, `parseRanges`) + ADR-P4-B (factor `DiscoveryService` out of
   `runJob`) + a `wizardGroups` shared definition extraction. Green.
2. **`TaskRegistry`** live impl + TaskScreen + `format.taskBar`/`summaryCard` + `flushOnQuit` wiring
   (T7, T12).
3. **`NewScrapeScreen`** + entry-URL capture + resume-offer (T8's second half).
4. **`ManualWizardScreen`** + `ChapterListScreen` (T1, T2, T6).
5. **ADR-P4-A:** port wtrLab/novelfire onto `PageHandle` + `site-registry` (T11).
6. **`AutoProbeScreen` + `AutoCustomizeScreen`** + cookie resolution + unsupported-site fallback
   (T3, T4, T5, T10).
7. **Tail wiring:** `resolveCookiesForScrape`, `maybeSaveProfile`, ResumeScreen resume action
   (T9, T8), and update the Phase 3 stub-navigation tests.
8. **ADR-P4-C:** thread user browser/stealth/`maxRetries` from `AppConfig` into the scrape path;
   confirm defaults held for the CLI.
9. Manual QA: run `pnpm dev:tui` through manual, auto-fast, auto-customize, resume (fixture + one
   live site where available) + a long scrape for the no-log-corruption check; record divergences
   in `deviation-log.md`.

**Phase 4 done when:** `pnpm typecheck` / `pnpm test` / `pnpm build` are green with the new suite,
a maintainer can reach a running, resumable, post-save-summarized scrape through the shell with all
three entry paths - and every durable behavior above traces to an ADR or a deviation-log entry when
it diverges from v1.

---

## Appendix - decisions to confirm before implementing (ADR-P4-*)

| ID | Question | Recommendation |
|---|---|---|
| ADR-P4-A | Site adapters are still v1 (`Page` from playwright). Port them onto `PageHandle` now? | **Yes - required** for auto flow; port to adapter dirs, keep v1 oracle untouched until Phase 6. |
| ADR-P4-B | TUI needs discovery-only (not discovery+scrape-in-`runJob`). Factor a shared `DiscoveryService`? | **Yes** - extract from `runJob`, both TUI and Phase 5 CLI reuse it. |
| ADR-P4-C | `ScrapeService` hardcodes launch opts + retries; TUI must honor user settings. Thread `AppConfig` through? | **Yes** - additive options so Phase 5 CLI defaults are preserved. |

These are proposed, not decided - implementers should confirm each before landing, and record the
outcome in `docs/phase-4/adr.md` + `deviation-log.md` as the code lands, matching the
post-implementation pattern of phases 1-3.