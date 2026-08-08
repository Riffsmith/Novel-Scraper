# Adding a Site Adapter

This is the contributor-facing how-to for adding a third site adapter. It is extracted from the
adapter authoring checklist in `docs/02-site-adapters.md` section 3 (the cookbook is the
evidence doc for the two built-in adapters; this is the standalone procedure). The two built-in
adapters, WTR-Lab and NovelFire, live under `src/adapters/...` (post-Phase-6 location) and serve
as the reference implementations.

---

## The `SiteAdapter` interface

Every site adapter implements `SiteAdapter` (see the adapter directory or `ports/` for the
interface). The interface requires:

| Method / field | Purpose |
|----------------|---------|
| `id` | Stable adapter id, e.g. `"wtr-lab"`. |
| `label` | Human label shown in the TUI, e.g. `"WTR-LAB (wtr-lab.com)"`. |
| `matches(url)` | Returns true if the adapter owns this URL. Implemented as a **hostname regex test, never a substring test** (substring matches would leak across domains). |
| `getTocUrl(novelUrl)` | Resolve the novel landing URL into the chapter-list URL the auto-scrape flow walks. Lets the wizard degrade gracefully into manual TOC mode if `scrapeChapterLinks` later breaks. |
| `scrapeMetadata(page)` | Scrape title, author, description, cover, each with a logged fallback. |
| `scrapeChapterLinks(page)` | Walk the TOC (including pagination if present), harvest `a[href]` chapter links. |
| `defaultContentSelector` | CSS/XPath selector for the chapter body, used by the wizard's fast path. |
| `defaultTitleSelector` | Selector for the chapter title element (or empty/`undefined` if the title is inlined in the body). |
| `defaultSeparateTitle` | Boolean: is the title in a separate element from the body? |
| `defaultExcludeSelectors` | Default exclusion list (ads, author notes, donation banners). |

## Step-by-step

### 1. Match

Write `matches(url)` as a hostname regex test:

```ts
match(url: string): boolean {
  return /(^|\)example\.com$/i.test(new URL(url).hostname);
}
```

This matches any subdomain or the bare domain. A substring test (e.g. `url.includes("example.com")`)
would match `https://attacker.com/path?ref=example.com`, a real bug class - never use one.

### 2. TOC resolution

Implement `getTocUrl(novelUrl)` so the wizard's auto-discovery flow can degrade to manual TOC mode
if your `scrapeChapterLinks` ever breaks. The fallback path needs a working TOC URL.

### 3. Metadata

Scrape title, author, description, cover. Each must have a logged fallback so a layout change
at one field degrades gracefully instead of throwing and aborting a 200-chapter run at chapter
zero. See the WTR-Lab metadata table in `docs/02-site-adapters.md` section 1.3 for an example
fallback chain.

### 4. Chapter links: de-dupe + hard cap

- Prefer deterministic URL patterns (e.g. `/chapter-N` or `/book/<slug>/chapters?page=N`).
- **Always de-dupe** chapter links with a `Set` keeping insertion order. TOCs routinely repeat
  a first link across paginated pages to fake "back to chapter 1".
- **Always enforce a hard cap** on TOC pages (`MAX_TOC_PAGES`). An infinite-looping pagination
  detector (where a wrapped out-of-range page returns page 1 again) is part of the NovelFire
  pattern (cookbook section 2.4) - copy it if your site paginates.

### 5. Keep order stable

If the site serves links out of order (e.g. WTR-Lab appends the final batch out of order, cookbook
section 1.5), parse numbers out of the URLs and sort numerically. WTR-Lab uses
`url.match(/chapter-(\d+)(?:[-.](\d+))?/i)` and sorts on `major + (minor \|\| 0) / 1000` so
`chapter-131-1` sorts after `chapter-131`. Unparseable URLs keep discovery order but log a
warning.

### 6. Browser-side scripts must be string constants

The script you send into `page.evaluate()` must be a **plain string constant** - never an
arrow function, never a closure with named inner functions. tsx/esbuild's `keepNames` transform
injects a `__name(fn, "fn")` helper into a function's source text that does not exist in browser
scope, silently producing `ReferenceError: __name is not defined` at runtime. This is invisible
at build time.

Pages built via `PageHandle` (see `ports/BrowserPort.ts`) deliberately expose no generic
`evaluate()` - every browser-side operation is a named method. If your adapter needs a new
browser-side operation, add a named `PageHandle` method and implement it in
`PlaywrightBrowserPort.ts` with a string-based evaluate. Don't thread a closure through.

See cookbook sections 1.7 and 2.6 for the WTR-Lab and NovelFire `BATCH_EXPAND_SCRIPT` examples
- both are raw string constants passed to the evaluate call.

### 7. Log generously

Log the metadata result + per-TOC-page counts. They are the only diagnostics you have when a
site silently changes layout in production. A warning that "TOC page 4 returned 0 links" is how
you know a layout shifted mid-scrape.

---

## Adapter authoring checklist (verbatim from cookbook section 3)

1. **Match:** write `matches(url)` as a hostname regex test - never a URL substring test.
2. **TOC resolution:** implement `getTocUrl(novelUrl)` so the auto-scrape flow can degrade
   gracefully to manual TOC mode if the adapter's `scrapeChapterLinks` breaks.
3. **Metadata:** scrape title, author, description, cover - with a logged fallback for each.
4. **Chapter links:** prefer deterministic URL patterns; always de-dupe; always enforce a hard
   cap.
5. **Keep order stable:** if the site serves links out of order, parse numbers from URLs and
   sort.
6. **Defaults:** set `defaultContentSelector`, `defaultTitleSelector`, `defaultSeparateTitle`,
   `defaultExcludeSelectors` so the fast path works with two confirmations.
7. **String scripts:** browser-side multi-step logic **must** be passed to `page.evaluate` as a
   string.
8. **Log generously:** metadata result + per-TOC-page counts; they are the only diagnostics when
   a site silently changes layout.

---

## Update the cookbook in the same commit

`docs/02-site-adapters.md` is the only place site-specific selector evidence lives. When you add
or fix an adapter, update the cookbook table with the exact selectors observed on the live site
and a "verified <date>" note. Following this rule is what makes the cookbook trustworthy - every
entry cites a source line, and that source line still resolves to the actual selector the
adapter uses today.
