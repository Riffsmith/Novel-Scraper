# Phase 4 - Deviation Log (post-implementation)

Chronological record of every place the shipped code diverges from `docs/phase-4/readme.md` (the
design doc) or from v1 behavior, with a justification. Matches the format of the phase-1/2/3 logs.

The design doc was treated as the authoritative spec; deviations are called out here, not silently
decided. Where the deviation has a real architectural trade-off, it links to `adr.md`.

---

## D1 - `LiveTaskRegistryControls.get()` returns `ScrapeTask | null`, not `ScrapeTask`

**Spec:** readme §2.2 sketches the interface with `get(): ScrapeTask` (never null).

**Shipped:** `get(): ScrapeTask | null`. The impl always returned nullable (a registry with no
active task has nothing to return); the interface declaration was the over-eager one.

**Reason:** the design sketch predated the impl and asserted "never null" optimistically. Treating
an idle registry as `ScrapeTask | null` is the honest type. The shell's header strip already handles
null (`taskHeader(null)` renders an idle strip). The widened type is in `TaskRegistry.ts:33` and the
impl at `:67`; the `LiveTaskRegistryControls` no longer re-declares `get()` (it inherits the
nullable one from `TaskRegistryEvents`).

**ADR:** none - this is a refinement of the readme §2.2 sketch, not a trade-off.

---

## D2 - `Screen.render(ctx, params?)` threads params via the render signature (ADR-P4-D)

**Spec:** readme §2.4 / §2.7 imply screens constructed with caller-supplied params (`TaskScreen,
ManualWizardScreen, AutoCustomizeScreen` etc. all show `params` as constructor input in the pseudo-
code). The Phase 3 `Screen.render(ctx)` signature and the eager `buildRegistry()` pattern don't
support that.

**Shipped:** `Screen.render(ctx, params?: unknown)`; the Shell passes `frame.params` through. The
Phase 4 parametrized screens dropped their constructor params and read `params as <Params>` at the
top of `render()`. See ADR-P4-D for the full rationale.

**Reason:** keeping the constructor-params pattern would have required a screen-factory map or
runtime registry mutation from parents, both heavier than threading the already-stored
`StackFrame.params` into `render`. The chosen approach keeps one uniform instantiation pattern and
makes tests strictly simpler (`new ManualWizardScreen().render(ctx, params)`).

**ADR:** ADR-P4-D (this file).

---

## D3 - `ChapterListScreen` carries `nextScreen` + `replaceParams` instead of returning the edited list

**Spec:** readme §2.6 specifies `ChapterListScreen` returns `{ action: "proceed" | "back"; urls: string[] }`
to the caller. The Phase 3 `ScreenResult` type only allows push/pop/replace/quit; a `pop` with extra
params is not in the union.

**Shipped:** `ChapterListParams` gained two optional fields - `nextScreen?: string` and
`replaceParams?: Record<string, unknown>`. On "proceed", the manual path pushes `TaskScreen` as
before; the auto path `replace`s `nextScreen` with `{ ...replaceParams, chapterLinks: <edited> }`.
See ADR-P4-E for the full rationale.

**Reason:** the design's "return the edited list to the caller" doesn't fit the shell's
`pop`-discards-params contract. Threading via `nextScreen` keeps a single `ChapterListScreen`
serving both flows, with v1 ordering (`index.ts:754-770`: review chapters -> customize) preserved.

**ADR:** ADR-P4-E (this file).

---

## D4 - `AutoProbeScreen` constructs an in-screen probe browser; `ScrapeService` launches its own

**Spec:** readme §2.5 says the probe uses `browser port's launch/createContext/newPage` and closes
the probe context when done. The TaskScreen hands the scrape to `ScrapeService.run`.

**Shipped:** ADR-P4-A's probe instantiation matches v1 `index.ts:666-703` exactly - the probe
screen owns the ephemeral browser + context + page, closes them before returning. TaskScreen
launches a separate `ScrapeService` instance (constructed locally in `TaskScreen.render`) which
then does its own `browser.launch` via `ScrapeService.run`. The two browser lifecycles are
distinct, mirroring v1 (the probe's `closeBrowser` is separate from the scrape's `getBrowser`).

