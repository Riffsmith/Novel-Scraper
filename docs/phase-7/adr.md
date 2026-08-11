# Phase 7 - Architecture Decision Record

The ADR-P7-A through ADR-P7-D decisions below were confirmed during the design
exploration that produced `docs/sites/webnovel-port-plan.md` (see that doc's
"Confirmed architectural decisions (ADR-P7 series)" section): they shape
every sub-phase of the port. This file records them post-confirmation so the
implementor of each named phase (`Adapter` / `Epub` / `Pipeline`) has a single
ADR file to consult. ADR-P7-E was added during the Pipeline-named phase to
record the `siteAdapter` injection decision that the plan left open (see
`docs/phase-7/deviation-log.md` D6).

For chronological divergence see `deviation-log.md`. For the top-level project
ADRs (ADR-001 ... ADR-006) see `docs/01-architecture-decisions.md`.

Scaffold Phase 1-4 landed the additive types / port seams that these ADRs call
for: `Volume` / `AutoNovelVolume` in `src/core/domain/Volume.ts`, `Footnote` in
`src/core/domain/Footnote.ts`, the trailing-optional `volumes?: Volume[]` on
`EpubWriter.write`, and `scrapeVolumes?` / `processChapterContent?` on
`SiteAdapter` plus `volumes?: AutoNovelVolume[]` on `AutoScrapeResult`. The
v3 session schema migration (`sessions.2to3.ts`) carries the persisted shape.

---

## ADR-P7-A - `Volume[]` flows through the `EpubWriter` port

**Context**

The webnovel site groups chapters into volumes in its catalog HTML. The v2
EPUB writer must emit one `volume-NN.xhtml` page per volume and place it
before its chapters in spine / NCX / nav. The volume list needs to cross the
hexagonal boundary from the SiteAdapter (DOM-knowledge authority) to the
EpubWriter (XML/EPUB-layout authority).

**Decision**

The `EpubWriter.write` signature gains an optional leading-trailing
`volumes?: Volume[]` parameter (trailing so existing call-sites compile
unchanged). The two existing volume-less adapters (WTR-Lab, NovelFire)
pass `undefined`; their EPUB output is byte-identical to today.

Rejected alternatives:
- Carrying volume info on the `Chapter` domain (`volumeIndex?`):
  forces every `Chapter` consumer - session store, `JsonSessionStore`
  migration chain, etc. - to round-trip a new field. Migration concern per
  `docs/05-migration-guide.md`.
- A per-site EPUB adapter only: divergent per-site output + a separate
  test rig. Post-parity backlog territory.

**Evidence (Scaffold)**

- `src/ports/EpubWriter.ts` declares `volumes?: Volume[]` as the trailing
  optional 5th parameter of `EpubWriter.write`.
- `src/adapters/epub-archiver/ArchiverEpubWriter.ts` (Scaffold: unchanged)
  continues to declare `write(chapters, meta, outputDir, filename)` - the
  narrowed-implementor signature is acceptable against the wider port
  since the new param is optional. The `Epub`-named phase widens this
  signature AND consumes the param.

**Evidence (Adapter + Epub)**

- `src/adapters/epub-archiver/ArchiverEpubWriter.ts:write` now has the
  trailing-optional `volumes?: Volume[]` parameter and actually consumes it
  (calls `T.resolveVolumeGroups`, appends one `volume_NN.xhtml` per volume-
  with-chapters, threads `volumes` through `T.contentOpf` / `T.navXhtml` /
  `T.tocNcx`).
- `tests/epub-archiver.test.ts` "no-volumes output stays byte-identical to
  the pre-Phase-7 baseline" asserts ADR-P7-A's no-behaviour-change claim:
  `volumes: undefined` and `volumes: []` paths produce identical ZIP entry
  listings to the pre-Phase-7 baseline.
- `tests/epub-archiver.test.ts` "emits one OEBPS/volumes/volume-N.xhtml page
  per volume-with-chapters" confirms volume pages appear in the archive
  when volumes ARE passed.

---

## ADR-P7-B - `AutoScrapeResult` and `SiteAdapter` carry optional `volumes`

**Context**

The `SiteAdapter` discovery flow produces (a) a flat ordered `string[]` of
chapter URLs (already flows into `ScrapeService` queue today) AND, for
volume-grouped sites, (b) a `Volume[]` side-channel mapping chapters to
their volume groups. The two should be plumbed through the auto-scrape
result and the SiteAdapter hook contract with one additive-optional seam.

**Decision**

