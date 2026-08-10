# Phase 7 - Webnovel Port: Investigation & Design

> **Status: design (carried over).** The full design proposal lives in
> `docs/sites/webnovel-port-plan.md`. This directory ("phase-7/") exists to follow the
> `docs/phase-{1..6}/` shape: `readme.md` (status + pointer), `adr.md` (ADR-P7-* record),
> `deviation-log.md` (entries for any divergence from the design doc).

Roadmap reference: `docs/04-implementation-roadmap.md` (the webnovel port becomes "Phase
7" in the phase series; Phase 6 was the v2 close-out per that roadmap). Governing ADRs:
ADR-001 (`playwright-core` only), ADR-003 (hexagonal), ADR-004 (YAML human / JSON
machine), ADR-006 (CloakBrowser via `ensureBinary()` + `buildLaunchOptions()`). See
`docs/01-architecture-decisions.md` for those.

The webnovel port design is divided into five **named phases**, each with sequential
sub-phases - see `docs/sites/webnovel-port-plan.md` §"Phase naming":

1. `Scaffold` - domain types + port extension, no behaviour.
2. `Adapter` - the `WebnovelAdapter` itself.
3. `Epub` - extend `ArchiverEpubWriter` to render Volume pages.
4. `Pipeline` - wire volumes through `ChapterExtractor` -> `ScrapeService` -> `runJob` -> TUI.
5. `Evidence` - docs + parity tests locking the behaviour in.

This readme is the living status board across the whole Phase 7 effort.

---

## 1. Scaffold - COMPLETED

Acceptance per `docs/sites/webnovel-port-plan.md` §"Acceptance for `Scaffold`":
> `pnpm typecheck`, `pnpm test` green. Existing EPUB output for WTR-Lab/NovelFire
> unchanged (the existing `tests/epub-archiver.test.ts` passes byte-identically).
> `tests/session-store.test.ts` round-trips a v1 session fixture that does not have
> `volumes` and reads it as migration-completed, no data loss.

All four Scaffold sub-phases landed in one batch (5 new files, 8 modified, 1 regenerated):

### Scaffold Phase 1 - `Volume` + `AutoNovelVolume` domain

- `src/core/domain/Volume.ts` (NEW) - `AutoNovelVolume { name; chapterUrls }` + alias
  `type Volume = AutoNovelVolume`. Two intentionally-aliased types so a future
  persisted-only field (`id` / `order` / `createdAt`) can land on `Volume` without
  touching the scraped shape.

### Scaffold Phase 2 - `EpubWriter` port extension

- `src/ports/EpubWriter.ts` - trailing-optional `volumes?: Volume[]` parameter on
  `EpubWriter.write(...)`. Trailing so the existing
  `ArchiverEpubWriter.write(chapters, meta, destDir, filename)` keeps compiling unchanged
  (TypeScript accepts narrower-implementor against wider-port for optional params).
  The implementation in `ArchiverEpubWriter.ts` deliberately **does not use** `volumes`
  yet - that's named phase `Epub`.

### Scaffold Phase 3 - `SiteAdapter` port extension

- `src/core/domain/Footnote.ts` (NEW) - `Footnote { ref; title; content }`.
- `src/core/domain/SiteAdapter.ts` - optional `scrapeVolumes?(...)` and
  `processChapterContent?(...)` methods added; optional `volumes?: AutoNovelVolume[]`
  field added to `AutoScrapeResult`. Both existing adapters (WTR-Lab, NovelFire)
  compile unchanged (optional methods).

Note: the small `collectFootnotes?(page): Promise<Footnote[] | undefined>` surface
mentioned in the plan's Adapter Phase 5 step 8 + Pipeline Phase 1 ("small surface
addition is added during Pipeline Phase 1 once the actual call sequence is clear -
flagged here for awareness, not added to Scaffold Phase 3's signature listing as
written") is left for Pipeline Phase 1, not Scaffold Phase 3. That's per spec.

### Scaffold Phase 4 - `JobConfig` + `ScrapeSession` additive field + migration

- `src/core/domain/JobConfig.ts` - `volumes?: Volume[]` on `JobConfig` only (NOT on
  `ScraperConfig` - the embedded session config stays volume-agnostic; volumes are
  session-level bookkeeping).
- `src/core/domain/Session.ts` - `volumes?: Volume[]` on `ScrapeSession` (top-level,
  not nested under `config`).
- `src/adapters/store-json/migrations/sessions.2to3.ts` (NEW) - chain entry stamping
  `schemaVersion: 3` and adding `volumes` if missing. Pure additive; unknown keys
  round-trip untouched (matches phase-1 D6 invariant).
- `src/adapters/store-json/migrations/sessions.1to2.ts` - chain assembly point now
  concatenates `sessions2to3` into the exported `sessionsMigrations` array.
- `src/adapters/store-json/migrations/index.ts` - re-exports `sessions2to3`.
- `src/adapters/schemas/session.ts` - `SESSION_STORE_SCHEMA_VERSION` bumped 2 -> 3;
  `volumes` added to `sessionDocumentSchema` (`.passthrough()` already preserved
  unknown keys; explicit field gives better error messages).
- `src/adapters/schemas/jobConfig.ts` - `volumes?` added to `jobConfigSchema`.
- `schemas/job.schema.json` (regenerated via `pnpm gen:schema`) - `volumes` array
  emitted into the JSON schema.
- `src/adapters/store-json/JsonSessionStore.ts` - the stale "stamps schemaVersion: 2"
  comment was updated to reference the versioned constant instead of hardcoding "2".

### Tests added in Scaffold

Three new tests in `tests/session-store.test.ts` (per the plan's acceptance bullet):

1. "reads and round-trips a v1 session fixture (no schemaVersion, no volumes)" - copies
   the existing `tests/fixtures/stores/v1/sessions/session-1.json` into the isolated
   XDG tree, loads it, verifies fields + `volumes === undefined`, saves it back, reloads,
   verifies the on-disk file stamped `schemaVersion: 3` and every original field preserved.
2. "reads and round-trips a v2 session fixture (schemaVersion=2, no volumes)" - writes
   a v2-shape doc to disk, loads it via the 1->2->3 chain, saves back, asserts
   `schemaVersion` advanced from 2 to 3 on-disk.
3. "round-trips a Phase 7 session that DOES carry volumes" - saves a session with a
   `volumes: [{ name: "Volume 1", chapterUrls: [...] }]` field, reloads, asserts the
   volumes field round-trips byte-for-byte; on-disk doc stamped `schemaVersion: 3`.

### Acceptance check for Scaffold

- `pnpm typecheck` -> green (zero errors).
- `pnpm test` -> 147 passed, 1 skipped (`acceptance.test.ts` gate), zero failures.
- `pnpm lint` -> unchanged error count (48 problems, 16 errors, 32 warnings - all
  pre-existing in `reference/` oracle; zero new errors from Scaffold.
- `tests/epub-archiver.test.ts` -> passes (no `volumes` param threaded through the
  EPUB writer yet, so EPUB output is byte-identical to today).
- `tests/session-store.test.ts` -> all new tests pass.

---

## 2. Adapter - COMPLETED

The webnovel `SiteAdapter` implementation. Per `docs/sites/webnovel-port-plan.md`
§"Named phase `Adapter`". All five sub-phases landed in one batch (2 new files,
1 modified):

### Adapter Phase 1 - Skeleton, URL match, TOC URL, URL normalization

- `src/adapters/site-webnovel/urlUtils.ts` (NEW) - pure ports of
  `reference/webnovel/urlUtils.mjs`: `getCatalogUrl`, `normalizeChapterUrl`,
  `normalizeWebnovelHost`, `resolveNovelUrl`, `resolveRedirect`. `got` is
  lazy-imported inside `resolveRedirect` so the binary-clean path never pulls
  the HTTP dependency into memory (mirrors `ArchiverEpubWriter.ts:22-29`).
  The reference's `redirect: "follow"` (node-fetch option) becomes a no-op for
  got v14 because got's `followRedirect` option defaults to `true`.
- `src/adapters/site-webnovel/WebnovelAdapter.ts` (NEW) - `makeWebnovelAdapter(log)`
  factory + `webnovelAdapter` singleton (no-op logger fallback), mirroring the
  WTR-Lab / NovelFire pattern.
- `matches(url)` - hostname regex test `^([^.]+\.)*webnovel\.com$/i` (matches
  `webnovel.com`, `www.webnovel.com`, `m.webnovel.com`).
- `getTocUrl(novelUrl)` - `novelUrl + "/catalog"` via `getCatalogUrl`.
- Registered in `src/adapters/site-registry/index.ts` -
  `SITE_ADAPTERS = [wtrLabAdapter, novelFireAdapter, webnovelAdapter]`.
- `id = "webnovel"`, `label = "Webnovel (webnovel.com)"`.

### Adapter Phase 2 - `scrapeMetadata`

Port of `reference/webnovel/contentExtractor.mjs:14-110`. Each field has a
logged fallback:

- Title - `page.textContent(SELECTORS.TITLE, 8_000)` where
  `TITLE = "p:has(a[title=home]) > span:last-child"`. Fallback `"Unknown Title"`.
- Author - `page.textContent("a.c_primary", 8_000)` first; if empty, falls back
  to `page.evaluateScript(AUTHOR_SCRIPT)` reading `address div.ell span`
  (reference `:52-56`). Fallback `"Unknown"`.
- Description - `page.innerHTML("div.g_txt_over", 8_000)` then cheerio strip
  `span._readmore` (the "show full synopsis" toggle label), matching the
  reference's cheerio post-cleaning at `:68-83`.
- Cover - `page.getAttribute("._sd > i:nth-child(1) > img:nth-child(1)", "src")`.
  Protocol-relative URLs (`//img.webnovel.com/...`) get `https:` prefix.

### Adapter Phase 3 - `scrapeChapterLinks`

Returns `string[]` of canonical chapter URLs in correct reading order. The
shared private `walkCatalogVolumes` helper (D2 deviation - single live DOM
traversal per invocation, not two) is the source of truth for Phase 3 and
Phase 4 alike:

- Volume-walk primary: `CATALOG_WALK_SCRIPT` (plain string constant,
  `PageHandle.evaluateScript` ships the source) returns `[{ index, name,
  hrefs }]` per `div.volume-item`. Each href normalized via
  `normalizeChapterUrl`. Locked chapters have an `<svg>` lock icon that the
  `a:not(:has(svg))` selector excludes (matches reference `:170`).
- Alternative-selector fallback (reference `:218-237`) if volume walk finds
  zero links: tries `.volume-item a:not(:has(svg))`, `a.chapter-item`,
  `.chapter-list a`, `.catalog-content a:not(:has(svg))` in order, first
  non-empty wins. Emits a single pseudo-volume `"Additional Chapters"`
  carrying all hrefs in this fallback path.
- De-dupe via insertion-ordered `Set` (AGENTS.md rule).
- Hard cap: `MAX_CHAPTERS = 10_000` (project-wide constant - AGENTS.md "don't
  fork constants").

### Adapter Phase 4 - `scrapeVolumes`

Returns `AutoNovelVolume[]` (one entry per visible volume carrying
`name + chapterUrls`), filtered against the global `allUrls` set so each
volume's `chapterUrls` reference only chapters that actually passed through
de-dupe + cap. This lets the EPUB writer trust the volume map (ADR-P7-C).

- Volume name: `<h4>` text inside each `div.volume-item`.
- Fallback name `"Volume <index + 1>"` if `h4` missing - **NOT** the
  reference's `Volume ${Date.now()}` (D4 deviation: `Date.now()` is non-
  deterministic; the reference's own `epubExtractor.mjs` reordering uses
  `<index>` and v2 adopts that).

### Adapter Phase 5 - `processChapterContent`

Faithful port of `reference/webnovel/contentExtractor.mjs:351-470` + the EPUB-
side re-escape pass in `reference/epubGenerator/contentProcessor.mjs:42-82`.
Runs AFTER the generic `ChapterExtractor` extraction and BEFORE the EPUB
writer's `toXhtml()` post-process (ADR-P4-A ordering):

- cheerio load the raw HTML; remove blacklisted tags (`pirate`, `i`) +
  blacklisted classes (verbatim from `constants.mjs:100-112`); remove
  `.anno-drop` (already-collected footnote popups).
- For each `<p>`, replace `<anno data-annotation-id> sup` with
  `<a href="#footnote-<id>" class="footnote-link" id="footnote-ref-<id>">N</a>`,
  with `N` a per-paragraph counter starting at 1 (reference `:369` -
  restarts at 1 each paragraph, not global).
- Strip `class`/`id`/`style` from each `<p>` (reference `:397-398`).
- Build the footnotes HTML section with `<a class="footnote-back-link">`
  back-links serialised via a local `escXml` (the `he.encode` from the
  reference is substituted because `he`/`html-entities` are not v2
  dependencies, and importing the EPUB writer's `escXml` would invert the
  hexagonal boundary).
- Wrap in `<h2 class="chapter-page-title">` + decorative-line divs (CSS
  classes already present in `templates.ts:671-686`).

D3 deviation (validated): the reference's text-node re-escape pass
(`contentProcessor.mjs:42-82`) is deliberately NOT ported. v2's `toXhtml()`
in `templates.ts:39-50` already escapes bare ampersands and self-closes
void tags; re-applying the reference's escape would double-encode (`&` to
`&` + `amp;`).

Footnote **collection** (live-page click-wait-collect for `<sup>` inside
`<anno data-annotation-id>` per reference `:276-342`) is parked for
Pipeline Phase 1 (D5 deviation: it requires live-page interaction and lives
outside `processChapterContent`). Not added by the Adapter phase.

### Tests added in Adapter

`tests/webnovel-adapter.test.ts` (NEW) - 26 tests covering the pure-function
surfaces of the adapter (urlUtils, matches/getTocUrl, registry registration,
processChapterContent) plus a static-fixture parity test against
`tests/fixtures/sites/webnovel/chapter.html`.

Browser-script paths (`scrapeChapterLinks`' CATALOG_WALK_SCRIPT, the shared
`scrapeVolumes` walk, `scrapeMetadata`'s AUTHOR_SCRIPT) are gated on
real-binary acceptance tests (per AGENTS.md §"Testing": "Real-binary tests
belong in `tests/acceptance.test.ts`") - `FakeBrowserPort.evaluateScript`
intentionally throws (`src/adapters/store-memory/FakeBrowserPort.ts:125-127`).

### Acceptance check for Adapter

- `pnpm typecheck` -> green.
- `pnpm test` -> 181 passed (vs 147 before Adapter + Epub); 1 skipped.
- `pnpm lint` -> unchanged baseline (48 problems, all pre-existing in
  `reference/` oracle; zero new errors from Adapter).

## 3. Epub - COMPLETED

Extends `ArchiverEpubWriter` to render Volume pages. Five sub-phases landed in
one batch (1 modified templates.ts, 1 modified ArchiverEpubWriter.ts):

### Epub Phase 1 - `volumeXhtml` template

`src/adapters/epub-archiver/templates.ts` adds `volumeXhtml(volume, index)`:
one `<OEBPS/volumes/volume-N.xhtml>` page per volume. The CSS `.volume-title`
class already exists at `templates.ts:759-767` (absolutely-centered, "Firlest,
serif"); no stylesheet change needed. The `.volume-page` wrapper is class-only,
no CSS to add.

D1 deviation: the reference emits an extra `<p class="volume-info">Unlocked
Chapters: N</p>` when `unlockedChapterCount < chapterCount` (reference
`contentProcessor.mjs:208-211`). The v2 `Volume` shape (ADR-P7-C: `{ name;
chapterUrls }`) carries no locked/unlocked metadata, so the v2 volume page
omits that line. Adding `unlockedChapterCount?` to `Volume` for data v2
doesn't otherwise use is scope creep (per the plan §"Epub Phase 1").

### Epub Phase 2 - `nav.xhtml` nested `<ol>` volume groups

`templates.ts.navXhtml(meta, chapters, hasCover, volumes = [])`. When
`volumes` is non-empty AND at least one volume has matched chapters, the flat
`<li>` list is replaced with nested `<ol>` volume groups: each volume is an
outer `<li>` wrapping an `<ol>` of its chapters. Unmatched chapters fall
under an "Additional Chapters" group (matches reference `tocBuilder.mjs:57-71`).
When `volumes` is empty/undefined, the flat list is emitted byte-identical to
today (regression-guarded by `tests/epub-archiver.test.ts`).

### Epub Phase 3 - `toc.ncx` nested `<navPoint>` volume groups

`templates.ts.tocNcx(meta, chapters, bookId, hasCover, volumes = [])`. Same
branch logic as `navXhtml`, but emitting nested `<navPoint>`s for the NCX
(matches reference `tocBuilder.mjs:124-176`). PlayOrder is sequential across
volumes and chapters; each volume page's PlayOrder precedes its first
chapter's by 1. "Additional Chapters" pseudo-group included when there are
extra chapters (matches reference `:180-205`).

### Epub Phase 4 - `content.opf` volume manifest + spine ordering

`templates.ts.contentOpf(meta, chapters, hasCover, bookId, volumes = [])`.
Manifest gets one `<item id="volume-N" .../>` per volume-with-chapters
(inserted AFTER chapter items so the chapter section stays grouping-clean).
Spine order: `cover -> synopsis -> nav -> for each volume-with-chapters:
volume-N then its chapters -> extras bucket -> close`. The `<guide>` block's
text reference attribute updates: `chapters/chapter-1.xhtml` (no volumes) or
`volumes/volume-1.xhtml` (volumes, since the first volume page is now the
first body item the reader sees after synopsis, matching the reference's
intuition from `manifestBuilder.mjs`'s guide reference).

### Epub Phase 5 - Volume <-> chapter resolution by URL membership

`templates.ts.resolveVolumeGroups(chapters, volumes)` - the ADR-P7-C helper.
Builds `Map<url, Chapter>`, iterates volumes, and for each
`vol.chapterUrls.includes(ch.url)` pushes the chapter into the group. Defensive:
a chapter present in multiple volumes is placed in its first-seen volume only
(the v2 adapter's `scrapeVolumes` returns disjoint sets, so this branch
shouldn't fire in practice). Unmatched chapters go into the "Additional
Chapters" pseudo-group. The writer is the single index authority; the adapter
is the single DOM-knowledge authority.

The returned `ResolvedVolumes { groups, extra }` is consumed by `contentOpf`,
`navXhtml`, `tocNcx`, AND `ArchiverEpubWriter.write` (see Epub Pipeline-wire
below) so all four stay consistent because they derive from the same shared
resolution.

### Pipeline-wire: `ArchiverEpubWriter.write` accepts + consumes `volumes`

`src/adapters/epub-archiver/ArchiverEpubWriter.ts:write` signature grew a
trailing-optional `volumes?: Volume[]` parameter. It:

- Calls `T.resolveVolumeGroups(chapters, volumes)` once.
- For each volume-with-chapters, appends `T.volumeXhtml(volume, index)` to the
  archive at `OEBPS/volumes/volume-${index + 1}.xhtml` (1-indexed to match the
  spine and nav references).
- Threads `volumes` into the `T.contentOpf`, `T.navXhtml`, `T.tocNcx` calls
  so they all branch consistently (all three default `volumes = []`).
- Logs `volumes: <count>` in the "EPUB built" line so the count is observable.

When `volumes` is `undefined` or empty, the writer path is byte-identical to
today (verified by `tests/epub-archiver.test.ts` "no-volumes output stays
byte-identical" regression test).

### Tests added in Epub

`tests/epub-archiver.test.ts` extended with 8 new tests under a new
"ArchiverEpubWriter - Volume pages (Phase 7)" `describe` block:

1. no-volumes byte-identical regression (lists match between no-arg and
   undefined-arg invocations; no `/volumes/` entries emitted).
2. emits one `OEBPS/volumes/volume-N.xhtml` page per volume-with-chapters
   (3 volumes, 10 chapters fixture).
3. `content.opf` spine orders volume pages before their chapters (position
   monotonicity check across volume + chapter itemrefs).
4. `content.opf` manifest lists all 3 volume items + all 10 chapter items.
5. `nav.xhtml` hosts nested `<ol>` volume groups with chapter `<li>`s inside
   (position assertions: each volume anchor precedes its first chapter, and
   the next volume follows that chapter's siblings).
6. `toc.ncx` hosts nested `<navPoint>` volume groups with chapter navPoints
   inside.
7. volume page body uses `volume.name` (asserts presence of
   `<h1 class="volume-title">Volume 1</h1>`); D1 deviation explicitly asserted
   (no "Unlocked Chapters" line).
8. "Additional Chapters" bucket: a volume set missing one chapter's URL
   asserts that chapter falls into the spine after all volume groups, the
   `nav.xhtml` has the "Additional Chapters" group, and `toc.ncx` has the
   `np-extra` navPoint (matches reference `manifestBuilder.mjs:159-167` /
   `tocBuilder.mjs:180-205`).

### Acceptance check for Epub

- `pnpm typecheck` -> green.
- `pnpm test` -> 181 passed (excluding 1 skipped acceptance gate).
- 8 new EPUB-volume tests + 1 regression baseline test all green.
- Pre-existing `tests/epub-archiver.test.ts` tests remain green (volumes
  defaults to `[]` so no-volume path emits byte-identical output - ADR-P7-A
  guarantee).

## 4. Pipeline - PENDING

Wires volumes through `ChapterExtractor` -> `ScrapeService.run` -> `runJob` -> TUI.
Four sub-phases. This phase adds the `collectFootnotes` SiteAdapter method (per
the plan note - D5 deviation). The `ScrapeService.run` signature gains a
trailing-optional `volumes` argument that's forwarded to `EpubWriter.write`.

## 5. Evidence - PARTIAL (Adapter + Epub sections done; Pipeline pending)

Docs + parity tests locking the behaviour in:

- `docs/02-site-adapters.md` §3 webnovel cookbook entry - landed
  (covers URL match, TOC URL, URL normalisation, metadata selectors, chapter
  list extraction, volume walk -> volume groups, `processChapterContent`
  post-hook, extraction defaults, string-evaluate rule, verification stamp).
- Adapter parity tests - see §2 above; 26 new tests in
  `tests/webnovel-adapter.test.ts`.
- EPUB volume-page parity tests - see §3 above; 8 new tests in
  `tests/epub-archiver.test.ts`.
- Deviation log - D1 (omitted "Unlocked Chapters" line), D2 (shared
  `walkCatalogVolumes` helper), D3 (text-node re-escape drop), D4 (volume
  fallback name `Volume <index>` instead of `Date.now()`), D5
  (`collectFootnotes` deferred to Pipeline Phase 1) all marked as
  IMPLEMENTED in their `deviation-log.md` entries.
- Pipeline Phase 1's deviation-log entry (`collectFootnotes` lands in
  Pipeline Phase 1) stays PENDING until that phase lands.
- Real-binary acceptance test (`tests/acceptance.test.ts` extension gated on
  `CLOAKBROWSER_BINARY_AVAILABLE=1`) - deferred to a follow-up pass: covers
  the live `scrapeMetadata` / `scrapeChapterLinks` / `scrapeVolumes` paths
  that exercise the string scripts through a real browser context. Currently
  those code paths have type+lint coverage but no execution test.


---

## Cross-phase continuity notes

Pre-existing state changes done before Scaffold started (by the user, not the
implementer) that affect the next phase's tests:

- Five v2 UI screens had their `task` / `manual-discovery` hand-off action changed
  from `"push"` to `"replace"`:
  - `src/adapters/ui-clack/screens/ManualWizardScreen.ts`
  - `src/adapters/ui-clack/screens/ChapterListScreen.ts`
  - `src/adapters/ui-clack/screens/AutoCustomizeScreen.ts`
  - `src/adapters/ui-clack/screens/AutoProbeScreen.ts`
  - `src/adapters/ui-clack/screens/ResumeScreen.ts`
  Any new test asserting `result.action === "push"` for those screens is wrong - use
  `"replace"`. The stale `tests/phase-3-tui.test.ts` "selecting a session pushes
  TaskScreen" assertion was updated to `"replace"` as a side effect of Scaffold (that
  test was the blocker for the Scaffold acceptance criterion "`pnpm test` stays green").
  Test name updated to "selecting a session replaces with TaskScreen with the resume
  params" to match.
- TaskScreen's progress rendering was reworked during the prior session: spinner now
  gets `message(...)` events on `chapter.done` / `discovery.progress`, the catch path
  uses `spin.fail(...)` instead of `ctx.prompt.log("error", ...)`. New Pipeline Phase 4
  tests should expect `"message"` entries in `ScriptedPromptProvider.spinnerEvents`.
- `ClackUIAdapter.emit()` no longer calls `prompt.log(...)` for `chapter.done`,
  `discovery.progress`, `checkpoint.saved` (those three became no-ops). Pipeline
  Phase 4 tests asserting on those log lines need to assert on the spinner events /
  `onEvent` callback instead.
- `ScrapeService` now writes a placeholder `Chapter` for permanently-failed chapters
  (helper `makeFailedChapterPlaceholder` at the bottom of `ScrapeService.ts`). Length
  assertions on `result.chapters` for failure-path tests need +1 per permanently
  failed chapter vs the v2.0.0 baseline. EPUB spine will also include those
  placeholders - the Epub-named phase's parity tests need to account for that.

These cross-phase continuity notes are NOT plan deviations - they're pre-existing
behavioural context the Scaffold implementor found while keeping `pnpm test` green.
The continuity-source-of-truth is the user's "Issue 0/1/2" hand-off ("few more
changes in the logic code myself before I asked you to implement the scaffolding
phase"). If a Pipeline-phase test looks stale against the above, fix the test, don't
revert the behavioural change.
