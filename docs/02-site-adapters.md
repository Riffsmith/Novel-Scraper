# 02 — Site Adapter Cookbook

This document records everything currently known about scraping the two officially supported sites,
so that (a) the v2 port of these adapters is faithful, and (b) adding a third site follows a proven pattern.

Each entry cites the exact source lines where the selector/URL pattern was observed.
Both adapters were built from **live-site inspection**, not documentation — sites can change at any time.
When one breaks, update this doc and the adapter in the same commit.

---

## 1. WTR-Lab — `wtr-lab.com`

Source: `src/sites/wtrLab.ts`

| Concern | Value | Source line |
|---------|-------|-------------|
| Adapter id | `wtr-lab` | `:155` |
| Label shown in TUI | `WTR-LAB (wtr-lab.com)` | `:156` |
| Origin | `https://wtr-lab.com` | `:6` |

### 1.1 URL match

```ts
/(^|\.)wtr-lab\.com$/i.test(new URL(url).hostname)
```

(`:9-11`) — matches any subdomain or the bare domain.

### 1.2 TOC URL

```ts
const u = new URL(novelUrl);
u.searchParams.set('tab', 'toc');
```

(`:14-18`) — the novel landing page hosts the chapter list in a `?tab=toc` view.

### 1.3 Metadata selectors

| Field | Selector | Fallback |
|-------|----------|----------|
| Title | `h1.text-base` | `'Unknown Title'` |
| Author | `p.text-xs` (first match) | `'Unknown'` |
| Description | `.description` → `innerText` | `''` |
| Cover | `img.relative` `src` | protocol+host prefix if relative |

(`:36-58`)

### 1.4 Chapter list extraction

The TOC page lazily reveals chapters in batches behind `<button>` elements.

1. Identify expander buttons with text matching `/chapter|^\s*\d+\s*-\s*\d+\s*$/i` (`:77-79`).
2. Click each button, waiting `400ms`; scroll into view first.
3. Re-scan for newly-appeared buttons and click those too (loop guard: max 25 passes).
4. Harvest `a[href*="/chapter-"]`.
5. **De-duplicate** with `new Set`.

(`:73-106`, full `BATCH_EXPAND_SCRIPT`)

### 1.5 Ordering fix

The site sometimes appends the final batch out of order. True order is recovered by parsing the
number out of each URL and sorting numerically:

```ts
url.match(/chapter-(\d+)(?:[-.](\d+))?/i)
```

- `major + (minor || 0) / 1000` is the sort key, so `chapter-131-1` sorts after `chapter-131`.
- Unparseable URLs keep discovery order but log a warning.

(`:136-152`)

### 1.6 Extraction defaults

```ts
defaultContentSelector: '.chapter-content',
defaultTitleSelector: undefined,
defaultSeparateTitle: false,
defaultExcludeSelectors: [],
```

(`:154-165`)

> ⚠ **Known unstable default:** the source carries a TODO — `".chapter-content"` has not been
> verified against a real chapter page. The Phase 4 acceptance criteria include validating this.

### 1.7 Critical contributor warning — `evaluate` as string

`BATCH_EXPAND_SCRIPT` is passed to `page.evaluate()` **as a raw string**, not an arrow function.

(`:61-73`)

Reason: when running under `tsx`, esbuild's `keepNames` transform wraps named arrow functions
with a `__name(fn, "fn")` helper call for stack traces. `page.evaluate` ships the function's
*source text* into the browser; `__name` doesn't exist there, producing
`ReferenceError: __name is not defined`.

> **Rule for v2:** inside any `BrowserPort` evaluation that must run in the page, scripts that
> contain named closures must be written as template strings and passed as strings.

---

## 2. NovelFire — `novelfire.net`

Source: `src/sites/novelfire.ts`

| Concern | Value | Source line |
|---------|-------|-------------|
| Adapter id | `novelfire` | `:217` |
| Label shown in TUI | `NovelFire (novelfire.net)` | `:218` |
| Origin | `https://novelfire.net` | `:6` |

### 2.1 URL match

```ts
/(^|\.)novelfire\.net$/i.test(new URL(url).hostname)
```

(`:8-15`)

### 2.2 TOC URL

```ts
u.pathname = `${bookPathBase(novelUrl)}/chapters`;
u.search = '';
u.hash = '';
```

(`:23-29`) — turns `/book/shadow-slave/` into `/book/shadow-slave/chapters`.

Pagination is `?page=N` (`tocPageUrl`, `:32-35`).

### 2.3 Metadata selectors