- `AutoScrapeResult` gains `volumes?: AutoNovelVolume[]`.
- `SiteAdapter` gains an optional `scrapeVolumes?(page, novelUrl, opts):
  Promise<AutoNovelVolume[] | undefined>`.
- Existing adapters leave both unset; callers check
  `result.volumes ?? job.volumes ?? undefined`.
- The flat ordered `chapterLinks: string[]` continues to flow into
  `ScrapeService` queue unchanged - the volume map is a side-channel the
  EPUB step reads at build time.

Rejected alternatives listed in `docs/sites/webnovel-port-plan.md` §ADR-P7-B
(breaking `scrapeChapterLinks` return type change / re-walking the catalog
at EPUB time / order-only slicing without per-chapter mapping).

**Evidence (Scaffold)**

- `src/core/domain/SiteAdapter.ts` declares the optional `scrapeVolumes?`
  method on `SiteAdapter` and the optional `volumes?` field on
  `AutoScrapeResult`.
- `src/adapters/site-wtr-lab/WtrLabAdapter.ts` and
  `src/adapters/site-novelfire/NovelFireAdapter.ts` compile unchanged
  (all new methods are optional).

**Evidence (Adapter)**

- `src/adapters/site-webnovel/WebnovelAdapter.ts` implements `scrapeVolumes`
  returning `AutoNovelVolume[]` (or `undefined` when no volumes match). The
  private `walkCatalogVolumes` helper (D2 deviation) produces both the flat
  `allUrls` and the `AutoNovelVolume[]` in a single browser-side pass so the
  adapter page visits the catalog ONCE per invocation.
- Volume names come from the `<h4>` inside each `div.volume-item`; fallback
  name `Volume <index + 1>` (D4 deviation - NOT the reference's
  `Volume ${Date.now()}`).
- Each `AutoNovelVolume.chapterUrls` is filtered against the global `allUrls`
  set so volumes never reference a chapter dropped by de-dupe + cap.

**Evidence (Epub)**

- `src/adapters/epub-archiver/templates.ts` `resolveVolumeGroups`:
  builds `Map<url, Chapter>`, iterates volumes, assigns chapters to volumes
  by `volume.chapterUrls.includes(chapter.url)` membership; unmatched
  chapters fall through to an "Additional Chapters" pseudo-group.
- `tests/epub-archiver.test.ts` "chapters whose URL is not in any volume fall
  into the Additional Chapters bucket" confirms the ADR-P7-C unmatched-path
  behaviour: extra chapters ride the tail of the spine after all volume
  groups (matches reference `manifestBuilder.mjs:159-167`).

**Evidence (Pipeline)**

- `src/core/services/ScrapeService.ts:run` now accepts a trailing-optional
  `volumes?: Volume[]` argument and forwards it (after the resume-path
  resolution `resume?.session?.volumes ?? volumes ?? job.volumes`) to
  `this.deps.epub.write(...)`.
- `src/app/runJob.ts` calls `scrapeService.run(job, cookies, resume, job.volumes)`
  so the YAML / CLI flow's `job.volumes` (set when a job file carries volumes)
  reaches EpubWriter. The TUI auto-probe path sets `job.volumes` via
  `buildQuickAutoConfig` / `assembleAutoJob`.
- `tests/webnovel-pipeline.test.ts` "ScrapeService.run forwards the
  trailing-optional volumes arg to EpubWriter.write" + "...forwards
  undefined to EpubWriter.write when no volumes are provided" + "On resume,
  session.volumes overrides the caller-supplied volumes arg" lock the
  three behaviours (forward, default-undefined, resume-precedence).