**Reason:** `ScrapeService.run` deliberately owns its browser lifecycle (it manages the context pool
+ checkpoints; phase-1 design §1.6). The probe must not reuse the scrape's browser because the
scrape hasn't started yet (the user might still decline the fast-path confirm and walk the customize
wizard). One ephemeral probe browser, then a fresh scrape browser, is the v1-faithful split.

**ADR:** none - matches v1 exactly; logged because it's a non-obvious two-browser lifecycle.

---

## D5 - `maxRetries` threading is deferred; `launchOptionsForScrape` covers the probe only

**Spec:** ADR-P4-C / readme §2.8 says the TUI must honor the user's
`humanize`/`humanPreset`/`fingerprintSeed`/`maxRetries`. ADR-P4-C was approved in the design as
"Yes - additive options so Phase 5 CLI defaults are preserved."

**Shipped:** `launchOptionsForScrape(appCfg, job): BrowserLaunchOpts` is live and used by the probe
(`AutoProbeScreen:81`). It honors humanize/humanPreset/fingerprintSeed/headless/locale.
`ScrapeService.run` **still** hardcodes `maxRetries: 3` and its own launch opts (phase-1 deviation
D10) - the per-job `maxRetries` field has not been threaded into the service constructor or run
signature in this phase.

**Reason:** the full ADR-P4-C scope touches `ScrapeService` constructor + `runJob` + every test
that constructs the service; threading it correctly + updating the test suite is a focused PR on
its own, not a side-effect of the TUI work. The probe (which is the part the user *sees* first and
sits inside the TUI adapter dir) honors the user's stealth settings today; the scrape launch path
keeps the engine defaults for now. A follow-up ports `maxRetries` + the full launch-opts thread
through `ScrapeService.run`'s signature additively, with parity tests.

**ADR:** ADR-P4-C is partially landed (probe), partially deferred (scrape launch + maxRetries).

---

## D6 - One Phase 3 test updated to assert the new Phase 4 behavior

**Spec:** readme §4 / `phase-3/readme.md` §4 say the Phase 3 stub-navigation tests
(`tests/phase-3-tui.test.ts` T11's "Phase 4 stub notice") get **updated** to assert the new
navigation as part of Phase 4.

**Shipped:** the "selecting a session shows the Phase 4 stub notice and pops" test is replaced by
"selecting a session pushes TaskScreen with the resume params" - it asserts `push task` and that
the params carry a `resumeSession` with the right `id` + `chapterUrls`. The `FakeSessionStore` in
the test gained a `setLoad(s: ScrapeSession)` seam so the test can return a real session from
`load(id)`. All other Phase 3 tests stay green.

**Reason:** ADR-P3-E's stub is removed wholesale in Phase 4, exactly as planned - the test update
is the audit trail. The new assertion is stronger (it checks the actual resume handoff, not a
notice string).

**ADR:** ADR-P3-E (the stub removal) + ADR-P4-D (`render(ctx, params)`).

---

## D7 - `JsonSessionStore` is constructed locally in `TaskScreen`, not shared from `ShellContext`

**Spec:** readme §2.7 implies the TaskScreen uses the session store that's already in
`ShellContext.sessions` (the production `JsonSessionStore`).

**Shipped:** `TaskScreen.render` constructs `new JsonSessionStore(ctx.log)` and `new
ArchiverEpubWriter(ctx.log)` and `new ClackUIAdapter(ctx.prompt)` and `new ScrapeService({...})`
locally, instead of pulling a pre-wired service from `ShellContext`.

**Reason:** `ShellContext` carries the four store *ports* (ADR-P3-D), not a pre-built
`ScrapeService`. Constructing the service in-screen keeps the composition root (`app/tui.ts`) free
of a `ScrapeService` instance and lets the TaskScreen own the
`UIAdapter`-wired-to-`LiveTaskRegistry.publishProgress` plumbing (which is screen-local). The
session store is the same on-disk store (the same `JsonSessionStore` class with the same XDG path
resolution), so resume reads + checkpoint writes hit the same files the ResumeScreen and
`runJob` read/write - there is no data-divergence risk. A future refactor could expose a
`ScrapeService` factory on `ShellContext` if a second caller needs the same wiring.

**ADR:** none - a presentation-side composition choice, logged for visibility.

---

## D8 - `AutoCustomizeScreen` reuses `extractionGroup` / `metadataGroup` / `outputPerfGroup` from `wizardGroups.ts`

**Spec:** readme §1.3 / §2.5 call for the auto customize screen to reuse the ~60% shared surface
with the manual wizard (audit P5). The duplication should be "one shared definition, not two
wall-of-code functions."

**Shipped:** `AutoCustomizeScreen` sources its three content groups straight from
`wizardGroups.ts` (`extractionGroup`, `metadataGroup`, `outputPerfGroup`) plus a local
`reviewGroup`. The `Seed` bag carries `adapter` + `auto` (the probe metadata) so the shared
`metadataGroup`'s "edit the auto-fetched synopsis? No keeps it as fetched" branch
(`wizardGroups.ts:259-291`) works unchanged. The manual wizard's Source group (method + URL +
locators) is NOT shared - the auto flow seeds the method as `toc` and the URL from the adapter
(v1 :1124-1125), so it has no Source questions.

