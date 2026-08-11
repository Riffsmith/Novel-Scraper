# Phase 7 - Deviation Log

Reference design: `docs/sites/webnovel-port-plan.md` (the webnovel port implementation
plan). This file lists every place the implementation diverged from that design, with
the reason and the consequence. Anything not listed here was implemented as specified.

For chronological divergence in named phases other than `Scaffold`, the next
implementor adds entries as they arise. D1-D5 below were seeded from the plan
itself - the Adapter + Epub + Pipeline phases flipped D1-D5 from "planned" to
"implemented" (file/line evidence added).

---

## D-P7-S1 - Scaffold-fixed stale `push` assertion in `tests/phase-3-tui.test.ts`

**Spec:** The webnovel-port-plan's `Scaffold` Acceptance criterion says "`pnpm test`
stays green". The plan assumed the test suite was green on the working tree.

**Deviation:** Before Scaffold started, the user had changed five v2 UI screens
(`ManualWizardScreen`, `ChapterListScreen`, `AutoCustomizeScreen`, `AutoProbeScreen`,
`ResumeScreen`) to use `action: "replace"` instead of `action: "push"` when handing
off to the `task` screen. The `tests/phase-3-tui.test.ts` "selecting a session pushes
TaskScreen" test still asserted `result.action === "push"`, so `pnpm test` was red
on the working tree BEFORE any Scaffold work ran.

**Reason:** Pre-existing cross-phase inconsistency: behavioural change already
applied to the source, the test not updated. Scaffold's Acceptance gate forced
the fix.

**Consequence (one-line code change):**
- `tests/phase-3-tui.test.ts` line 490: `expect(result.action).toBe("push")` ->
  `expect(result.action).toBe("replace")` (and the `toMatchObject` line + test
  name updated to match).

**Why this lives in Scaffold's deviation log, not the phase-3 log:** The fix was
FORCED by the Scaffold acceptance criterion (`pnpm test` stays green), so the
Scaffold implementor made it. It's recorded here so:
1. A code reviewer of the Scaffold diff doesn't wonder why a phase-3 test was edited
   in what's otherwise a type-only phase.
2. The next-phase implementor looking at per-phase diffs knows the fix was
   intentional, not a stray artefact.

The behavioural change itself (the five `push` -> `replace` rewrites in the v2 UI
screens) is a separate, prior change owned by the user - NOT part of Phase 7.
See `docs/phase-7/readme.md` §"Cross-phase continuity notes" for the full list of
prior-session behavioural changes that affect downstream tests.

---

## D1 - Volume page omits "Unlocked Chapters: N" line (IMPLEMENTED)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Epub`" Phase 1.

**Deviation:** The v2 `Volume` shape (ADR-P7-C: `{ name, chapterUrls }`)
carries no `unlockedChapterCount` / `chapterCount` field. The volume page
template deliberately omits the "Unlocked Chapters: N" line the reference
emits (see `reference/epubGenerator/contentProcessor.mjs:208-211`).

**Reason:** Adding `unlockedChapterCount?` + `chapterCount?` to `Volume` is
scope creep for data v2 doesn't otherwise use. ADR-P7-C deliberately kept
`Volume` to `name + chapterUrls`.

**Consequence:** EPUB output diverges from the reference's `volume-NN.xhtml`
page (one less `<p class="volume-info">` line in the body). The
`tests/epub-archiver.test.ts` "volume page body uses the volume.name" test
explicitly asserts the line is absent, locking the divergence in.

**Evidence:**
- `src/adapters/epub-archiver/templates.ts` `volumeXhtml` function (~line 382):
  emits only `<div class="volume-page"><h1 class="volume-title">${name}</h1></div>`,
  no `<p class="volume-info">`.
- `tests/epub-archiver.test.ts` "volume page body uses the volume.name from the
  input volume": asserts `expect(vol1).not.toContain("Unlocked Chapters")`.


---

## D2 - `scrapeVolumes` and `scrapeChapterLinks` share a single `walkCatalogVolumes` private helper (IMPLEMENTED)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Adapter`" Phase 3
(Compatibility note) + §"Adapter Phase 4".