- `tests/webnovel-pipeline.test.ts` end-to-end test ("ScrapeService.run
  invoking a real ArchiverEpubWriter with volumes produces a valid EPUB
  archive containing OEBPS/volumes/volume-1.xhtml + volume-2.xhtml pages")
  closes the ADR-P7-A loop: the volume pages emit in a real archive through
  the full Pipeline contract, not just via the writer in isolation.

---

## ADR-P7-C - Volume <-> chapter mapping resolved by URL at EPUB build time

**Context**

The adapter walks the catalog volume-by-volume and emits `name +
chapterUrls` per volume. It does NOT precompute chapter indices. The
EPUB writer must assign each `Chapter` to a volume.

**Decision**

Volume domain shape:

```
interface AutoNovelVolume { name: string; chapterUrls: string[]; }
type Volume = AutoNovelVolume;
```

(separate type names so a future persisted-only field can land on `Volume`
without touching the scraped shape. Scaffold landed them as aliases today.)

`EpubWriter` receives `Chapter[]` (with canonical `url`) plus
`volumes?: Volume[]`, builds `Map<url, Chapter>`, and assigns each
chapter to a volume by `volume.chapterUrls.includes(chapter.url)`.
Unmatched chapters fall through to an "Additional Chapters" group.

The writer is the single index authority; the adapter is the single
DOM-knowledge authority. Clean responsibility split, no double-walking,
no stale index tracking.

Rejected alternatives listed in `docs/sites/webnovel-port-plan.md` §ADR-P7-C.

**Evidence (Scaffold)**

- `src/core/domain/Volume.ts` exposes `AutoNovelVolume` + `Volume =
  AutoNovelVolume`. The "EPUB build time" resolution itself lands in
  the `Epub`-named phase; Scaffold only delivers the type seam.

**Evidence (Epub)**

- `src/adapters/epub-archiver/templates.ts:resolveVolumeGroups` is the
  "writer is the single index authority" implementation: takes
  `Chapter[]` + `AutoNovelVolume[]`, builds `Map<url, Chapter>`, assigns
  chapters to volumes by `volume.chapterUrls.includes(chapter.url)`.
- Defensive: a chapter present in multiple volumes is placed in its first-
  seen volume only (the v2 adapter's `scrapeVolumes` returns disjoint sets,
  so this branch shouldn't fire in practice but is here so the writer trusts
  the volume map - no second-guessing each volume's URL count vs its
  chapter count).
- `tests/epub-archiver.test.ts` content.opf / nav / ncx volume-group tests
  drive the resolution path: 3 volumes + 10 chapters fixture matches the
  expected spine interleaving (vol1, ch1-3, vol2, ch4-6, vol3, ch7-10).

---

## ADR-P7-D - Faithful per-chapter processing in a `SiteAdapter` hook

**Context**

The reference `contentExtractor.processChapterContent` +
`epubGenerator/contentProcessor.processChapter` do webnovel-specific
cleaning: blacklisted tag/class removal, footnote rewriting,
decorative header/ending lines, per-paragraph footnote counters. The
v2 architecture needs a per-adapter hook that runs AFTER the generic
`ChapterExtractor` extraction (challenge wait-out, content-selector pull,
exclude-selector strip) and BEFORE the EPUB writer's `toXhtml()`
post-process - so the cleaning applies only to webnovel chapters without
forcing those DOM idioms (`<anno>`, `pirate`, `.para-comment`) on
WTR-Lab / NovelFire.

**Decision**

A new optional `SiteAdapter.processChapterContent?(input): {
  htmlContent, footnotes?
}` post-hook lets the webnovel adapter reproduce the reference cleaning
byte-faithful. Other adapters leave it unset; the generic
`sanitize-html` allow-list keeps running as today.

The hook's returned `htmlContent` BYPASSES `sanitize-html` (the webnovel
adapter applies its own allow-list via the reference's blacklist). The
hook runs AFTER the generic extraction (challenge wait-out, content-
selector pull, exclude-selector strip) and BEFORE the EPUB writer's
`toXhtml()` post-process - preserving the same code-ordering the
reference uses. Footnotes on the return value are appended to the
chapter's `htmlContent` by the hook itself (the hook is responsible
for emitting the `<div class="footnotes-section">` block); the
`Chapter` domain shape is unchanged.

Rejected alternative listed in `docs/sites/webnovel-port-plan.md` §ADR-P7-D:
genericising into the shared `ChapterExtractor` (DOM idioms are
webnovel-only; forcing them on WTR-Lab/NovelFire is the cross-site
coupling AGENTS.md §"Testing" warns against), and a per-site hook in
the adapter without extending the port (would invert the dependency so
the EPUB writer has to know which adapter produced each chapter, which
it does not and should not).

Companion decision (`collectFootnotes?` on `SiteAdapter`) - landed in
Pipeline Phase 1 (the plan explicitly excluded it from Scaffold Phase 3's
signature listing). See `docs/phase-7/deviation-log.md` D5 (now IMPLEMENTED)
and the Pipeline Evidence section below.

**Evidence (Scaffold)**

- `src/core/domain/Footnote.ts` declares `Footnote { ref; title; content }`.
- `src/core/domain/SiteAdapter.ts` declares the optional
  `processChapterContent?(...)` method.

**Evidence (Adapter)**