| Field | Selector | Fallback chain |
|-------|----------|--------------|
| Title | `.novel-title` | `'Unknown Title'` |
| Author | `.author` `.first()` | `a[title]` → nested `<span>` text → raw block text (`:94-108`) |
| Description | `.content` `innerText` | strips `div.expand` first so "show full synopsis" button text doesn't leak |
| Cover | `.cover > img:nth-child(1)` | `src` → `data-src` (lazy-load) |

(`:76-131`)

### 2.4 Chapter list extraction

1. Walk `?page=1` … `?page=N`.
2. Wait for `.chapter-list`; if absent, stop.
3. Harvest all `a[href]` inside it (as a browser-side string script — `:141-147`).
4. If a page's **first link equals the previous page's first link**, assume the site wrapped an
   out-of-range page back to page 1 and stop (`:190-196`).
5. De-dupe with `Set`, keep insertion order.
6. Hard cap: `MAX_TOC_PAGES = 300` (`:157`).

(`:159-215`)

### 2.5 Extraction defaults

```ts
defaultContentSelector: '#content',
defaultTitleSelector: '.chapter-title',
defaultSeparateTitle: true,
defaultExcludeSelectors: [],
```

(`:217-228`)

### 2.6 Shared gotcha

Same `evaluate`-as-string requirement as WTR-Lab (`:134-140`).

---

## 3. Webnovel - `webnovel.com`

Source: `src/adapters/site-webnovel/WebnovelAdapter.ts` + `src/adapters/site-webnovel/urlUtils.ts`. Reference oracle: `reference/webnovel/contentExtractor.mjs` + `reference/webnovel/urlUtils.mjs` + `reference/webnovel/constants.mjs` (DOM-knowledge parts only - the browser stealth and network retry machinery stay unported per ADR-001 / ScrapeService ownership).

| Concern | Value | Source line |
|---------|-------|-------------|
| Adapter id | `webnovel` | `WebnovelAdapter.ts` `makeWebnovelAdapter` |
| Label shown in TUI | `Webnovel (webnovel.com)` | same |
| Catalog (TOC) URL pattern | `novelUrl + "/catalog"` | `urlUtils.ts:getCatalogUrl` (verbatim from reference `urlUtils.mjs:10-15`) |

### 3.1 URL match

```ts
/^([^.]+\.)*webnovel\.com$/i.test(new URL(url).hostname)
```

Matches `webnovel.com`, `www.webnovel.com`, `m.webnovel.com`, and any subdomain. Hostname regex test, never a substring (AGENTS.md rule - substring would match `https://attacker.com/?ref=webnovel.com`).

### 3.2 TOC URL

`novelUrl.replace(/\/$/, "") + "/catalog"` - the catalog page hosts both the volume-grouped chapter list (`div.volume-item`) and a flat fallback anchor bucket (`a.chapter-item`, `.chapter-list a`, `.catalog-content a:not(:has(svg))`). Single page, no pagination (the reference `extractChapterList` did not paginate; confirmed against a live catalog during implementation).

### 3.3 URL normalisation (`urlUtils.ts`)

| Helper | Behaviour | Reference |
|--------|-----------|-----------|
| `getCatalogUrl(novelUrl)` | strip trailing slash; append `/catalog` | `:10-15` |
| `normalizeChapterUrl(chapterUrl, pageUrl)` | protocol-relative (`//foo`) -> `https:`, root-relative (`/foo`) -> `https://<host>foo`, absolute -> as-is | `:23-34` |
| `normalizeWebnovelHost(url)` | strip `m.` mobile subdomain, promote bare `webnovel.com` to `www.`, strip locale segment (`/pt/book/`, `/id/book/`, `/vi/book/`, `/pt-br/book/`), clear search + hash | `:110-135` |
| `resolveNovelUrl(rawUrl)` | shortener redirect (`wbnv.in`) -> canonical webnovel URL via got's `followRedirect: true` default, then `normalizeWebnovelHost` | `:144-158` |

`resolveRedirect` lazy-imports `got` inside the function body (mirrors `ArchiverEpubWriter.ts:22-29`); the binary-clean path never pulls the HTTP dependency into memory. The reference's `redirect: "follow"` (node-fetch option) becomes a no-op for got v14 because got's `followRedirect` option defaults to `true` (read `node_modules/got/.../options.d.ts`).

### 3.4 Metadata selectors

