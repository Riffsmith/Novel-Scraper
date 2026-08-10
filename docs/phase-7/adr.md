# Phase 7 - Architecture Decision Record

The four ADR-P7-* decisions below were confirmed during the design exploration
that produced `docs/sites/webnovel-port-plan.md` (see that doc's "Confirmed
architectural decisions (ADR-P7 series)" section): they shape every sub-phase of
the port. This file records them post-confirmation so the implementor of each
named phase (`Adapter` / `Epub` / `Pipeline`) has a single ADR file to consult.

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

Companion decision (`collectFootnotes?` on `SiteAdapter`) is captured
as a *future* Pipeline Phase 1 surface addition - the plan explicitly
excluded it from Scaffold Phase 3's signature listing. See
`docs/phase-7/deviation-log.md` D5.

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