- `src/adapters/site-webnovel/WebnovelAdapter.ts:processChapterContent`
  implements the post-hook: cheerio-based blacklisted tag/class strip
  (`script,style,iframe,.ad-wrapper,.pirate,.para-comment,.anno-tip`),
  per-paragraph footnote counter (rewrites `<sup>` inside
  `<anno data-annotation-id>` to `<sup class="footnote-ref"><a
  href="#fn-N">N</a></sup>`), decorative-line wrap (a `<p>` whose
  text matches the chapter-title regex gets wrapped in
  `<div class="chapter-opening">` / `<div class="chapter-ending">`),
  and the trailing `<div class="footnotes-section">` block with
  back-links (`<a href="#fnref-N">`).
- The hook's returned `htmlContent` BYPASSES `sanitize-html` per the
  decision text - the webnovel adapter applies its own allow-list.
  Pipeline Phase 1 will wire the call sequence: extract chapter HTML
  via `ChapterExtractor`, then call `adapter.processChapterContent?`
  if present, then hand off to `EpubWriter`. Until then the hook
  itself is unit-tested in `tests/webnovel-adapter.test.ts` with the
  fixture `tests/fixtures/sites/webnovel/chapter.html` (8 tests
  covering: blacklisted strip, footnote counter, decorative lines,
  XML escaping, fixture parity).
- Local `escXml` (string concatenation `"&" + "amp;"` to avoid
  HTML-entity decoding corruption by the edit tool) is defined
  inline; `he`/`html-entities` are NOT project dependencies (checked
  via `package.json`).
- D3 deviation (no text-node re-escape pass) is documented in
  `docs/phase-7/deviation-log.md` D3: the v2 EPUB writer's
  `templates.ts:toXhtml()` already escapes bare ampersands, so
  re-applying the reference's text-node escape would double-encode.

**Evidence (Pipeline)**

- `src/core/domain/SiteAdapter.ts` now declares the optional
  `collectFootnotes?(page): Promise<Footnote[] | undefined>` method that
  the plan's "future Pipeline Phase 1 surface addition" called for. This
  closes the D5 deviation (`docs/phase-7/deviation-log.md` D5 -> IMPLEMENTED).
- `src/adapters/site-webnovel/WebnovelAdapter.ts:collectFootnotes` implements
  the live-page click-wait-collect loop via a single module-scope
  `FOOTNOTE_COLLECT_SCRIPT` string constant (async-IIFE) - per AGENTS.md
  "page.evaluate() string-constant rule" the script avoids named inner
  closures so keepNames' `__name` helper cannot break it at runtime.
  Fail-soft: an exception inside the browser-side script is swallowed by
  the adapter and ChapterExtractor proceeds with `footnotes ?? undefined`.
- `src/core/services/ChapterExtractor.ts:extract` wires the post-hook
  sequence: after the generic extraction path, when
  `siteAdapter?.processChapterContent` is set, it (1) calls
  `collectFootnotes?` on the live page if both adapter hooks are present
  (defensive try-catch warns on a throw), then (2) calls
  `processChapterContent({ rawHtml, title, footnotes })` and uses its
  returned `htmlContent` as `clean`, BYPASSING `sanitize-html` (the hook's
  own allow-list/blacklist already ran). When no adapter is wired, the
  existing `sanitize-html` path runs byte-identical to today.
- `tests/webnovel-pipeline.test.ts` locks the contract: "ChapterExtractor
  runs adapter.processChapterContent after generic extraction and the hook
  output BYPASSES sanitize-html" (1), "...falls through to sanitize-html
  when adapter leaves processChapterContent unset" (2), "...invokes
  collectFootnotes before processChapterContent when adapter provides both"
  (3), "...collectFootnotes fail-soft path" (4), "...deps.siteAdapter
  propagates to ChapterExtractor" (8).

---

## ADR-P7-E - `siteAdapter` injected as `ScrapeService.deps` constructor arg (Pipeline Phase 1 / 2)

**Context**

Pipeline Phase 1 needs `ChapterExtractor` to invoke the adapter's optional
`processChapterContent` / `collectFootnotes` hooks, which means `ChapterExtractor`
needs a reference to the resolved `SiteAdapter`. The plan
(`docs/sites/webnovel-port-plan.md` §"Named phase `Pipeline`" Phase 1) says
only that `ChapterExtractor` "constructor gains a private optional
`siteAdapter?: SiteAdapter` field (set by `ScrapeService`)" - it leaves the
injection seam between `JobConfig`, `ScrapeService.run(...)` arg, and
`ScrapeService.deps` constructor field open.

**Decision**