**Deviation:** The adapter's private `walkCatalogVolumes(page, novelUrl, pageUrl, log):
Promise<{ volumes, allUrls }>` produces both the flat ordered `string[]` of
chapter URLs (returned by `scrapeChapterLinks` as `allUrls`) AND the
`AutoNovelVolume[]` (returned by `scrapeVolumes`). The adapter Page visits the
catalog ONCE per `AutoProbeScreen` / `runJob` invocation, not twice.

**Reason:** Per the plan's Compatibility note - the two-phase split keeps each
commit small but the live DOM traversal happens once at runtime by sharing
the catalog-walk function between `scrapeChapterLinks` and `scrapeVolumes`.

**Consequence:** Tests for `scrapeChapterLinks` and `scrapeVolumes` may share
a fixture (the same catalog HTML exercises both methods). No external
behaviour change - both methods return the expected types per the spec.

**Evidence:**
- `src/adapters/site-webnovel/WebnovelAdapter.ts` `walkCatalogVolumes` function:
  produces both `volumes` and `allUrls`; `scrapeChapterLinks` returns
  `.allUrls`, `scrapeVolumes` returns `.volumes`.
- `CATALOG_WALK_SCRIPT` is a single string script returning both the volume
  names and per-volume href arrays in one browser-side pass.


---

## D3 - `processChapterContent` doesn't re-escape text nodes (IMPLEMENTED)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Adapter`" Phase 5
step 7.

**Deviation:** The reference's `contentProcessor.mjs:42-82` re-escape pass over
text nodes is NOT ported into the v2 webnovel adapter's
`processChapterContent`. The v2 EPUB writer's `templates.ts:39-50` `toXhtml()`
already escapes bare ampersands and self-closes void tags. Re-applying the
reference's text-node escape would double-encode `&` to `&` + `amp;`.

**Reason:** Defensible substitution - the v2 EPUB writer's existing escape
pass already covers what the reference is solving; re-applying it would
produce visibly broken output (`&` + `amp;`).

**Consequence:** The webnovel adapter's `processChapterContent` output differs
from the reference contentExtractor's output by entity-replacement in text
nodes. The byte-parity test in Evidence Phase 3 would need to assert on
exactly this difference; in practice the existing EPUB regression tests pass
because the EPUB writer's `chapterXhtml` template wraps the chapter body via
`toXhtml()` (so the re-escape happens at EPUB-build time, not adapter time).

**Evidence:**
- `src/adapters/site-webnovel/WebnovelAdapter.ts` `processChapterContent`:
  cheerio-based transformations only; no explicit text-node entity re-escape
  on output.
- `src/adapters/epub-archiver/templates.ts` `chapterXhtml` calls
  `toXhtml(ch.htmlContent)` which escapes bare ampersands (`templates.ts:39-50`).
- Test "escapes the chapter title (prevents XML injection)" in
  `tests/webnovel-adapter.test.ts` confirms the title's XML-escape is
  preserved (the adapter emits `escXml`-encoded text in the
  `chapter-page-title` h2; no double-encoding observed through the full
  adapter -> EPUB writer pipeline).



---

## D4 - Volume fallback name uses `Volume <index>` instead of `Volume <Date.now()>` (IMPLEMENTED)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Adapter`" Phase 4.

**Deviation:** When a `div.volume-item` has no `h4` child, the v2 adapter uses
`Volume ${index + 1}` as the fallback volume name. The reference uses
`Volume ${Date.now()}` (reference `:165`), which is a v1 bug (the name changes
every run for the same volume).

**Reason:** `Date.now()` as a volume name is non-deterministic and breaks
parity testing. The reference's own `epubExtractor.mjs` falls back to
`Volume <index>` when reordering, which is the v2-correct behaviour.

**Consequence:** Volume names for the fallback case are deterministic and
stable across runs. The `tests/webnovel-adapter.test.ts` parity test in
Evidence Phase 2 can rely on this.

**Evidence:**
- `src/adapters/site-webnovel/WebnovelAdapter.ts` `walkCatalogVolumes`:
  `const name = r.name || \`Volume ${r.index + 1}\`;`
- `CATALOG_WALK_SCRIPT` itself emits `'Volume ' + (index + 1)` as the
  browser-side fallback when `h4` is absent (so the v2 adapter and the
  browser-side script agree on the same canonical fallback name even on
  the volume-name-miss path, which is a stronger guarantee than the
  reference gives).


---