| Field | Selector | Fallback |
|-------|----------|----------|
| Title | `p:has(a[title=home]) > span:last-child` (waitFor `p > span:last-child` first) | `"Unknown Title"` |
| Author | `a.c_primary` `textContent` | `evaluateScript(AUTHOR_SCRIPT)` reading `address div.ell span`; fallback `"Unknown"` |
| Description | `div.g_txt_over` `innerHTML` | cheerio strip `span._readmore` (the "show full synopsis" toggle); fallback `""` |
| Cover | `._sd > i:nth-child(1) > img:nth-child(1)` `src` | protocol-relative (`//img.webnovel.com/...`) gets `https:` prefix |

(`reference/webnovel/contentExtractor.mjs:14-110`)

Tags (`.m-tags a.fs12`) are NOT in `AutoNovelMetadata` - the v2 surface is `{ title, author, description, coverUrl }`. The reference's tags-extraction (`:90-110`) and the EPUB's `<dc:subject>` emission (`reference/epubGenerator/manifestBuilder.mjs:64-69`) are dropped; v2 EPUB doesn't emit `dc:subject` today. Out of scope per the plan §"Open items requiring follow-up".

### 3.5 Chapter list extraction

Two-tier extraction (reference `contentExtractor.mjs:117-152`, `:218-237`, `:160-189`):

1. **Volume walk** (primary): a single `PageHandle.evaluateScript(CATALOG_WALK_SCRIPT)` call returns `[{ index, name, hrefs }]` per `div.volume-item`. Each volume's `a:not(:has(svg))` are the unlocked chapters (locked chapters have an `<svg>` lock icon, matched by the `:not(:has(svg))` exclusion). Each href is normalized through `normalizeChapterUrl`. The single-script shape is what the AGENTS.md "page.evaluate() string-constant rule" allows (`PageHandle.evaluateScript` ships the source; no closure parameter).
2. **Alternative-selector fallback** (when the volume-walk returns zero links): try each of `.volume-item a:not(:has(svg))`, `a.chapter-item`, `.chapter-list a`, `.catalog-content a:not(:has(svg))` in order. First selector that yields > 0 hrefs wins. Emits a single pseudo-volume `"Additional Chapters"` carrying all hrefs in this fallback path.

- **De-dupe**: insertion-ordered `Set` of normalized URLs (AGENTS.md rule).
- **Hard cap**: `MAX_CHAPTERS = 10_000` (the project-wide `MAX_CHAPTERS` constant, not a webnovel-specific fork per AGENTS.md "don't fork constants").
- **No pagination**: webnovel's catalog is single-page (no `?page=N`). The volume-walk covers every `div.volume-item` on the page in one pass.

### 3.6 Volume walk -> volume groups (`scrapeVolumes`, ADR-P7-B / D2 deviation)

The adapter page visits the catalog ONCE per invocation (D2 deviation per the plan §"Adapter Phase 3" Compatibility note). A shared private `walkCatalogVolumes` helper produces `{ volumes: AutoNovelVolume[]; allUrls: string[] }`:

- `scrapeChapterLinks` returns `allUrls` (flat ordered, de-duped, capped).
- `scrapeVolumes` returns `volumes` (one `AutoNovelVolume` per `div.volume-item` carrying `name + chapterUrls`).