The `SiteAdapter` reference is injected as a `ScrapeService.deps` constructor
FIELD (named `siteAdapter?: Pick<SiteAdapter, "processChapterContent" |
"collectFootnotes">`), NOT carried as a `JobConfig` field, NOT threaded
through `ScrapeService.run(...)` as a runtime arg.

The adapter is lifecycle-scoped to the composition root (`runJob.ts` /
`TaskScreen.ts`) - resolved once against the entry URL - not data-scoped to
a job. The existing `ScrapeService.deps` shape (`{ browser, sessions, epub,
ui, log }`) is the hexagonal-injection seam the v2 composition root already
wires; adding `siteAdapter` there is the same pattern, with one consistent
binding per composition-root invocation. `JobConfig` is the on-disk persisted
YAML job shape (per ADR-004); attaching a `SiteAdapter` there would force
every consumer (session store, migration chain, YamlJobLoader) to round-trip
an unhelpful reference the YAML can't serialize. Per AGENTS.md "Schema
additions are additive-optional only" + the JobConfig-persisted shape being
YAML, attaching a SiteAdapter there is wrong-shaped.

The `Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">`
narrowing (vs the full `SiteAdapter`) keeps `ChapterExtractor` +
`ScrapeService` test doubles honest - they only see the two hooks the
extractor actually calls, not the full adapter surface. This matches the
narrowest-port principle AGENTS.md §"Architecture - v2 layout rules" calls
out as "ports define an adapter protocol" (an interface should expose only
what its consumers need).

Rejected alternatives:

- **`JobConfig.siteAdapter?` field:** the adapter is a runtime-resolved
  binding, not job data. Forcing the session store + migration chain to
  round-trip it is wrong-shaped (and the YAML representation would be
  tautological - "adapter name" duplicates the URL match already used to
  resolve the adapter).
- **`ScrapeService.run(..., siteAdapter?)` runtime arg:** the adapter's
  lifecycle matches `ScrapeService`'s, not the per-call invocation's.
  Threading it through `run()` would force every caller to repeat the
  resolution even when the adapter is already bound at composition time.
- **Full `SiteAdapter` type in `deps.siteAdapter`:** over-broad. The
  `Pick<...>` narrowing signals the only hooks the extractor calls and
  keeps test doubles minimal (no need to stub `scrapeMetadata` /
  `scrapeChapterLinks` / `scrapeVolumes` / `default*` selectors when the
  extractor only invokes two methods).

**Consequence**

A future caller of `ScrapeService.run` that wants the adapter hook path
must wire `siteAdapter` into the constructor deps. `src/app/runJob.ts`
(the CLI / YAML flow) does NOT currently pass a `siteAdapter` - the YAML
job files don't list adapter names and the CLI flow doesn't resolve one
against the entry URL today. Adapter-resolution for the CLI flow is
deferred to a future job-config schema bump (out of scope per the plan
§"Open items requiring follow-up"); webnovel volumes flow via the TUI
auto-probe path (AutoProbeScreen -> AutoCustomizeScreen -> TaskScreen)
which already wires `siteAdapter: adapter` into the constructor deps.

The no-adapter path remains byte-identical to today's behaviour
(ADR-P7-A no-behaviour-change guarantee): `ChapterExtractor` with no
`siteAdapter` runs `sanitize-html` as before; `EpubWriter.write` with no
`volumes` emits the flat list as before.

**Evidence (Pipeline)**

- `src/core/services/ScrapeService.ts` `deps` constructor declares the
  optional `siteAdapter?: Pick<SiteAdapter, "processChapterContent" |
  "collectFootnotes">` field and forwards it into `new ChapterExtractor(
  this.deps.log, this.deps.siteAdapter)`.
- `src/core/services/ChapterExtractor.ts` constructor accepts the same
  narrowed `Pick<...>` arg so the extractor only sees its two hooks.
- `src/adapters/ui-clack/screens/TaskScreen.ts` wires the screen param's
  optional `siteAdapter?` into the `new ScrapeService({...})` deps object
  (the TUI auto-probe flow is the sole composition root wiring this today).
- `src/app/runJob.ts` deliberately does NOT wire a `siteAdapter` (CLI /
  YAML flows don't resolve one); the no-volumes EPUB path remains the
  default for those flows. Future job-config schema bumps can extend.
- `tests/webnovel-pipeline.test.ts` "ScrapeService deps.siteAdapter
  propagates to ChapterExtractor so the adapter post-hook runs" drives
  the constructor-deps wiring through a real adapter instance end-to-end.
- `docs/phase-7/deviation-log.md` D6 records this decision as a deviation
  from the plan's implied-but-unspecified injection seam.
