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

## 3. Adapter authoring checklist (for the third site)

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

## 4. Post-roadmap improvement ideas (not in parity scope)

- Promote the `evaluate`-as-string rule into a shared helper (`safeEvaluateString(page, script)`).
- Add a tiny self-test command (`wnscrape doctor --site novelfire`) that scrapes the public
  landing page and asserts every metadata selector still resolves.
- Support novel-level exclude lists in adapter defaults once a second site needs them.