Each `AutoNovelVolume.name` comes from the volume's `<h4>` element. Fallback name `"Volume <index + 1>"` if `h4` is missing - **NOT** the reference's `Volume ${Date.now()}` (D4 deviation: `Date.now()` is non-deterministic and breaks parity testing; the reference's own `epubExtractor.mjs` reordering path uses `<index>` and v2 adopts that). Each `chapterUrls` array is filtered against the global `allUrls` set so a volume never references a chapter that was dropped by de-dupe / cap. This lets the EPUB writer trust the volume map (no second-guessing; ADR-P7-C).

### 3.7 Per-chapter content post-hook (`processChapterContent`, ADR-P7-D / D3 deviation)

Replaces the generic `sanitize-html` allow-list path for webnovel chapters. Faithful port of `reference/webnovel/contentExtractor.mjs:351-470`:

1. Load `rawHtml` with cheerio.
2. Remove blacklisted tags (`pirate`, `i`) and blacklisted classes (`icon`, `para-comment`, `j_open_para_comment`, `j_para_comment_count`, `para-comment-num`, `cha-hr`, `cha-info`, `j_bottom_comment_area`, `user-links-wrap`) - verbatim from `reference/webnovel/constants.mjs:100-112`. Then remove `.anno-drop` elements (already-collected footnote popups).
3. For each `<p>`, find `<anno data-annotation-id> sup` and replace `<sup>` with `<a href="#footnote-<id>" class="footnote-link" id="footnote-ref-<id>">N</a>`. `N` is a per-paragraph footnote counter starting at 1 (reference `:369` - the counter restarts at 1 for each paragraph, NOT global).
4. Strip `class`, `id`, `style` from every `<p>` (reference `:397-398`).
5. Build the footnotes HTML section (`<div class="footnotes-section">` with `<div class="footnote-item" id="footnote-...">` and `<a href="#footnote-ref-..." class="footnote-back-link">` back-links) - matching `_createFootnotesHTML` `:434-470`. `he.encode` is replaced with a local `escXml` (byte-identical 5-char entity encoder; `he`/`html-entities` are not v2 dependencies, and importing the EPUB writer's `escXml` would invert the hexagonal boundary).
6. Wrap in `<h2 class="chapter-page-title">` + decorative-line divs (CSS classes already present in `templates.ts:671-686`).

The reference's `contentProcessor.mjs:42-82` text-node re-escape pass is deliberately **NOT** ported (D3 deviation): v2's `toXhtml()` in `templates.ts:39-50` already escapes bare ampersands and self-closes void tags; re-applying the reference's escape would double-encode `&` to `&` + `amp;`.

### 3.7.1 Footnote collection (`collectFootnotes`, D5 deviation - landed in Pipeline Phase 1)

Footnote **collection** (`_extractFootnotes` in `reference/webnovel/contentExtractor.mjs:276-342` - clicking `<sup>` to trigger `.anno-drop` popup, collecting `.anno-drop-hd` + `.anno-drop-bd`) requires live-page interaction and lives outside `processChapterContent`. The adapter exposes a `collectFootnotes?(page): Promise<Footnote[] | undefined>` method that runs at chapter-extraction time inside `ChapterExtractor.extract()` (after challenge wait-out + content-selector pull and before the `processChapterContent` post-hook).

The click-wait-collect loop runs entirely inside a STRING async-IIFE shipped to the browser via `PageHandle.evaluateScript` (`FOOTNOTE_COLLECT_SCRIPT` in `WebnovelAdapter.ts`). `PageHandle` exposes no generic `$$` / `click` element-handle surface - only `evaluateScript(string)`. Per AGENTS.md §"page.evaluate() string-constant rule" the script is a module-scope plain string constant with no named inner closures (the keepNames `__name` helper injected by tsx would otherwise ReferenceError in browser scope). The script:
- iterates `anno[data-annotation-id]`, clicks each `<sup>` to trigger `.anno-drop`,
- waits 500ms for the popup (reference's `TIMEOUTS.FOOTNOTE_CLICK` from `constants.mjs:63`),
- reads `.anno-drop-hd` (title) + `.anno-drop-bd` (content),
- closes the popup by clicking the parent `<p>`,
- returns `Footnote[]` (possibly empty).

Per-spot fail-soft: a `collectFootnotes` exception is logged as a `warn` ChapterExtractor-side and the chapter proceeds without footnotes (the post-hook still runs with `footnotes ?? undefined`). Chapter-extraction retry/backoff is **not** re-run for footnote failures - that pipeline is owned by `ScrapeService` for full-chapter failures (timeout / SecurityChallengeError), and incremental footnote misses are non-load-bearing per chapter (the chapter body still extracts fine).

The single live-binary acceptance test (`tests/acceptance.test.ts` extension, gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`) covers the live `collectFootnotes` path against a static chapter fixture once a real browser is available; the pure-DOM-shape surface is unit-tested with the FakeBrowserPort above.

### 3.8 Extraction defaults

```ts
defaultContentSelector: "div.cha-words",
defaultTitleSelector: "h1.dib.mb0.fw700.fs24.lh1\\.5, h1.chapter-title, .j_chapterName",
defaultSeparateTitle: true,
defaultExcludeSelectors: [
  ".para-comment", ".cha-hr", ".cha-info", ".icon",
  ".j_bottom_comment_area", ".user-links-wrap",
],
```

(verbatim from `reference/webnovel/constants.mjs:30-31` + `:100-110`)

### 3.9 String-evaluate rule

Webnovel uses `PageHandle.evaluateScript` for:

- `AUTHOR_SCRIPT` - author extraction via `address div.ell span` (reference `:52-56`).
- `CATALOG_WALK_SCRIPT` - the volume walk, returns `[{ index, name, hrefs }]` per `div.volume-item`.
- `makeAltChapterScript(selector)` - alternative-selector fallback (one per selector in `ALTERNATIVE_CHAPTER_SELECTORS`).
- `FOOTNOTE_COLLECT_SCRIPT` - Pipeline Phase 1 (D5 deviation): a single async-IIFE that runs the click-wait-collect loop browser-side and returns `Footnote[]`-shaped JSON to `ChapterExtractor`, which feeds it into `processChapterContent`'s `footnotes` input.

Every script is a plain string constant defined at module scope; never a closure (the keepNames `__name` helper absent from browser scope - AGENTS.md "page.evaluate() string-constant rule").

### 3.10 Pipeline integration (Pipeline Phase 1 + 2 + 4)

The full Adapter -> Pipeline wire:

- `ChapterExtractor.extract()` (`src/core/services/ChapterExtractor.ts`) gains an optional `siteAdapter?` constructor arg (set by `ScrapeService` from its own `deps.siteAdapter`). When the adapter provides `collectFootnotes` / `processChapterContent`, the extractor runs them between the generic extraction (challenge wait-out + content-selector pull + exclude strip + cheerio post-process) and the EPUB writer's `toXhtml()` post-process - exactly the order ADR-P7-D specifies. The adapter's `htmlContent` BYPASSES `sanitize-html`. When the adapter hook is unset, the existing `sanitizeHtml` path runs byte-identical.
- `ScrapeService` (`src/core/services/ScrapeService.ts`) gains an optional `deps.siteAdapter` so its `ChapterExtractor` constructor-call receives the adapter. `ScrapeService.run` also gains a trailing-optional `volumes?` parameter (ADR-P7-A) forwarded to `EpubWriter.write`; on resume, `session.volumes` (if set) overrides the caller arg (resume checkpoint is the source of truth).
- `AutoProbeScreen` calls `adapter.scrapeVolumes?` (when present) after `scrapeChapterLinks` and sets `AutoScrapeResult.volumes`. `buildQuickAutoConfig` + `assembleAutoJob` flow that onto `JobConfig.volumes`, and the screen push to TaskScreen passes the resolved `siteAdapter` so ScrapeService can wire `collectFootnotes` + `processChapterContent` into ChapterExtractor.
- `ChapterListScreen` accepts an optional `volumes?: AutoNovelVolume[]` param (Pipeline Phase 4 minor frontend addition) and renders a per-volume line above the flat chapter list. No domain change.
- `runJob.ts` forwards `job.volumes` to `ScrapeService.run` so the CLI / YAML flow reuses the same seam (relevant when a future YAML job file embeds a volume map).

The flat-catalog adapters (wtr-lab, novelfire) leave `scrapeVolumes`, `processChapterContent`, and `collectFootnotes` unset; their EPUB output is byte-identical to today (regression-guarded by `tests/epub-archiver.test.ts` "no-volumes output stays byte-identical" + `tests/chapter-extractor.test.ts` and `tests/scrape-service.test.ts` unchanged behaviour for adapter-less flows).

### 3.11 Verification status

Verified against the live site during implementation: selectors still resolve on `webnovel.com` for title / author / catalog / volume-item-h4 paths. The locked-chapter `<svg>` exclusion holds. Pipeline Phase 1 / 2 / 4 wired the full Adapter -> ChapterExtractor -> ScrapeService -> EpubWriter flow; the live-binary acceptance test (`tests/acceptance.test.ts` gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`) covers the live `scrapeMetadata` / `scrapeChapterLinks` / `scrapeVolumes` / `collectFootnotes` paths once a real browser context is available.

---

## 4. Adapter authoring checklist (for the fourth site and beyond)

1. **Match:** write `matches(url)` as a hostname regex test — never a URL substring test.
2. **TOC resolution:** implement `getTocUrl(novelUrl)` so the auto-scrape flow can degrade
   gracefully to manual TOC mode if the adapter's `scrapeChapterLinks` breaks.
3. **Metadata:** scrape title, author, description, cover — with a logged fallback for each.
4. **Chapter links:** prefer deterministic URL patterns; always de-dupe; always enforce a hard cap.
5. **Keep order stable:** if the site serves links out of order, parse numbers from URLs and sort.
6. **Defaults:** set `defaultContentSelector`, `defaultTitleSelector`, `defaultSeparateTitle`,
   `defaultExcludeSelectors` so the fast path works with two confirmations.
7. **String scripts:** browser-side multi-step logic **must** be passed to `page.evaluate` as a
   string.
8. **Log generously:** metadata result + per-TOC-page counts; they are the only diagnostics when
   a site silently changes layout.

---

## 5. Post-roadmap improvement ideas (not in parity scope)

- Promote the `evaluate`-as-string rule into a shared helper (`safeEvaluateString(page, script)`).
- Add a tiny self-test command (`wnscrape doctor --site novelfire`) that scrapes the public
  landing page and asserts every metadata selector still resolves.
- Support novel-level exclude lists in adapter defaults once a second site needs them.
