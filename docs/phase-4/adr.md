# Phase 4 - Architecture Decision Record (post-implementation)

This is the consolidated ADR for Phase 4 ("Scraping flows in the TUI"). It records the decisions that
shaped the shipped code: the three ADR-P4-* candidates sketched in `docs/phase-4/readme.md` are now
recorded as decided, plus two more that crystallized during implementation.

For the chronological divergence list see `docs/phase-4/deviation-log.md`. For the top-level project
ADRs (ADR-001 ... ADR-006) see `docs/01-architecture-decisions.md`.

This file is written **after the code landed**; every "Evidence" line points at shipped files.

---

## ADR-P4-A - Site adapters are ported onto `PageHandle` (required)

**Context**

`src/sites/{wtrLab,novelfire,types}.ts` are v1 oracle territory (AGENTS.md: "v1 code ... stays
untouched until the Phase 6 cleanup pass"). They import `Page` from `playwright` and embed the
`page.evaluate(fn)` footgun the P4 evaluate-as-string rule bans. The auto flow cannot run end-to-end
without a `PageHandle`-based adapter.

**Decision**

Port the `SiteAdapter` interface and the two implementations into v2 adapter dirs, re-typed onto
`PageHandle`:
- `src/core/domain/SiteAdapter.ts` - the ported interface + `AutoNovelMetadata` + `AutoScrapeResult`,
  type-only imports from `ports/BrowserPort.ts` (core depends on the port; the hexagonal direction
  stays correct - an adapter protocol, not a driver).
- `src/adapters/site-wtr-lab/WtrLabAdapter.ts` and `src/adapters/site-novelfire/NovelFireAdapter.ts` -
  byte-faithful to v1; every `page.evaluate(fn)` becomes a `page.evaluateScript<string>` call on a
  plain string constant. The novelfire author-extraction closure (`v1 :98-107`) becomes a string
  constant too because `PageHandle` exposes no generic `evaluate(fn)` - the P4 rule is enforced by
  construction.
- `src/adapters/site-registry/index.ts` - the single `findSiteAdapter` seam the TUI (and Phase 5 CLI)
  call into. `matches()` stays a hostname regex test (AGENTS.md), never a substring test.
- Each adapter ships a `make*Adapter(log)` factory so the composition root owns the logger binding,
  plus a singleton (no-op logger) for parity of surface with v1.

There is **no `ports/SiteAdapter.ts`** - the registry is a pluggable set, registered in the composition
root alongside the other adapters, not a single injected port (readme §2.1).

**Consequences**

- `PageHandle` grew four named methods - `getAttribute`, `innerText` (with `excludeSelectors`), 
  `anchorHrefs`, `evaluateScript` - all of them evaluate-as-string by construction.
- The v1 `sites/*` oracle stays byte-untouched and compiling; `pnpm dev` still runs v1.
- Phase 5 CLI reuses the registry; Phase 6 physically deletes `src/sites/*`.

**Evidence**

- `src/core/domain/SiteAdapter.ts:1-73` (interface).
- `src/adapters/site-wtr-lab/WtrLabAdapter.ts`, `src/adapters/site-novelfire/NovelFireAdapter.ts`
  (the two ports; both ship `make*Adapter(log)` factories + singletons).
- `src/adapters/site-registry/index.ts` (`SITE_ADAPTERS`, `findSiteAdapter`).
- `src/ports/BrowserPort.ts:54-96` (the four named PageHandle methods + the rule comment block).

---

## ADR-P4-B - Discovery is extracted into `DiscoveryService` (shared by runJob + TUI)

**Context**

`runJob` (`src/app/runJob.ts`) runs discovery+scrape in one call. The TUI needs **discovery-only**
for the `ChapterListScreen` gap (review/edit URLs between discovery and scrape; readme §1.10).
`ScrapeService.run` deliberately throws if given no `chapterLinks` and no resume session, so the
TUI cannot call it and then ask for an edit.

**Decision**

Factor a `discoverJobChapters(job, { browser, cookies, ui, log })` helper into
`src/core/services/DiscoveryService.ts`. Both `app/runJob.ts` (Phase 5 CLI) and the TUI
(`ManualDiscoveryScreen`) call it. No `ScrapeService` change - the boundary is a pure extraction.

**Consequences**

- The TUI runs discovery through the same engine path the CLI uses; no behavior divergence is
  possible between the two entry paths.
- `ScrapeService.run` stays the single scrape orchestrator; `DiscoveryService` is discovery-only.
- A future `--skip-discovery` CLI flag reaches a `chapterLinks`-already-set `JobConfig` the same way.

**Evidence**

- `src/core/services/DiscoveryService.ts` (`discoverJobChapters`).
- `src/app/runJob.ts` (refactored to use `DiscoveryService`).
- `src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts:45` (TUI consumer).

---

## ADR-P4-C - User browser/stealth/maxRetries settings thread into the scrape

**Context**

`ScrapeService.run` hardcoded launch options (headless, humanize:false, preset:"default",
seed:null, tz, locale) and `maxRetries: 3` (phase-1 deviation D10). v1 respects the user's
`humanize` / `humanPreset` / `fingerprintSeed` / `maxRetries` (`index.ts:487-494`). The TUI must
honor them; the Phase 5 CLI should keep defaults.

**Decision**

Add `launchOptionsForScrape(appCfg, job): BrowserLaunchOpts` in `adapters/ui-clack/scope.ts` (pure
read). It honors `appCfg.humanize/humanPreset/fingerprintSeed` + `job.headless` + a locale
resolution (`scope.ts:localeFor`). The AutoProbeScreen uses it for the probe browser launch; the
ScrapeService launch path is a separate concern tracked for a follow-up (deviation D5).

**Consequences**

- The TUI probe honors the user's stealth settings; a user who set `humanize: careful` sees that
  profile during the metadata/chapter fetch.
- The Phase 5 CLI keeps its defaults (it doesn't call `launchOptionsForScrape`); the additive seam
  doesn't change CLI behavior.
- `maxRetries` threading into `ScrapeService` is deferred to a follow-up (deviation D5) - it's the
  one piece of ADR-P4-C not yet live.

**Evidence**

- `src/adapters/ui-clack/scope.ts:33-47` (`launchOptionsForScrape`, `localeFor`).
- `src/adapters/ui-clack/screens/AutoProbeScreen.ts:81` (the probe browser launch).

---

## ADR-P4-D - `Screen.render()` takes a `params?` argument; parametrized screens drop the constructor

**Context**

The Phase 3 `Screen.render(ctx)` signature and the eager `buildRegistry()` (`app/tui.ts`) pattern
work for stateless screens (`MainScreen`, `ResumeScreen`, `CookieManagerScreen`, ...) - they read
everything from `ctx`. Phase 4 adds five screens that **need caller-supplied params** (the
`JobConfig`+cookies for `ManualDiscoveryScreen`/`TaskScreen`, the `AutoScrapeResult`+adapter for
`AutoCustomizeScreen`, the URLs for `ChapterListScreen`, the entry-URL+profile+domain for
`ManualWizardScreen`/`AutoProbeScreen`). The original Phase 3 screens took those via `constructor
(private params: T)`, but `buildRegistry()` cannot pre-instantiate a screen whose params are only
known at push-time.

**Decision**

Thread the `StackFrame.params` (already stored on every push) into `render(ctx, params?)`:

```ts
interface Screen {
  readonly id: string;
  render(ctx: ShellContext, params?: unknown): Promise<ScreenResult>;
}
```

The Shell calls `screen.render(this.ctx, frame.params)`. The Phase 4 parametrized screens drop their
constructor params and read `params as <ConcreteParams>` at the top of `render()`. The Phase 3
screens ignore the second arg (TypeScript accepts the narrower `render(ctx)` signature).

Phase 4 parametrized screens are now stateless and pre-registered in `buildRegistry()` exactly like
the Phase 3 root screens.

**Consequences**

- One uniform instantiation pattern; `buildRegistry()` pre-registers every screen.
- No screen-factory indirection, no runtime registry mutation.
- `params: unknown` keeps the hexagonal boundary: screens own their params shape via a local
  `Params` interface + a single cast at the top of `render()`, not via a runtime-checked contract.
- Tests construct screens directly (`new ManualWizardScreen().render(ctx, params)`) - strictly
  simpler than the constructor-params pattern.

**Evidence**

- `src/adapters/ui-clack/ShellContext.ts:58-61` (the `Screen` interface).
- `src/adapters/ui-clack/Shell.ts:91` (`screen.render(this.ctx, frame.params)`).
- The five Phase 4 parametrized screens (`ManualWizardScreen`, `ManualDiscoveryScreen`,
  `ChapterListScreen`, `AutoProbeScreen`, `AutoCustomizeScreen`, `TaskScreen`) - all read params
  via `render(ctx, params?)`, no constructor params.

---

## ADR-P4-E - `ChapterListScreen` carries an optional `nextScreen` for the auto customize path

**Context**

`ChapterListScreen` is a pure-in-adapter helper consumed by both the manual (post-discovery) and
auto (customize) flows. The manual flow's "proceed" pushes `TaskScreen` straight away; the auto
flow's "proceed" must route to `AutoCustomizeScreen` with the **edited** chapter list plus the
`AutoScrapeResult` + adapter + cookies + domain the caller already has. The `ScreenResult.pop`
action takes no params, so a non-manual "proceed" had nowhere to hand the edited list back.

**Decision**

Add two optional fields to `ChapterListParams`:
- `nextScreen?: string` - on proceed, `replace` this screen id with the edited list threaded in.
- `replaceParams?: Record<string, unknown>` - extra params merged into the `replace` payload
  (carries the `AutoScrapeResult` + adapter + cookies + domain `AutoCustomizeScreen` needs).

The manual path keeps `manual: true` and pushes `TaskScreen` exactly as before. The two paths are
mutually exclusive; setting both is a caller bug.

**Consequences**

- A single `ChapterListScreen` serves both flows; the action loop logic stays in one place.
- The auto flow's "review chapters -> customize" ordering matches v1 (`index.ts:754-770`) without
  the caller having to re-render or coordinate.
- `AutoCustomizeScreen` receives `{ ...replaceParams, chapterLinks: <edited> }` and reads
  `chapterLinks` as the post-review list.

**Evidence**

- `src/adapters/ui-clack/screens/ChapterListScreen.ts:26-50` (`nextScreen`/`replaceParams` docs),
  `:88-108` (the proceed branch).
- `src/adapters/ui-clack/screens/AutoProbeScreen.ts:167-180` (the caller wiring).
- `src/adapters/ui-clack/screens/AutoCustomizeScreen.ts:34-46` (`AutoCustomizeParams`).

---

## Summary of Phase 4 deliverables (delivered)

| Design item | Status | Evidence |
|---|---|---|
| `SiteAdapter` + 2 adapter ports + registry (ADR-P4-A) | delivered | `src/adapters/site-*/`, `src/adapters/site-registry/` |
| `DiscoveryService` extraction (ADR-P4-B) | delivered | `src/core/services/DiscoveryService.ts` |
| `launchOptionsForScrape` + locale (ADR-P4-C, probe-side) | delivered | `src/adapters/ui-clack/scope.ts` |
| `Screen.render(ctx, params?)` threading (ADR-P4-D) | delivered | `src/adapters/ui-clack/ShellContext.ts`, `Shell.ts` |
| `ChapterListScreen` nextScreen/replaceParams (ADR-P4-E) | delivered | `src/adapters/ui-clack/screens/ChapterListScreen.ts` |
| `NewScrapeScreen` + entry-URL + resume-offer | delivered | `src/adapters/ui-clack/screens/NewScrapeScreen.ts` |
| `ManualWizardScreen` + shared group defs | delivered | `screens/ManualWizardScreen.ts`, `wizardGroups.ts` |
| `AutoProbeScreen` + `AutoCustomizeScreen` | delivered | `screens/AutoProbeScreen.ts`, `AutoCustomizeScreen.ts` |
| `TaskScreen` live progress + summary tail | delivered | `src/adapters/ui-clack/screens/TaskScreen.ts` |
| `LiveTaskRegistry` + `flushOnQuit` -> `cancelActive` | delivered | `src/adapters/ui-clack/TaskRegistry.ts`, `app/tui.ts` |
| `resolveCookiesForScrape` (0/1/N picker) | delivered | `src/adapters/ui-clack/scope.ts` |
| `maybeSaveProfile` post-scrape prompt | delivered | `src/adapters/ui-clack/scope.ts` |
| MainScreen "new" + ResumeScreen resume actions unstubbed | delivered | `screens/MainScreen.ts`, `ResumeScreen.ts` |
| `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm lint` green | delivered | see deviation-log D6 for the one updated Phase 3 test |

**Hard constraints upheld by the shipped code:**
- No new code imports `playwright` (only `playwright-core`); v2 site adapters import `PageHandle`
  only. `src/sites/*` (v1 oracle) is byte-untouched.
- v1 code in `src/tui/`, `src/index.ts`, `src/sites/*`, `src/types.ts` stays byte-untouched;
  `pnpm dev` still runs v1.
- `core/` imports nothing from adapters, clack, fs, or chalk/ora - Phase 4 adds zero adapter
  imports to core. `DiscoveryService` lives in `core/services/` and depends only on ports + domain.
- Every browser-side script is a plain string constant - the `page.evaluate()` string-constant rule
  (AGENTS.md) is enforced by construction via `PageHandle`'s named methods.
- Session files are deleted only after the EPUB build succeeds - `ScrapeService.run` owns this;
  the TUI TaskScreen is a thin renderer over it.
- All persistent user data lives under XDG-standard dirs - Phase 4 adds no new stores; the same
  `resolveDataDir()`-based stores the CLI uses are wired in `app/tui.ts`.
- Enquirer stays pinned and untouched; Phase 6 deletes it.