**Reason:** exact adherence to the readme §2.5 design. Logged because the shared `Seed.adapter` +
`Seed.auto` fields are the seam that makes the single group definition serve both screens.

**ADR:** none - matches the design.

---

## D9 - WtrLabAdapter default content selector carries a TODO; not yet verified against a live page

**Spec:** readme §3 / T11 call for site-adapter port parity against static HTML fixtures, asserting
`scrapeMetadata` + `scrapeChapterLinks` return the same shape as v1.

**Shipped:** the WtrLabAdapter port (`src/adapters/site-wtr-lab/WtrLabAdapter.ts:153`) carries
`defaultContentSelector: ".chapter-content"` with a `// TODO: verify against a real wtr-lab
chapter page` comment, inherited from v1 (`src/sites/wtrLab.ts:161`). The novelfire adapter's
defaults (`#content`, `.chapter-title`, `separateTitle: true`) are byte-faithful to v1:217-227.

**Reason:** the WTR-Lab content selector was unverified in v1 too (the v1 source carries the same
TODO); the port preserves the uncertainty rather than guessing. The dedicated parity test T11 (a
`tests/phase-4-*` suite against static HTML fixtures per site) is not yet written in this pass -
the implementation work focused on the screen flows + adapter ports. T11 is a focused follow-up:
build a local `node:http` fixture server (phase-1 pattern), serve a wtr-lab + novelfire fixture
page, and assert both v2 adapters' `scrapeMetadata`+`scrapeChapterLinks` return the v1-shape
result. The site-registry + adapter code is in place; the test is the next commit.

**ADR:** none - a known TODO with a clear follow-up, not a behavior deviation.

---

## D10 - `app/tui.ts` eager-registers every screen; no error-screen factory

**Spec:** readme §2.1 lists `app/tui.ts` as the composition root wiring the screens. The Phase 3
`buildRegistry()` pre-registers every screen and an `ErrorScreen` placeholder.

**Shipped:** `buildRegistry()` (in `app/tui.ts`) pre-registers all 13 screens (the 6 Phase 3 root
screens + the 7 Phase 4 screens + the `ErrorScreen` placeholder). The Phase 4 screens read their
params via `render(ctx, params?)` (ADR-P4-D), so pre-registration is now viable for every screen.
The `ErrorScreen` is still pre-seeded with placeholder params (`new ErrorScreen("(no context)", null, [
...])`) - a true error push from a screen would still surface via the shell's `catch` -> log-pop
path (`Shell.ts:92-97`), not through the registry placeholder. That pre-existing Phase 3 behavior
is not touched here.

**Reason:** uniform pre-registration is simpler than a screen-factory map and matches the
Phase 3 pattern. The `ErrorScreen` placeholder wart is a Phase 3 inheritance; cleaning it up is
deferred to Phase 6.

**ADR:** ADR-P4-D (the threading that made this possible).
