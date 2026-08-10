# Phase 7 - Deviation Log

Reference design: `docs/sites/webnovel-port-plan.md` (the webnovel port implementation
plan). This file lists every place the implementation diverged from that design, with
the reason and the consequence. Anything not listed here was implemented as specified.

For chronological divergence in named phases other than `Scaffold`, the next
implementor adds entries as they arise. D1-D5 below were seeded from the plan
itself - the Adapter + Epub phases flipped D1-D4 from "planned" to
"implemented" (file/line evidence added); D5 stays DEFERRED until Pipeline
Phase 1 lands the `collectFootnotes?` SiteAdapter method.

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

## D5 - `collectFootnotes` separated from `processChapterContent` because it needs live-page interaction (DEFERRED TO PIPELINE PHASE 1)

**Spec:** `docs/sites/webnovel-port-plan.md` §"Named phase `Adapter`" Phase 5
step 8 ("the footnote collection happens in a separate adapter method
`collectFootnotes(page)` that runs at chapter-extraction time").

**Deviation (planned, deferred):** `SiteAdapter` will gain an OPTIONAL third
method, `collectFootnotes?(page): Promise<Footnote[] | undefined>`, that lives
alongside `scrapeVolumes` and `processChapterContent`. The footnote
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
as written." So the Adapter Phase 5 implementor is NOT the one adding it -
Pipeline Phase 1 is. Pipeline Phase 1's implementor must add
`collectFootnotes?` to `SiteAdapter.ts` and wire it from `ChapterExtractor`.

**Status:** Adapter Phase 5 implemented `processChapterContent` (which
produces the footnote section HTML given already-collected `Footnote[]` on
its input). The actual `Footnote[]` collection mechanism is what's deferred
- Pipeline Phase 1 adds the `collectFootnotes?(page): Promise<Footnote[] |
undefined>` SiteAdapter method and the `ChapterExtractor` call sequence
that runs it before `processChapterContent`. Until Pipeline Phase 1 lands,
the webnovel adapter's `processChapterContent` is unit-tested with
`footnotes` provided on the input (treated as if already collected); the
live page click-loop is not yet wired.


---