## D5 - `collectFootnotes` separated from `processChapterContent` because it needs live-page interaction (IMPLEMENTED via Pipeline Phase 1)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Adapter`" Phase 5
step 8 ("the footnote collection happens in a separate adapter method
`collectFootnotes(page)` that runs at chapter-extraction time").

**Deviation (planned, landed in Pipeline Phase 1):** `SiteAdapter` gained
an OPTIONAL third method, `collectFootnotes?(page): Promise<Footnote[] | undefined>`,
that lives alongside `scrapeVolumes` and `processChapterContent`. The footnote
*collection* (clicking `<sup>` inside `<anno data-annotation-id>` to trigger
the `.anno-drop` popup and collect `.anno-drop-hd` / `.anno-drop-bd`) requires
live-page interaction and cannot happen inside `processChapterContent` (which
is a pure post-hook taking already-extracted HTML). So collection lives in a
separate adapter method running at chapter-extraction time (Pipeline Phase 1
calls it from `ChapterExtractor`).

**Reason:** The reference's `_extractFootnotes`
(`reference/webnovel/contentExtractor.mjs:276-342`) is a click-wait-collect
browser-side loop. The v2 architecture's `PageHandle` deliberately exposes no
generic `evaluate(fn)` - only `evaluateScript(string)`. A single-string
async-IIFE doing the click-wait-collect loop browser-side IS the legitimate
path per the plan §"Cross-cutting instructions / String-evaluate rule", but
it requires the LIVE page, not the post-extracted HTML that
`processChapterContent` receives.

**Consequence:** `SiteAdapter` has THREE optional methods now, not two
(scrapeVolumes, processChapterContent, collectFootnotes). The Scaffold
Phase 3 listing in the plan called out this small surface addition
explicitly: "this small surface addition is added during Pipeline Phase 1 ...
flagged here for awareness, not added to Scaffold Phase 3's signature listing
as written." The Adapter Phase 5 implementor did NOT add it - Pipeline Phase
1 did, per spec.

**Implementation (Pipeline Phase 1):**
- `src/core/domain/SiteAdapter.ts`: optional `collectFootnotes?(page):
  Promise<Footnote[] | undefined>` method added to `SiteAdapter` (the plan
  explicitly reserved this slot; Scaffold Phase 3 left it absent).
- `src/adapters/site-webnovel/WebnovelAdapter.ts`: `collectFootnotes(page)`
  implemented. It runs the `FOOTNOTE_COLLECT_SCRIPT` string async-IIFE
  browser-side (the script iterates `anno[data-annotation-id]`, clicks
  each `<sup>`, waits 500ms for `.anno-drop` to appear, reads
  `.anno-drop-hd` + `.anno-drop-bd`, closes the popup by clicking the
  parent `<p>`, returns `Footnote[]`-shaped JSON). The adapter's
  `collectFootnotes` swallows evaluateScript throws and returns
  `undefined` (D5 fail-soft - the chapter extraction proceeds without
  footnotes; ChapterExtractor's outer try-catch warn is defensive).
- `src/core/services/ChapterExtractor.ts`: constructor gains an optional
  `siteAdapter?: Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">`
  arg (set by `ScrapeService` from its own `deps.siteAdapter`). Inside
  `extract()`, after the generic extraction (challenge wait-out + content-
  selector pull + exclude-selector strip + cheerio post-process + page
  `<title>` fallback) AND before the sanitize-vs-adapter branch:
  - if `collectFootnotes` is set, call it on the live page; the returned
    `Footnote[]` is fed into `processChapterContent`'s `footnotes` input.
  - if `processChapterContent` is set, call it with `{ rawHtml: root.html(),
    title, footnotes }` and use its returned `htmlContent` as `clean`,
    BYPASSING `sanitizeHtml` (the adapter supplies its own allow-list via
    the reference's blacklist).
  - if neither is set, the existing `sanitizeHtml` allow-list path runs.
- `src/core/services/ScrapeService.ts`: `deps.siteAdapter` (optional)
  propagates to the `new ChapterExtractor(log, siteAdapter)` constructor
  call inside `run()`.
- `src/adapters/ui-clack/screens/TaskScreen.ts`: `TaskScreenParams` gains
  an optional `siteAdapter?` so the auto flow passes the resolved adapter
  through (AutoProbeScreen -> AutoCustomizeScreen / fast path -> TaskScreen
  carry it as a screen param).

**Evidence:**
- `src/core/domain/SiteAdapter.ts`:73-117 declares `collectFootnotes?` +
  the `processChapterContent?` post-hook on `SiteAdapter`.
- `src/adapters/site-webnovel/WebnovelAdapter.ts` `FOOTNOTE_COLLECT_SCRIPT`
  + `collectFootnotes` function carry the live-page click-wait-collect
  loop browser-side.
- `src/core/services/ChapterExtractor.ts` `extract()` branches on
  `this.siteAdapter?.processChapterContent` (precondition) and calls
  `collectFootnotes` first when present.
- `tests/webnovel-pipeline.test.ts` "invokes collectFootnotes before
  processChapterContent when adapter provides both (D5 deviation)" -
  RecordingPage records the evaluateScript call sequence and asserts the
  footnote section is emitted into the chapter htmlContent.
- `tests/webnovel-pipeline.test.ts` "proceeds without footnotes when
  collectFootnotes returns empty (fail-soft)" guards the silent
  footnoteless path.
- `tests/webnovel-pipeline.test.ts` "ScrapeService deps.siteAdapter
  propagates to ChapterExtractor so the adapter post-hook runs" proves
  the end-to-end wiring without a real browser.


---

## D6 - `siteAdapter` injected as a `ScrapeService.deps` constructor arg, not via `JobConfig` (IMPLEMENTED via Pipeline Phase 1 / 2)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Pipeline`" Phase 1:
"ChapterExtractor constructor gains a private optional `siteAdapter?: SiteAdapter`
field (set by `ScrapeService`)." The plan leaves the injection seam open -
`JobConfig` and `run(...)` are both candidates.

**Deviation:** The SiteAdapter reference is injected as a `ScrapeService.deps`
constructor FIELD (named `siteAdapter?: Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">`),
NOT carried as a `JobConfig` field, NOT threaded through `ScrapeService.run(...)` as a runtime arg.

**Reason:** The adapter is lifecycle-scoped to the composition root
(`runJob.ts`/`TaskScreen.ts`), not data-scoped to a job. The existing
`ScrapeService.deps` shape (`{ browser, sessions, epub, ui, log }`) is the
hexagonal-injection seam the v2 composition root already wires; adding
`siteAdapter` there is the same pattern, with one consistent binding per
composition-root invocation. JobConfig is the on-disk / persisted YAML job
shape (per ADR-004: human-edited YAML for job files); the SiteAdapter is a
runtime resolved at the composition root against the entry URL - threading it
through JobConfig would force every consumer (session store, migration chain)
to round-trip an unhelpful adapter reference. Per AGENTS.md "Schema additions
are additive-optional only" + the JobConfig-persisted shape being YAML,
attaching a SiteAdapter there is wrong-shaped.

The `Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">`
narrowing (vs the full `SiteAdapter`) keeps the ChapterExtractor +
ScrapeService test doubles honest - they only see the two hooks the
extractor actually calls, not the full adapter surface (matches the
narrowest-port principle AGENTS.md §"Architecture - v2 layout rules" calls
out as "ports define an adapter protocol").

**Consequence:** A future caller of `ScrapeService.run` that wants the
adapter hook path must wire `siteAdapter` into the constructor dep set.
`runJob.ts` (the CLI / YAML flow) does NOT currently wire one - the YAML
job files don't list adapter names. Adapter-resolution for the CLI flow is
deferred to a future job-config schema bump (the current `runJob.ts` only
loads YAML job files that have flat URLs and adapter-resolved selectors,
not adapter-invoked discovery; webnovel volumes flow via the TUI auto-probe
path - AutoProbeScreen -> AutoCustomizeScreen -> TaskScreen - not via the
YAML CLI flow).

**Evidence:**
- `src/core/services/ScrapeService.ts`:42-55 declares `deps.siteAdapter?` +
  forwards it to `new ChapterExtractor(this.deps.log, this.deps.siteAdapter)`.
- `src/adapters/ui-clack/screens/TaskScreen.ts`:78 wires the screen param's
  optional `siteAdapter` into the `new ScrapeService({...})` deps object.
- `src/app/runJob.ts`:36-58 currently does NOT pass a `siteAdapter` (CLI /
  YAML flows don't resolve one); the no-volumes EPUB path remains the default.
- `tests/webnovel-pipeline.test.ts` "ScrapeService deps.siteAdapter propagates
  to ChapterExtractor so the adapter post-hook runs" drives the constructor-deps
  wiring through a real adapter instance.

---
