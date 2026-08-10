# Webnovel Port — Implementation Plan

This document specifies how to add `webnovel.com` scraping to v2 as a new site adapter,
and how to extend the existing EPUB pipeline to emit Volume pages, matching the
`reference/webnovel/` and `reference/epubGenerator/` sources faithfully without
disrupting the WTR-Lab and NovelFire flows.

**No business logic of the current project is changed in this session.**
This is the design proposal only. Code work happens in subsequent passes, one phase at a time.

## Inputs

- `reference/webnovel/` — scraper for webnovel.com (browser manager, content extractor, rate limiter, network utils, URL utils, constants). The DOM selectors, volume walking, chapter extraction, footnote handling and URL-normalization logic in here are the oracle for the `WebnovelAdapter`. Browser stealth (browserManager.mjs's `WEBDRIVER_BYPASS_SCRIPT`, `BROWSER_CONFIG.ARGS`, custom `userAgent`) is **not ported** — CloakBrowser owns fingerprinting (ADR-001, ADR-006, AGENTS.md). The network retry mechanism (`networkUtils.mjs`, `rateLimiter.mjs` backoff) is **not ported** — `ScrapeService` already owns the retry/backoff pipeline, including the `SecurityChallengeError` 45s backoff. Only the DOM-knowledge parts of the reference are ported.
- `reference/epubGenerator/` — the EPUB generator that takes metadata + chapters + volumes and emits a fully-built EPUB 3 file. The chapter-processing pipeline (footnote rewrite, decorative lines, blacklisted-tag stripping) matches the reference contentExtractor.mjs; the **Volume page** generation (`contentProcessor.createVolumePage`), spine/NCX/nav insertion (`manifestBuilder.createContentOpf`, `tocBuilder.createNav/createTocNcx`), and the per-volume chapter assignment (`tocBuilder.assignChaptersToVolumes`) are ported one-to-one into the EPUB writer.

## Out of scope (explicit, per user direction)

- The browser stealth (`WEBDRIVER_BYPASS_SCRIPT`, `BROWSER_CONFIG.*`, `userAgent`). CloakBrowser via `ensureBinary()` + `buildLaunchOptions()` (ADR-006) is the only legit stealth vector. The webnovel adapter reuses the existing `PlaywrightBrowserPort` — no new browser code.
- The network retry machinery (exponential backoff, connectivity test, network-error classifier, Cloudflare classifier in `networkUtils.mjs` / `rateLimiter.mjs`). That responsibility is already owned by `ScrapeService` (refer to `src/core/services/ScrapeService.ts:175-264` for the 3-retry loop and `src/core/services/ChapterExtractor.ts:98-141` for the challenge wait-out). Adding a second retry layer at adapter scope would be redundant.
- The reference's `epubExtractor.mjs` (extracts chapters out of an existing `.epub` for incremental re-runs). v2 handles resume via `JsonSessionStore` checkpoints (read `src/core/domain/Session.ts` and `src/adapters/store-json/JsonSessionStore.ts`). The feature is shape-equivalent and already shipped.

## Confirmed architectural decisions (ADR-P7 series)

These four decisions were flagged to the user during exploration and confirmed. They shape every phase below.

### ADR-P7-A — `Volume[]` flows through the `EpubWriter` port

The `EpubWriter.write` signature gains an optional `volumes?: Volume[]` parameter. The decision is **additive-optional**: the two existing adapters (WTR-Lab, NovelFire) are not volume-producing sites today and pass nothing (or `undefined`); their EPUB output is byte-identical to today's output. The webnovel adapter is the first to actually emit volume data.

This leaves the port seam open for future chapter-grouped sites (RoyalRoad, ScribbleHub, Wuxiaworld — listed in `docs/04-implementation-roadmap.md` §"Post-parity backlog") without another port edit. The rejected alternatives were:
- Carrying volume info on the `Chapter` domain (`volumeIndex?`) — that requires every `Chapter` consumer (session store, `JsonSessionStore` migration chain) to round-trip a new field — migration concern, against `docs/05-migration-guide.md`.
- A per-site EPUB adapter only — divergent per-site output and a separate test rig, rejected as post-parity backlog territory.

### ADR-P7-B — `AutoScrapeResult` and `SiteAdapter` carry optional `volumes`

`AutoScrapeResult` gains `volumes?: AutoNovelVolume[]`. `SiteAdapter` gains an optional `scrapeVolumes?(page, novelUrl, opts): Promise<AutoNovelVolume[] | undefined>` method. Existing adapters leave both unset; callers check `result.volumes ?? job.volumes ?? undefined`. The flat ordered `chapterLinks: string[]` continues to flow into `ScrapeService` queue unchanged — the volume map is a side-channel that the EPUB step reads at build time. This keeps the discovery → queue → EPUB pipeline linear and single; the volume list attaches to `JobConfig` and `ScrapeSession` as an additive-optional field.

The rejected alternatives were:
- Changing the `scrapeChapterLinks` return type to a richer `{ urls; volumes? }` — strictly breaking for both existing adapters for zero functional gain today.
- Webnovel re-walking the catalog for volumes at EPUB time — the EPUB step has no site knowledge and shouldn't.
- "Order-only" slicing by volume counts without per-chapter mapping — drifts when de-dupe/cap drops a chapter (test impossible to write deterministically).

### ADR-P7-C — Volume <-> chapter mapping resolved by URL at EPUB build time

The `Volume` domain shape is:
```ts
export interface AutoNovelVolume { name: string; chapterUrls: string[]; }
export interface Volume extends AutoNovelVolume { /* same - the job-level shape */ }
```
The adapter walks the catalog volume-by-volume (matching the reference `_extractVolumeData` loop) and emits `name + chapterUrls` per volume. The adapter does **not** precompute indices. `EpubWriter` receives `Chapter[]` (with their canonical `url` field) plus `volumes?: Volume[]`, builds a `Map<url, Chapter>`, and assigns each chapter to a volume by `volume.chapterUrls.includes(chapter.url)`. Unmatched chapters fall through to an "Additional Chapters" group (matches the reference's `volumeChapters.get("extra")` behaviour in `tocBuilder.mjs:57-73`).

The writer is the single index authority, the adapter is the single DOM-knowledge authority. Clean responsibility split, no double-walking, no stale index tracking.

### ADR-P7-D — Faithful per-chapter processing in a `SiteAdapter` hook

The reference `ContentExtractor.processChapterContent` + `epubGenerator/contentProcessor.processChapter` do webnovel-specific cleaning:
- Blacklisted tag removal (`pirate`, `i`) and blacklisted class removal (`para-comment`, `cha-hr`, `j_para_comment_count`, `j_bottom_comment_area`, `user-links-wrap`, `cha-info`, `j_open_para_comment`, `icon`, `para-comment-num`) — read directly from `reference/webnovel/constants.mjs:100-112`.
- Footnote extraction: clicking `<sup>` inside `<anno data-annotation-id>` to trigger the `.anno-drop` popup, collecting its `.anno-drop-hd` (title) + `.anno-drop-bd` (content), rewriting the `<sup>` into a `<a href="#footnote-<id>" class="footnote-link">` link and appending a `<div class="footnotes-section">` block with back-links.
- Decorative header line `━━━━━✧✧✧✧━━━━━` and ending line `✦ ✧ ✦ ✧ ✦` wrapped around the chapter body (the CSS classes `.decorative-line` and `.ending-line` are already present in `src/adapters/epub-archiver/templates.ts:669-686` from a forward-looking earlier pass — they exist precisely so the EPUB writer can use them without re-styling).

A new optional `SiteAdapter.processChapterContent?(rawHtml, title, footnoteData): { htmlContent, footnotes }` post-hook lets the webnovel adapter reproduce the reference **byte-faithful**. Other adapters leave it unset; the generic `sanitize-html` allow-list (in `ChapterExtractor`) keeps running as today. The hook runs **after** the generic extraction (challenge wait-out, content-selector pull, exclude-selector strip) and **before** the EPUB writer's `toXhtml()` post-process — preserving the same code-ordering the reference uses.

The rejected alternatives:
- Genericising into the shared `ChapterExtractor` — the DOM idioms (`<anno>`, `pirate`, `.para-comment`) are webnovel-only; forcing them on WTR-Lab/NovelFire is the cross-site coupling AGENTS.md §"Testing" warns against.
- Per-site hook in the adapter without extending the port — would invert the dependency so the EPUB writer has to know which adapter produced each chapter, which it does not and should not.

---

## Phase naming

Per the user's instruction, the design is divided into **named phases** (not numbered). Each named phase has phase numbers under it. A named phase represents one cohesive concern and ship-a-block boundary; the phase numbers are sequential checkpoints inside it.

- Named phase **`Scaffold`** — domain types + port extension, no behaviour yet.
  - Scaffold Phase 1 — `Volume` + `AutoNovelVolume` domain
  - Scaffold Phase 2 — `EpubWriter` port extension
  - Scaffold Phase 3 — `SiteAdapter` port extension (`scrapeVolumes` + `processChapterContent`)
  - Scaffold Phase 4 — `JobConfig` + `ScrapeSession` additive volume field + migration entry
- Named phase **`Adapter`** — the webnovel `SiteAdapter` implementation itself.
  - Adapter Phase 1 — module skeleton, registry registration, matches/getTocUrl, URL normalization
  - Adapter Phase 2 — `scrapeMetadata` (title, author, description, cover with fallbacks)
  - Adapter Phase 3 — `scrapeChapterLinks` (catalog walk + alternative-selector fallback + de-dupe + hard cap)
  - Adapter Phase 4 — `scrapeVolumes` (volume-by-volume walk emitting `AutoScrapeVolume[]`)
  - Adapter Phase 5 — `processChapterContent` (reference-faithful cleaning + footnotes + decorative lines)
- Named phase **`Epub`** — extend `ArchiverEpubWriter` to render volume pages one-to-one with the reference.
  - Epub Phase 1 — `volumeXhtml` template + manifest + spine entry
  - Epub Phase 2 — `nav.xhtml` nested-`<ol>` volume groups
  - Epub Phase 3 — `toc.ncx` nested `<navPoint>` volume groups
  - Epub Phase 4 — `content.opf` volume manifest + spine ordering (volumes before their chapter groups)
  - Epub Phase 5 — volume <-> chapter resolution by URL membership, "Additional Chapters" fallback
- Named phase **`Pipeline`** — wire volumes through `ChapterExtractor` -> `ScrapeService` -> `runJob` and the TUI `auto-probe`/`auto-customize` flow.
  - Pipeline Phase 1 — `ChapterExtractor` invokes `SiteAdapter.processChapterContent` after generic extraction
  - Pipeline Phase 2 — `ScrapeService.run` accepts `volumes?` and forwards to `EpubWriter`
  - Pipeline Phase 3 — `runJob` propagates `job.volumes` from `AutoScrapeResult.volumes`
  - Pipeline Phase 4 — TUI `AutoProbeScreen` attaches volumes to the JobConfig handed to the customize/run flow
- Named phase **`Evidence`** — docs + tests locking the behaviour in.
  - Evidence Phase 1 — `docs/02-site-adapters.md` §3 webnovel cookbook entry
  - Evidence Phase 2 — parity tests for `WebnovelAdapter` against static fixtures
  - Evidence Phase 3 — parity tests for `ArchiverEpubWriter` with volumes against the reference output shape
  - Evidence Phase 4 — `docs/phase-7/deviation-log.md` if any of these ADRs led to an implementation divergence

---

## Named phase `Scaffold` — domain types + port extension, no behaviour yet

**Goal:** lay down the additive-optional types and port seams so the later phases can land against a stable contract. No new user-visible behaviour; `pnpm typecheck` and `pnpm test` stay green.

### Scaffold Phase 1 — `Volume` + `AutoNovelVolume` domain

- Create `src/core/domain/Volume.ts` with:
  ```ts
  export interface AutoNovelVolume { name: string; chapterUrls: string[]; }
  export type Volume = AutoNovelVolume;
  ```
  Keeping them as aliases today is intentional (the JobConfig-persisted shape and the scraped shape are currently identical). They live as separate types so that if the persisted shape later gains a `id`/`order`/`createdAt` without touching the scraped shape, the type boundary is already in place (read AGENTS.md §"Architecture — v2 layout rules": "When adding a new cross-boundary type ... define it in `core/domain/`, not inline in an adapter.")
- `Volume` exports `AutoNovelVolume` re-exports only. **No imports from adapters**.
- No callers; this is the type that the rest of `Scaffold` and `Adapter` and `Epub` reference.

### Scaffold Phase 2 — `EpubWriter` port extension

- `src/ports/EpubWriter.ts`:
  ```ts
  import type { Volume } from "../core/domain/Volume.js";
  export interface EpubWriter {
    write(
      chapters: Chapter[],
      meta: NovelMetadata,
      destDir: string,
      filename: string,
      volumes?: Volume[],
    ): Promise<{ path: string }>;
  }
  ```
  The parameter is **trailing and optional** so the existing `ArchiverEpubWriter.write()` call in `src/core/services/ScrapeService.ts:286-291` keeps compiling without change. The contract: when `volumes` is `undefined` (or empty), the writer produces the exact same EPUB bytes as today — verifiable by the byte-identical test extension in Evidence Phase 3.

### Scaffold Phase 3 — `SiteAdapter` port extension

- `src/core/domain/SiteAdapter.ts` adds:
  ```ts
  import type { AutoNovelVolume } from "./Volume.js";
  export interface AutoScrapeResult {
    /* unchanged */
    volumes?: AutoNovelVolume[];
  }
  export interface SiteAdapter {
    /* unchanged ... */
    scrapeVolumes?(
      page: PageHandle,
      novelUrl: string,
      opts: { waitUntil: WaitUntil; navTimeoutMs: number },
    ): Promise<AutoNovelVolume[] | undefined>;
    processChapterContent?(input: {
      rawHtml: string;
      title: string;
      footnotes?: Array<{ ref: string; title: string; content: string }>;
    }): { htmlContent: string; footnotes?: Footnote[] };
  }
  ```
- `Footnote` type added as `src/core/domain/Footnote.ts`:
  ```ts
  export interface Footnote { ref: string; title: string; content: string; }
  ```
- The two existing adapters do **not** change (both `scrapeVolumes` and `processChapterContent` are optional). This phase's commit is type-only — both `runJob.ts` and `tui.ts` compile unchanged.

### Scaffold Phase 4 — `JobConfig` + `ScrapeSession` additive field + migration entry

- `src/core/domain/JobConfig.ts`:
  ```ts
  extends ScraperConfig {
    /* unchanged ... */
    volumes?: Volume[]; // additive-optional, additive-optional only per AGENTS.md
  }
  ```
- `src/core/domain/Session.ts`:
  ```ts
  export interface ScrapeSession {
    /* unchanged ... */
    volumes?: Volume[];
  }
  ```
- `src/adapters/store-json/JsonSessionStore.ts` schema version bumps (read `docs/05-migration-guide.md` §9). The bump follows the chain pattern: one `StoreMigration { fromVersion: current, toVersion: next, migrate(raw) }` that **only** sets `raw.volumes = raw.volumes ?? undefined` if missing. Unknown keys round-trip untouched (per AGENTS.md "Unknown keys in any JSON/YAML store must round-trip untouched on write"). The v1 sessions already on disk remain readable (this is the additive-optional pattern AGENTS.md calls out — read `docs/05-migration-guide.md` §1).
- **No changes** to `JsonCookieStore`, `JsonProfileStore`, `YamlConfigStore` (cookies are domain-level, profiles are site profiles; volumes are session-level bookkeeping, not a domain store).
- Update zod schema for `JobConfig` accordingly (additive-optional; default `undefined`); `pnpm gen:schema` regenerates `schemas/job.schema.json`.

**Acceptance for `Scaffold`:** `pnpm typecheck`, `pnpm test` green. Existing EPUB output for WTR-Lab/NovelFire unchanged (the existing `tests/epub-archiver.test.ts` passes byte-identically). `tests/session-store.test.ts` round-trips a v1 session fixture that does not have `volumes` and reads it as migration-completed, no data loss.

---

## Named phase `Adapter` — the webnovel `SiteAdapter` implementation

**Goal:** implement `src/adapters/site-webnovel/WebnovelAdapter.ts` matching the reference `reference/webnovel/`. The adapter lives in its own directory under `src/adapters/site-webnovel/` (per AGENTS.md §"Architecture — v2 layout rules" — one directory per adapter), mirrors the layout of `site-wtr-lab` and `site-novelfire`, and registers in `src/adapters/site-registry/index.ts`.

The adapter is **pure DOM knowledge**. No browser launch (that's `PlaywrightBrowserPort`), no retry (that's `ScrapeService`), no fingerprinting (that's CloakBrowser). Browser-side scripts are plain string constants — the AGENTS.md "page.evaluate() string-constant rule" applies via the `PageHandle.evaluateScript` port (refer to `src/adapters/site-wtr-lab/WtrLabAdapter.ts:37-70` for the precedent and `docs/02-site-adapters.md` §1.7 for the rationale).

### Adapter Phase 1 — Skeleton, URL match, TOC URL, URL normalization

- Create `src/adapters/site-webnovel/WebnovelAdapter.ts` and `src/adapters/site-webnovel/urlUtils.ts`.
- `makeWebnovelAdapter(log: Logger): SiteAdapter` factory pattern (mirrors `WtrLabAdapter` :145-158). Constructor's logger binding is owned by the composition root, never at a singleton.
- `matches(url)` as a hostname regex test — `/^(([^.]+)\.)?webnovel\.com$/i.test(new URL(url).hostname)` (matches `webnovel.com`, `www.webnovel.com`, `m.webnovel.com`). **Never a substring test** — AGENTS.md rule.
- `getTocUrl(novelUrl)` returns `novelUrl.replace(/\/$/, "") + "/catalog"` — verbatim port of `reference/webnovel/urlUtils.mjs:10-15` `getCatalogUrl`.
- URL normalization helpers in `urlUtils.ts`:
  - `normalizeChapterUrl(chapterUrl, pageUrl)` — verbatim port of `reference/webnovel/urlUtils.mjs:23-34`.
  - `normalizeWebnovelHost(url)` — verbatim port of `reference/webnovel/urlUtils.mjs:110-135`. Strips `m.` mobile subdomain and any locale segment (`/pt/book/`, `/id/book/`, `/vi/book/`, `/pt-br/book/`, …) — these silently change the page language and break the English selectors.
  - `resolveNovelUrl(rawUrl)` — async port of `reference/webnovel/urlUtils.mjs:144-158`. Resolves shortener URLs (e.g. `wbnv.in`) to the canonical `webnovel.com` URL. Uses the project's existing `got` (already a dependency — read `package.json:14`). The reference uses `node-fetch`; v2 uses `got` because `ArchiverEpubWriter.ts:23` already lazy-imports it for cover download. Same HTTP semantics (`redirect: "follow"`).
- Adapter `id` = `"webnovel"`. `label` = `"Webnovel (webnovel.com)"`.
- Register in `src/adapters/site-registry/index.ts`:
  ```ts
  import { webnovelAdapter } from "../site-webnovel/WebnovelAdapter.js";
  export const SITE_ADAPTERS: SiteAdapter[] = [wtrLabAdapter, novelFireAdapter, webnovelAdapter];
  ```
  Order matches how the registry declares sites today (`docs/02-site-adapters.md`: "the cookbook table cites a source line, and that source line still resolves to the actual selector the adapter uses today").

### Adapter Phase 2 — `scrapeMetadata`

`scrapeMetadata(page, novelUrl)` returns `AutoNovelMetadata`. Pure port of `reference/webnovel/contentExtractor.mjs:14-37` and helpers `:44-110`. Each field has a logged fallback per AGENTS.md §"Adapter authoring checklist" / `docs/sites/adding-a-site.md` §3.

- Navigate to `novelUrl` via `page.goto(novelUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 })` (matches `WtrLabAdapter.scrapeMetadata` at `:78`). The reference's `domcontentloaded` waitUntil and 90s timeout are preserved as the same `domcontentloaded` and the standard v2 30s navTimeout (the reference's 90s `TIMEOUTS.CHAPTER_CONTENT` from `constants.mjs:60` is for chapter-content waits, not the initial navigation — the v2 base for navigation is 30s in `DiscoveryService.ts:66`).
- Title — `page.textContent(SELECTORS.TITLE, 60_000)`. Selector `p:has(a[title=home]) > span:last-child`. Fallback `""`.
- Author — try `page.textContent("a.c_primary", 8_000)`; if empty, evaluate `AUTHOR_SCRIPT` string const that reads `address div.ell span` textContent (reference `:44-61`). Fallback `"Unknown"` (matches `WtrLabAdapter` fallback).
- Description — `page.innerHTML("div.g_txt_over", 8_000)`, then strip `span._readmore` via `page.innerText(... , excludeSelectors=["span._readmore"])` — port of reference `_extractDescription` `:68-83`. Note: `innerHTML` with cheerio post-cleaning is the reference's path; v2's `PageHandle.innerText(selector, timeoutMs, excludeSelectors[])` matches it directly.
- Cover — `page.getAttribute("._sd > i:nth-child(1) > img:nth-child(1)", "src")` (reference `:28`). Protocol-relative URLs (`//img.webnovel.com/...`) are prefixed with `https:` (the reference's pattern, mirroring `WtrLabAdapter.ts:88-94`).
- Tags are **not** in `AutoNovelMetadata` (the v2 surface is `{ title, author, description, coverUrl }` — read `src/core/domain/SiteAdapter.ts:31-35`). The reference's tags-extraction (`:90-110`) is dropped — there is no `subjects: string[]` field on the v2 `AutoNovelMetadata` and adding one is scope creep. The reference's `subjects` is one of the EPUB manifest's `<dc:subject>` elements — v2 EPUB doesn't emit those today (read `templates.ts:140-152`), and webnovel tags are unreliable for a metadata field. Out of scope for this port.

### Adapter Phase 3 — `scrapeChapterLinks`

Port of `reference/webnovel/contentExtractor.mjs:117-152` and `:218-237`. Returns `string[]` of canonical chapter URLs in correct reading order.

- Navigate to `getTocUrl(novelUrl)` (= `novelUrl + "/catalog"`).
- Wait for `SELECTORS.CHAPTER_LINKS` (`.volume-item a:not(:has(svg)), a.chapter-item`) — matches reference `constants.mjs:24`.
- Two-tier extraction:
  1. **Volume walk** (primary): iterate `div.volume-item`, for each, collect `a:not(:has(svg))` inside (unlocked chapters — locked ones have an `<svg>` lock icon, matched by the `:not(:has(svg))` exclusion). Extract href via `PageHandle.getAttribute(...)`. Each link's href is normalized through `normalizeChapterUrl(url, page.url())`.
  2. **Alternative selector fallback** (reference `:218-237`): if the volume walk finds zero links, try the array in `constants.mjs:49-54` in order: `.volume-item a:not(:has(svg))`, `a.chapter-item`, `.chapter-list a`, `.catalog-content a:not(:has(svg))`. First selector that yields > 0 links wins.
- **De-dupe with insertion-ordered `Set`** (AGENTS.md §"Chapter links: de-dupe + hard cap").
- **Hard cap** `MAX_CHAPTERS = 10_000` (the existing `ChapterListService.MAX_CHAPTERS` from `src/core/services/ChapterListService.ts:25`; keeping one constant project-wide — AGENTS.md "one concern at a time" rule: don't fork constants).
- Pagination: webnovel's catalog is a single page (no paginated TOC like NovelFire's `?page=N`). Confirm via a live-page probe during implementation. If the page turns out paginated, the fallback is the volume-walk loop already covers it because it iterates every `div.volume-item` on the page (the reference's `extractChapterList` did not paginate).

**Compatibility note:** since the volume walk is also where volume-grouping data comes from, Phase 4 (`scrapeVolumes`) reuses the same walk. The two-phase split keeps each commit small but the live DOM traversal happens once at runtime by sharing the catalog-walk function between `scrapeChapterLinks` and `scrapeVolumes` (private helper, e.g. `walkCatalogVolumes(page, novelUrl): Promise<{ volumes: AutoNovelVolume[]; allUrls: string[] }>`). The adapter Page visits the catalog once per `AutoProbeScreen`/`runJob` invocation, not twice.

### Adapter Phase 4 — `scrapeVolumes`

`scrapeVolumes?(page, novelUrl, opts): Promise<AutoNovelVolume[] | undefined>`. Returns `AutoNovelVolume[]` (name + ordered chapter URLs per volume). Per ADR-P7-B, this is **the same catalog walk** as Phase 3; the difference is the return shape. The shared private helper from Phase 3 produces:
```ts
{
  volumes: AutoNovelVolume[];   // one entry per div.volume-item, in document order
  allUrls: string[];             // flattened, de-duped, capped
}
```
`scrapeChapterLinks` returns `allUrls`; `scrapeVolumes` returns `volumes`. Each `AutoNovelVolume.name` comes from the `h4` inside `div.volume-item` (reference `:162-164`). Fallback name `Volume ${index + 1}` if `h4` is missing (reference `:165` `Volume ${Date.now()}` is wrong — `Date.now()` as a volume name is a v1 bug; the safer fallback `Volume <index>` is what the reference's `epubExtractor.mjs` falls back to when reordering).

Cuts down to the volume chapters that actually pass through the de-dupe + cap: a volume's `chapterUrls` are filtered against the global `allUrls` set so volumes never contain a chapter that was dropped by de-dupe/cap. This lets the EPUB writer trust the volume map (instead of second-guessing whether each volume's URL count matches its chapter count).

### Adapter Phase 5 — `processChapterContent`

`processChapterContent?({ rawHtml, title, footnotes })` — faithful port of `reference/webnovel/contentExtractor.mjs:351-470` + the EPUB-side re-escape pass in `reference/epubGenerator/contentProcessor.mjs:42-82`.

Hook contract (matches ADR-P7-D):
- Input match for the reference's `processChapterContent(htmlContent, pageChapterTitle, footnotes)`.
- Output `{ htmlContent: string, footnotes?: Footnote[] }`.

Implementation:
1. Load `rawHtml` with cheerio (`decodeEntities: false` — reference `:353`).
2. `_cleanElement($)` — remove blacklisted tags (`pirate`, `i`) and blacklisted classes (`BLACKLISTED_CLASSES`/`BLACKLISTED_TAGS` verbatim from `constants.mjs:100-112`), then remove `.anno-drop` elements (the already-collected footnote popups).
3. For each `<p>`, find `anno[data-annotation-id] sup` and replace `<sup>` with `<a href="#footnote-<id>" class="footnote-link" id="footnote-ref-<id>">N</a>` (reference `:365-378`) where `N` is a per-paragraph footnote counter starting at 1 (NOT global — the reference restarts the counter per paragraph; re-read `:369`).
4. Strip `class`, `id`, `style` from every `<p>` (reference `:397-398`).
5. Build the footnotes HTML section (`_createFootnotesHTML` reference `:434-470`):
   - For each footnote, emit `<div class="footnote-item" id="footnote-<id>">` with `<a href="#footnote-ref-<id>" class="footnote-back-link">↩</a>` back-link.
   - Title attribute encoded with `he.encode` (reference uses the `he` package); v2 uses the existing `escXml` from `src/adapters/epub-archiver/templates.ts:5-12` (already imported where the hook will be applied), replacing the `he` dependency. **Same output bytes** — both functions emit `& < > " '`.
6. Wrap in the chapter XHTML:
   ```
   <h2 class="chapter-page-title">[safe title]</h2>
   <div class="decorative-line">━━━━━✧✧✧✧━━━━━</div>
   [paragraphs]
   <div class="ending-line">✦ ✧ ✦ ✧ ✦</div>
   [footnotes section if any]
   ```
   Byte-faithful to reference `:386-403`. The `chapter-page-title` `h2` matches the EPUB writer's `templates.ts:353` `h2.chapter-title` — they carry the same CSS — so the chapter title shows the same styling across v2 EPUBs.
7. The `contentProcessor.mjs:42-82` re-escape-of-text-nodes pass is **not** needed in v2: the v2 EPUB writer's `toXhtml()` (`templates.ts:39-50`) already escapes bare ampersands and self-closes void tags. Re-applying the reference's text-node escape would double-escape `&` to `&amp;`. Dropped as a defensible deviation — the test in Evidence Phase 3 will assert on exactly this difference (the reference's bug is v2's correctness).
8. Footnote **extraction** itself (clicking `<sup>` to collect popup contents — reference `_extractFootnotes` `:276-342`) cannot be done in `processChapterContent` because it requires live-page interaction (clicking, waiting for `.anno-drop` to appear). The adapter's `scrapeMetadata` and `scrapeChapterLinks` don't extract footnotes — they live on chapter pages. So the footnote **collection** happens in a separate adapter method `collectFootnotes(page): Promise<Footnote[]>` that runs at chapter-extraction time (Pipeline Phase 1). The flow becomes:
   - `ChapterExtractor.extract` runs first (challenge wait-out, content selector pull, exclude strip) → produces raw `Chapter.htmlContent`.
   - If the adapter has `collectFootnotes`, `ChapterExtractor` calls it now and passes the result into `processChapterContent`.
   - `processChapterContent` rewrites the `<sup>`s and emits the footnotes section.

   This requires adding `collectFootnotes?(page): Promise<Footnote[] | undefined>` to `SiteAdapter` (Scaffold Phase 3 already accounts for `processChapterContent`; this small surface addition is added during `Pipeline Phase 1` once the actual call sequence is clear — flagged here for awareness, not added to Scaffold Phase 3's signature listing as written).

**Acceptance for `Adapter`:** webnovel fixture → adapter → expected `AutoScrapeResult` (metadata + chapterLinks + volumes) and a per-chapter `processChapterContent` output whose body text and footnote HTML byte-match the reference's output for the same fixture. Fixtures committed under `tests/fixtures/sites/webnovel/`. Real-binary acceptance test (gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`) added to `tests/acceptance.test.ts` running a small real catalog.

---

## Named phase `Epub` — extend `ArchiverEpubWriter` to render Volume pages

**Goal:** the EPUB writer emits one `volume_NN.xhtml` page per volume and inserts it in the spine/NCX/nav before that volume's chapters, **byte-faithful** to the reference's `epubGenerator/tocBuilder.mjs` and `manifestBuilder.mjs`.

The decision (ADR-P7-A+C): volumes come in as `Volume[]` carrying `{ name, chapterUrls }`. The writer is the single place that resolves URL → `Chapter` → spine index — a responsibility split that keeps the adapter knowledge (DOM) cleanly separated from the writer knowledge (XML/EPUB layout).

### Epub Phase 1 — `volumeXhtml` template + manifest + spine entry

- `src/adapters/epub-archiver/templates.ts` adds:
  ```ts
  export function volumeXhtml(volume: AutoNovelVolume, index: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${escXml(volume.name)}</title>
  <link rel="stylesheet" type="text/css" href="styles/style.css"/>
</head>
<body>
  <div class="volume-page">
    <h1 class="volume-title">${escXml(volume.name)}</h1>
  </div>
</body>
</html>`;
  }
  ```
  Note: the reference also emits an "Unlocked Chapters: N" line when `unlockedChapterCount < chapterCount` (`reference/epubGenerator/contentProcessor.mjs:208-211`). That's webnovel-account-specific data (locked vs unlocked chapter counts). The `Volume` domain (ADR-P7-C) only carries `name + chapterUrls` — no locked/unlocked metadata. The volume page **omits** the unlocked-chapters line, since the v2 `Volume` shape has no locked/unlocked concept. This is a **documented deviation** from the reference and goes into `docs/phase-7/deviation-log.md` — the alternative (extending `Volume` with `unlockedChapterCount?` + `chapterCount?`) is scope creep for data v2 doesn't otherwise use.
- The `.volume-title` CSS rule already exists at `templates.ts:759-767` (the absolutely-centered one using `"Firlest", serif`). The volume page's `h1.volume-title` will use it as-is.

### Epub Phase 2 — `nav.xhtml` nested `<ol>` volume groups

`templates.ts.navXhtml(meta, chapters, hasCover, volumes?)` — add the optional `volumes` param. When `volumes` is non-empty and there is at least one volume with at least one matched chapter:
- The flat chapter `<li>` list is replaced with a nested `<ol>` per volume:
  ```xhtml
  <li>
    <a href="volumes/volume-1.xhtml">Volume 1</a>
    <ol>
      <li><a href="chapters/chapter-1.xhtml">Chapter Title</a></li>
      <li><a href="chapters/chapter-2.xhtml">Chapter Title</a></li>
    </ol>
  </li>
  ```
- Chapters not assigned to any volume fall under an `<li>Additional Chapters</li>` group (matches the reference `tocBuilder.mjs:57-71`).
- When `volumes` is empty/undefined, the flat `<li>` list is emitted as today — the existing `navXhtml` behaviour is **byte-identical** to today (test in Evidence Phase 3 asserts on this).
- Decoded titles through `html.decode(chapter.title)` -- the reference decodes entities before writing them to nav (reference `tocBuilder.mjs:47`). v2 has `escXml` instead; the call sequence is `escXml(html.decode(chapter.title))`. The v2 chapter title is already stored escaped; calling `html.decode` re-decodes entity escapes that may have been written during `processChapterContent`. Looked at carefully, this round-trip (`escXml(decode(escaped))`) preserves what the reference does today.

### Epub Phase 3 — `toc.ncx` nested `<navPoint>` volume groups

`templates.ts.tocNcx(meta, chapters, bookId, hasCover, volumes?)` — add the optional volumes param. Volume groups become nested `<navPoint>`s exactly like the reference `tocBuilder.mjs:124-176`. Play-order is sequential across volumes and chapters (volume N `playOrder` precedes its first chapter's `playOrder` by 1). "Additional Chapters" group matches reference `:180-205`.

### Epub Phase 4 — `content.opf` volume manifest + spine ordering

`templates.ts.contentOpf(meta, chapters, hasCover, bookId, volumes?, volumeManifestItems?)`:
- One `<item id="volume-N" href="volumes/volume-N.xhtml" media-type="application/xhtml+xml"/>` per volume (when present).
- Spine: for each volume, `<itemref idref="volume-N"/>` followed by `<itemref idref="ch-K"/>` for each chapter assigned to that volume, in URL-resolved order.
- Chapters not matched to any volume go into the spine after all volume groups (the reference's "extra" bucket — `manifestBuilder.mjs:160-167`).
- The `<guide>` block's `text` reference changes from `chapters/chapter-1.xhtml` to either `chapters/chapter-1.xhtml` (no volumes) or `volumes/volume-1.xhtml` (volumes, since first volume page is now the first body item — matches the reference's "first thing the reader sees after synopsis" intuition).

### Epub Phase 5 — volume <-> chapter resolution by URL membership

- `src/adapters/epub-archiver/ArchiverEpubWriter.ts` adds a `resolveVolumeGroups(chapters, volumes)` helper: builds `Map<url, Chapter>`, iterates volumes, for each `vol.chapterUrls` looks up the chapter and pushes it into the group; if a chapter URL exists in multiple volumes (shouldn't happen — the adapter's `scrapeVolumes` returns disjoint sets, but defensively), it's placed in its first-seen volume only. Unmatched chapters go into the "Additional Chapters" pseudo-group.
- The `write(chapters, meta, outputDir, filename, volumes?)` implementation:
  1. If `volumes` is undefined or empty, call today's path (no volume pages; existing `tests/epub-archiver.test.ts` still passes byte-identical).
  2. If `volumes` is provided, call `resolveVolumeGroups`, then for each volume append `volumeXhtml(vol, i)` to the archive at `OEBPS/volumes/volume-${i}.xhtml`. The `content.opf`, `nav.xhtml`, `toc.ncx` are generated with volumes passed in.
- All four template functions (`contentOpf`, `navXhtml`, `tocNcx`, `volumeXhtml`) get the optional `volumes` parameter; existing call-sites in `ArchiverEpubWriter.write` pass `undefined`/omitted when there are no volumes (the v2 EPUB writer for WTR-Lab and NovelFire falls through the "no volumes" path).

**Acceptance for `Epub`:** a fixture-driven test (Evidence Phase 3) builds an EPUB with three volumes containing a total of 10 chapters and asserts:
- The archive contains `OEBPS/volumes/volume-1.xhtml`, `volume-2.xhtml`, `volume-3.xhtml`.
- `content.opf` manifest lists all three volume items + all 10 chapter items.
- `content.opf` spine ordering is `volume-1, ch-1, ch-2, ch-3, volume-2, ch-4, ch-5, ..., volume-3, ch-8, ch-9, ch-10`.
- `nav.xhtml` has three nested `<ol>` volume groups.
- `toc.ncx` has three nested `<navPoint>` volume groups, with chapter `<navPoint>`s nested inside.
- A second test builds an EPUB with no volumes (WTR-Lab-style) and compares against a known-good byte-string produced **today** (regression baseline captured before this phase). This proves ADR-P7-A's no-behaviour-change claim for the existing sites.

---

## Named phase `Pipeline` — wire volumes through the ScrapeService / runJob / TUI flow

**Goal:** the volume map produced by `Adapter` flows from discovery through to `EpubWriter` without manual plumbing. The existing WTR-Lab and NovelFire flows are unchanged because the new seam is all optional.

### Pipeline Phase 1 — `ChapterExtractor` invokes `SiteAdapter.processChapterContent`

`src/core/services/ChapterExtractor.ts` `extract()` method — port the post-extraction hook:
- `ChapterExtractor` constructor gains a private optional `siteAdapter?: SiteAdapter` field (set by `ScrapeService`).
- After the existing `page.innerHTML(opts.contentSelector, 8_000)` call at `:178` (and after the existing cheerio post-processing), when `siteAdapter?.processChapterContent` is set, call it with the raw HTML + chapter title + footnote data (if `siteAdapter.collectFootnotes` is set, call it first and pass results).
- Replace the local `clean = sanitizeHtml(...)` path: when the adapter hook is present, the hook's returned `htmlContent` **bypasses** `sanitizeHtml` (the webnovel adapter has already applied its own allow-list via the blacklist). The hook returns content the EPUB writer can pass through `toXhtml()`. When the adapter hook is absent, `sanitizeHtml` runs as today.
- The `footnotes` from `processChapterContent`'s return value are appended to the chapter's `Chapter.htmlContent` by the hook itself (no separate EPUB-side handling needed) — the hook is responsible for emitting the `<div class="footnotes-section">` block into `htmlContent`. The `Chapter` domain doesn't change.
- `SecurityChallengeError`, retry/wait math, challenge detection in `extract()` are **untouched** — the hook runs after challenge-wait-out succeeds, not before.

### Pipeline Phase 2 — `ScrapeService.run` accepts `volumes?` and forwards to `EpubWriter`

- Add `volumes?: Volume[]` as an optional argument to `ScrapeService.run(job, cookies, resume, volumes?)` — does not break existing callers (`runJob.ts` continues to work until Pipeline Phase 3 plumbs it through).
- `ScrapeService.run` forwards `volumes` to `this.deps.epub.write(chapters, job.metadata, job.outputDir, job.outputFilename, volumes)` at `src/core/services/ScrapeService.ts:286-291`. When `volumes` is undefined, the existing output emerges unchanged.
- Resume (`resume?.session`): the session's `volumes` are restored to the new run via `ScrapeSession.volumes` (Scaffold Phase 4 added the field). A resumed job that originally had volumes keeps emitting volume pages on its second run.
- The `JsonSessionStore.save()` already persists every session field; `volumes` round-trips as part of `ScrapeSession` no extra save logic (Scaffold Phase 4 added the migration that treats unknown/missing `volumes` as `undefined`).

### Pipeline Phase 3 — `runJob` propagates `job.volumes` from `AutoScrapeResult.volumes`

`src/app/runJob.ts` is the composition root that already passes `job.chapterLinks` from discovery (read `:54-56`). The `discoverJobChapters` function returns `string[]` of URLs; that's the discovery seam v2 already uses.

Two design choices for the volume pipeline:
- **Option A (preferred):** `discoverJobChapters` learns to return `{ urls, volumes }`. The signature changes from `Promise<string[]>` to `Promise<{ urls: string[]; volumes?: AutoNovelVolume[] }>`. The single caller, `runJob.ts`, propagates `volumes` to `job.volumes` and `chapterLinks` to `job.chapterLinks`.
- **Option B:** `AutoProbeScreen` (TUI) and `runJob` separately call `siteAdapter.scrapeVolumes` after `discoverJobChapters` returns. A double-browser traversal cost: once for chapters, once for volumes. Reject — Adapter Phase 4 already shares the catalog walk private helper so that adapter `scrapeChapterLinks` + `scrapeVolumes` together cost one browser-traversal session.

So `discoverJobChapters` is changed to **Option A**, returning `{ urls, volumes }`. `runJob.ts` sets `job.chapterLinks = result.urls` and `job.volumes = result.volumes`.

### Pipeline Phase 4 — TUI `AutoProbeScreen` attaches volumes to the JobConfig

`src/adapters/ui-clack/screens/AutoProbeScreen.ts` (refer to `src/app/tui.ts:43`) runs `siteAdapter.scrapeMetadata` + `siteAdapter.scrapeChapterLinks`. After Adapter Phase 1+4 land, it additionally invokes `siteAdapter.scrapeVolumes` (if present) and includes `volumes` in the resulting `AutoScrapeResult` it builds. `AutoCustomizeScreen`'s JobConfig flows the `volumes` field down to `runJob`. The ChapterListScreen review phase (`docs/03-tui-design.md` §2.8) shows the volumes summary when present — a per-volume line like "Volume: [name] — N chapters" in the review list — minor frontend-only addition, no domain change.

**Acceptance for `Pipeline`:** end-to-end test in `tests/scrape-service.test.ts` or a new `tests/webnovel-pipeline.test.ts` that:
- Runs a `FakeBrowserPort` against a static fixture (webnovel catalog + a few chapter pages, under `tests/fixtures/sites/webnovel/`).
- Confirm `Volume[]` flows from `discoverJobChapters` through `ScrapeService.run` to `ArchiverEpubWriter.write`.
- The resulting EPUB contains `OEBPS/volumes/volume-1.xhtml` matching the fixture's catalog volume structure.

---

## Named phase `Evidence` — docs + tests locking the behaviour in

**Goal:** the work is durable against layout drift and the next発 site adapter can pattern-match on this work.

### Evidence Phase 1 — `docs/02-site-adapters.md` §3 webnovel cookbook entry

Per `docs/sites/adding-a-site.md` last section: "Update the cookbook in the same commit that adds or fixes an adapter - it's the only place site-specific selector evidence lives." This phase adds the §3 webnovel entry to `docs/02-site-adapters.md`, mirroring §1 (WTR-Lab) and §2 (NovelFire) structure:
- URL match regex
- TOC URL pattern (`/catalog`)
- Metadata selectors with fallbacks (table)
- Chapter list extraction walk (volume-walk + alternative selectors), de-dupe, hard cap
- Volume extraction (per-`div.volume-item` walk)
- `defaultContentSelector: "div.cha-words"`, `defaultTitleSelector: "h1.dib.mb0.fw700.fs24.lh1\\.5, h1.chapter-title, .j_chapterName"`, `defaultSeparateTitle: true`, `defaultExcludeSelectors: [".para-comment", ".cha-hr", ".cha-info", ".icon", ".j_bottom_comment_area", ".user-links-wrap"]` (from reference `constants.mjs:100-110`).
- String evaluate rule note (per `02-site-adapters.md` §1.7 / §2.6) — webnovel's adapter uses `PageHandle.evaluateScript` for the AUTHOR_SCRIPT, FOOTNOTE_COLLECT script, and CHAPTER_LIST script.
- "Verified <date>" stamp once the live-site probe in Evidence Phase 2 confirms selectors still resolve.

### Evidence Phase 2 — parity tests for `WebnovelAdapter` against static fixtures

- `tests/webnovel-adapter.test.ts`:
  - `scrapeMetadata` against `tests/fixtures/sites/webnovel/metadata.html` — assert title/author/description/cover match expected values captured from a live page.
  - `scrapeChapterLinks` against `tests/fixtures/sites/webnovel/catalog.html` — assert returned URLs match the expected 50+ link list captured from the live catalog.
  - `scrapeVolumes` against the same fixture — assert returned volumes `[{name, chapterUrls}]` shape and length match the catalog's visible volume structure.
  - `processChapterContent` against `tests/fixtures/sites/webnovel/chapter.html` — assert the processed HTML matches the expected output HTML file byte-for-byte (the expected output is the reference contentExtractor's output on the same fixture, captured once during adapter implementation).
  - `collectFootnotes` against `tests/fixtures/sites/webnovel/chapter-with-footnotes.html` — assert the footnote array matches the expected content captured from the live page.
- These tests use `FakeBrowserPort` + `FakePage` (refer to AGENTS.md §"Testing" — "Prefer `FakeBrowserPort`/`FakePage` (`adapters/store-memory/FakeBrowserPort.ts`) for unit tests of core services"). No real browser, no network.
- A real-binary acceptance test in `tests/acceptance.test.ts` (gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`) scrapes a small real catalog end-to-end — matches AGENTS.md's "Real-binary tests ... belong in `tests/acceptance.test.ts`".

### Evidence Phase 3 — parity tests for `ArchiverEpubWriter` with volumes

- Extend `tests/epub-archiver.test.ts` with:
  - "V1 parity puzzle: no volumes -> byte-identical output": capture baseline EPUB bytes today; run the v2 webnovel-port EPUB path with `volumes: undefined` and assert byte-identical (regression guard for ADR-P7-A "no behaviour change for existing sites").
  - "Volume pages: structure test": build an EPUB with 3 volumes + 10 chapters; assert the zip listing contains all 3 `OEBPS/volumes/volume-N.xhtml` entries; assert `content.opf` spine ordering is volume-1, ch-1, ch-2, ch-3, volume-2, ch-4, ch-5, ..., volume-3, ch-8, ch-9, ch-10.
  - "Volume pages: nav.xhtml nested-ol structure test": build the EPUB and assert `OEBPS/nav.xhtml` contains 3 nested `<ol>` groups, one per volume, each with chapter `<li>`s.
  - "Volume pages: toc.ncx nested-navPoint structure test": same as above for `OEBPS/toc.ncx`.
  - "Additional Chapters bucket": a volume set missing one chapter's URL; assert that chapter falls into the EPUB spine after all volume groups (matches reference `manifestBuilder.mjs:160-167`).
  - "Volume page title from volume.name": assert `volume-1.xhtml` contains `h1.volume-title` text matching `volumes[0].name`.
  - All assertions use the existing `zipListing` / `zipRead` python helpers present at `tests/epub-archiver.test.ts:43-63` (no new test infra).

### Evidence Phase 4 — `docs/phase-7/deviation-log.md` if implementation diverges

The webnovel port becomes "Phase 7" in the docs/phase-N series (Phase 6 was the closing-out phase per `docs/04-implementation-roadmap.md`). Created at `docs/phase-7/`:
- `readme.md` — design proposal (this document, copied in or referenced).
- `adr.md` — the ADR-P7-A through ADR-P7-D decisions recorded once code lands.
- `deviation-log.md` — entries for any place where the implementation diverged from this design doc for a good reason. Known deviations already flagged:
  - D1 — Volume page omits "Unlocked Chapters: N" line (Epub Phase 1 explanation).
  - D2 — Adapter `scrapeVolumes` and `scrapeChapterLinks` share a single private `walkCatalogVolumes` helper (Adapter Phase 3+4 explanation).
  - D3 — `processChapterContent` doesn't re-escape text nodes (Adapter Phase 5 step 7 explanation — v2's `toXhtml()` already handles ampersand escaping).
  - D4 — Volume fallback name uses `Volume <index>` instead of `Volume <Date.now()>` (Adapter Phase 4 explanation — v1 bug not ported).
  - D5 — `collectFootnotes` separated from `processChapterContent` because it needs live-page interaction (Pipeline Phase 1 explanation).
- Each deviation gets a Dn entry with context, decision, evidence — matching the format of `docs/phase-*/deviation-log.md`.

**Acceptance for `Evidence`:** every test green. recipe / fixture list committed. `docs/02-site-adapters.md` carries the webnovel evidence. `docs/phase-7/` exists with the ADRs and (if applicable) deviation log.

---

## Cross-cutting instructions

These rules apply across all phases. None is negotiable; an implementation that violates them is rejected during review.

### Hexagonal boundary

- The `WebnovelAdapter` lives in `src/adapters/site-webnovel/`. It imports only from `src/core/domain/`, `src/ports/`, and cheerio. It does **not** import from `playwright-core`, `fs`, `got` (the URL resolver uses `got` via a tiny pair-function in `urlUtils.ts` only if a shortlink is found; the binary-clean path never imports `got` at module top-level — lazy import matches `ArchiverEpubWriter.ts:23-29`).
- The EPUB writer's volume support lives entirely in `src/adapters/epub-archiver/`. It imports from `src/core/domain/` only — no Playwright, no SiteAdapter import.
- No `console.log` in any new code (`WebnovelAdapter` emits progress through `log: Logger`). The EPUB writer emits through `this.log: Logger`.

### Manifest constants

- `MAX_CHAPTERS = 10_000` (matches `ChapterListService.MAX_CHAPTERS`) — Adapter Phase 3 hard cap. Do not introduce a separate webnovel-specific cap.
- `DEFAULT_RATE_LIMIT_DELAY = 750` (from reference `constants.mjs:145`) is **not ported as its own constant** — v2's `JobConfig.delayMin` / `delayMax` already own this, with `ScrapeService`'s `delay(randomInt(job.delayMin, job.delayMax))` at `ScrapeService.ts:148`. Adapter never sleeps.
- `TIMEOUTS.*` constants are **not ported** as adapter-specific timeouts. v2's nav timeout is 30s by convention (`DiscoveryService.ts:66`, `WtrLabAdapter.ts:78`); the reference's 90s chapter content timeout maps to the `PageHandle.innerHTML(selector, 8_000)` call, which has its own 8s timeout for innerHTML extraction (the standard v2 timeout for a single DOM read).

### String-evaluate rule (AGENTS.md "page.evaluate() string-constant rule")

The adapter's `PageHandle.evaluateScript` calls all use plain string constants:
- `AUTHOR_SCRIPT` — author extraction via `address div.ell span` (reference `:52-56`).
- `CHAPTER_LIST_SCRIPT` — `Array.from(document.querySelectorAll(".volume-item a:not(:has(svg))")).map(a => a.href)` for the volume-walk fallback (reference `constants.mjs:24` selector).
- `FOOTNOTE_COLLECT_SCRIPT` — the footnote collector; this one is trickier because the reference interacts (clicks `<sup>`, waits for `.anno-drop`, reads content, closes popup). v2's `PageHandle` has no generic `evaluate(fn)` — only `evaluateScript(string)`. The footnote collection script is therefore itself a single string async-IIFE that does the click-wait-collect loop entirely browser-side. Implementation detail worked out in Adapter Phase 5 / Pipeline Phase 1; design flag here.

### Testing

- Every browser-touching unit test uses `FakeBrowserPort` / `FakePage` (per AGENTS.md §"Testing"; one already-mentioned seam in `src/adapters/store-memory/FakeBrowserPort.ts`).
- Parity fixtures are committed under `tests/fixtures/sites/webnovel/` for the static HTML cases (catalog, metadata page, chapter page, chapter page with footnotes) and under `tests/fixtures/epub/webnovel-3-vols-10-chapters/` for the multi-volume EPUB expected output.
- Real-binary acceptance tests (gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`) are in `tests/acceptance.test.ts` — unreachable in normal `pnpm test`.
- New tests added in:
  - `tests/webnovel-adapter.test.ts` (Evidence Phase 2)
  - Extension of `tests/epub-archiver.test.ts` (Evidence Phase 3)
  - Extension of `tests/session-store.test.ts` for the v1-session-without-volumes migration (Scaffold Phase 4)
  - Extension of `tests/scrape-service.test.ts` for the adapter-hook path (Pipeline Phase 1)
- No `tests/phase-7-sweep.test.ts` — there is no `playwright` import to sweep because the adapter never imports from `playwright` or `playwright-core` (only `PageHandle` from `src/ports/BrowserPort.ts`). The existing `tests/phase-6-sweep.test.ts` continues to enforce the "no new `playwright` import" rule project-wide.

### Code-style + tooling

- Run `pnpm typecheck` and `pnpm test` after every commit. Phase is not done until both are green.
- Run `pnpm lint` (ESLint flat config); fix any errors before committing.
- Run `cd server && npx prettier --write .` is not applicable (no `server/`) — instead run `npx prettier --write .` at the repo root if a prettier config exists; AGENTS.md says "always run Prettier before committing" without specifying a path.
- No em dashes (`—`/`-`) in any UI text, strings, comments, commit messages, or PR description (AGENTS.md §"Code Style"). Use regular hyphen (`-`), colon (`:`), or rephrase. (This design doc uses em dashes for readability — they are NOT to be copied into code comments or user-facing strings.)
- No comments except where the logic is genuinely non-obvious (AGENTS.md §"Code Style").
- No `process.exit`, no `console.log` outside the CLI entry point.
- Errors flow through `SecurityChallengeError` for bot-detection; other errors bubble up through the existing `ScrapeService` retry loop — never catch and continue silently.

### Implementation order

The phases are listed in dependency order:
1. `Scaffold` is a pure prerequisite for every other phase — no code work elsewhere can begin until the types exist.
2. `Adapter` and `Epub` can be developed in parallel after `Scaffold` — they touch different files, no merge conflicts.
3. `Pipeline` requires `Adapter` and `Epub` to be merged — it's the integration phase.
4. `Evidence` runs alongside every code phase — tests written in the same commit as the feature they cover, not after.

A single PR carries one phase at a time. `Scaffold` may end up as a single commit (no functional behaviour); `Adapter` likely splits into one commit per Phase (1=skeleton, 2=metadata, 3=chapterLinks, 4=volumes, 5=processChapterContent); `Epub` likely splits into one commit per Phase; `Pipeline` likely one commit per Phase; `Evidence` is mixed into each code commit plus a final consolidation.

### Compatibility + migration

- Existing v2 job files without `volumes:` field continue to work — `volumes?: Volume[]` is additive-optional (AGENTS.md "Schema additions are additive-optional only").
- v1 session files (no `volumes`) auto-migrate (Scaffold Phase 4) — no user manual step, no data loss (`docs/05-migration-guide.md` §1).
- WTR-Lab and NovelFire EPUB output is byte-identical to today (Evidence Phase 3 regression test).
- WTR-Lab and NovelFire adapter code is unchanged (the new optional `scrapeVolumes`, `processChapterContent`, `collectFootnotes` aren't implemented by either adapter; they default to `undefined` and the venerable flow runs).

### Rollback

Each named phase is independently revertable:
- `Epub` reverted → EPUB writer is back to today's surface. Webnovel still produces chapters + metadata; volumes are dropped on the floor (the adapter's `scrapeVolumes` call returns the data but no-one consumes it). EPUB still builds (without volume pages). The experiment can be deferred without a code change.
- `Adapter` reverted → adapter no longer registers; v1 webnovel flows (none currently) are unchanged. The cookbook entry stays as the evidence for any future re-implementation.
- `Pipeline` reverted → `ChapterExtractor` calls `sanitize-html` as today; webnovel adapter's `processChapterContent` is unused. The EPUB output for webnovel has generic-cleaned chapter HTML (footnotes absent, no decorative lines, no footnote links). Still a valid EPUB, just doesn't match the reference.
- `Scaffold` reverted → all of the above are reverted; `Volume` type and `EpubWriter` port revert to today's surface. No-half-revert tail risk because `Scaffold` is type-only.

---

## Open items requiring follow-up (outside this design's scope)

- Whether `AutoNovelMetadata` should grow a `subjects?: string[]` field for webnovel's tag extraction (reference `:90-110`). Out of scope per Adapter Phase 2; flagged for post-parity backlog.
- Whether v2 EPUB should emit `<dc:subject>` for any site's tags. The EPUB writer's `content.opf` template (`templates.ts:140-152`) doesn't include `dc:subject` today. Out of scope per Adapter Phase 2.
- Per-site CSS injection (a future where webnovel wants a different stylesheet than WTR-Lab). Currently `templates.ts.stylesheet()` is the only stylesheet injected. Out of scope; flagged for post-parity backlog (`docs/04-implementation-roadmap.md` "EPUB theme packs").
- The Phase 4 TUI ChapterListScreen volume-summary rendering (Pipeline Phase 4 mentions it in passing). It's a small frontend addition; the design treats it as one-line addition per volume in the existing list, but the exact UX (does the user want to collapse/expand volumes, or just see counts) is a TUI-design decision deferred to Pipeline Phase 4 review.
- A future `footnote` test-rig comparing the webnovel adapter's `processChapterContent` output against the reference `contentExtractor.mjs.processChapterContent` output for a shared input fixture. The fixture is one of the static HTML pages under `tests/fixtures/sites/webnovel/chapter-with-footnotes.html`; the expected output is captured from running the reference once on the same fixture. The test asserts byte-identical output modulo the differences documented in Adapter Phase 5 step 7 (text-node re-escape) and the `he.encode` → `escXml` substitution.
