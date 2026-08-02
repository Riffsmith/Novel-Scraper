# 00 — Current-State Audit

This document is an evidence-based inventory of every feature already implemented in WebNovel Scraper v1.0.0.
It exists so the v2 rewrite has a **parity checklist**: nothing on this list may be dropped without an explicit
decision recorded in `01-architecture-decisions.md`.

## 1. Verified Feature Inventory

> Verified by reading every file in `src/` (30 TypeScript modules, ~7,123 LOC).

| Area | Feature | Location | Notes for the roadmap |
|------|---------|----------|----------------------|
| **Scraping engine** | TOC mode (chapter-list → auto-discover links) | `src/scraper/toc.ts` | Filters `NON_CHAPTER_PATTERNS`, follows `<a rel="next">` pagination, dedupes by URL. |
| | Sequential mode (first+last URL, walk Next-button chain) | `src/scraper/sequential.ts` | Strategy A: direct `href` resolution. Strategy B: click + wait for navigation. |
| | 3 locator kinds: CSS / XPath / Regex text match | `src/scraper/selectors.ts`, `sequential.ts` | Regex tested against `a.textContent` **and** `title` attr. |
| | Ordered fallback locator chain | `sequential.ts:23-52` | Index>0 usage logged as warning. |
| | CSS **and** XPath for content/title/exclusions | `selectors.ts` | XPath auto-detected by `//`, `(//`, or `xpath=` prefix. |
| | Exclusion selectors removed from live DOM | `selectors.ts:72-107` | Runs before extraction, so cheerio and XPath paths see the same cleaned DOM. |
| | Anti-bot interstitial detection & wait-out | `scraper/chapter.ts:15-130` | Title regexes + body regexes (only when body < 2,000 chars) + DOM markers (Cloudflare). 30 s max wait. |
| | Content sanitisation (allow-list, style filter) | `scraper/chapter.ts:132-185` | `sanitize-html` with restricted tags/attrs; strips hidden/aria-hidden nodes. |
| | Title extraction + fallback to `<title>` | `chapter.ts:244-296` | Optional separate title selector removed from body to avoid duplication. |
| **Browser & stealth** | CloakBrowser launch (source-patched Chromium) | `scraper/browser.ts:41-87` | Singleton for scraping; ephemeral headed instances for login capture. |
| | `humanize` Bézier mouse + `humanPreset` | `browser.ts`, `config/appConfig.ts:79-83` | ~20–40 % slower; used for behavioural bot scoring. |
| | `fingerprintSeed` deterministic identity | `browser.ts:58-63` | Passed to CloakBrowser as `--fingerprint=<int>`. |
| | Resource blocking (ads, trackers, media, fonts) | `browser.ts:181-202` | Done at `context.route('**/*')`. |
| | Locale/timezone injection + headers | `browser.ts:165-178` | `Accept-Language`, `Accept`, `DNT`, `Upgrade-Insecure-Requests`. |
| | Request jitter (`delayMin`–`delayMax`) | `queue/index.ts:122` | Also used in sequential TOC walking (reduced 0.3–0.4×). |
| **Concurrency & resilience** | `p-queue` parallel context pool | `queue/index.ts:106-115` | One `BrowserContext` per worker slot, cookies injected once per context. |
| | Per-task retry with exponential backoff | `queue/index.ts:139-154` | `retries * delayMax` backoff. |
| | Longer backoff on `SecurityChallengeError` | `queue/index.ts:20,159-167` | 45 s fixed multiplier. |
| | TUI progress bar (`cli-progress`) | `tui/display.ts:54-68` | Shows chapter index and ETA. |
| **Resumability** | Checkpoint before first chapter + throttled saves | `index.ts:216-233`, `queue/index.ts:86-101` | Every 4 s while running; forced save at end. |
| | Resume picker (main menu) | `tui/sessionManager.ts` | Lists by updatedAt, includes progress counts. |
| | URL-match auto-resume offer | `index.ts:419-442` | On exact `entryUrl` match; includes a "discard" option. |
| | Completed chapters never re-downloaded | `queue/index.ts:67-77` | Slots seeded by original 1-based index, preserving EPUB order. |
| | SIGINT/SIGTERM/uncaughtException checkpoint flush | `sessions/active.ts`, `index.ts:67-100` | Session file is deleted **only** after EPUB is built. |
| **Site adapters** | `SiteAdapter` interface + registry | `sites/types.ts`, `sites/index.ts` | `matches()`, `getTocUrl()`, `scrapeMetadata()`, `scrapeChapterLinks()`. |
| | WTR-Lab adapter | `sites/wtrLab.ts` | Lazy batch-expander script, numeric URL reordering. |
| | NovelFire adapter | `sites/novelfire.ts` | `?page=N` walker with repeat-detection. |
| | 2-confirmation auto-scrape fast path | `index.ts:719-828` | Full customization path falls back to `gatherAutoConfig`. |
| **Cookies** | Per-domain, named multi-profile store | `cookies/store.ts` | XDG_DATA_HOME; auto-migrates legacy flat arrays. |
| | Browser-login capture (headed ephemeral) | `cookies/capture.ts` | `begin/finish/abort` API keeps TUI in control of prompts. |
| | Manual entry (raw header or k/v) | `tui/cookieManager.ts` | Merges by name into existing profile. |
| | Auto-resolution at scrape time | `tui/cookieManager.ts:selectCookieProfileForScrape` | 0→none, 1→auto, N→picker with cookie counts + lastUsed. |
| **Config & profiles** | JSON config with defaults and unknown-key preservation | `config/appConfig.ts` | 16 documented keys. |
| | Per-domain site profiles (method, selectors, perf) | `config/siteProfiles.ts` | Saved only on first successful scrape or via settings menu. |
| | In-app settings editor + profile manager | `tui/configManager.ts` | View/edit/delete profiles; edit global config. |
| | Post-scrape "save profile?" prompt | `index.ts:298-323` | Controlled by `askSaveProfile`. |
| **EPUB 3 output** | Standards-compliant (OPF, nav, NCX, container, mimetype) | `epub/builder.ts` | Mimetype stored uncompressed and first. |
| | Cover (URL download / local file) + title page + synopsis | `builder.ts:59-126` | Cover failure is non-fatal. |
| | Embedded font (FoglihtenNo07 subset) + reader CSS | `epub/templates.ts`, `assets.ts` | Registered in `content.opf` manifest. |
| | Per-chapter XHTML | `templates.ts` via `chapterXhtml()` | Sanitised HTML from scraper passed through `toXhtml()`. |
| **TUI & logging** | Wizard with back-navigation (`WizardBack`) | `tui/wizard.ts` | `step()` wrapper makes Escape safe; `runWizard()` supports skip(). |
| | Global Ctrl+Q / Ctrl+C from any prompt | `tui/keys.ts` | Monkey-patches `Enquirer.prototype.ask`. |
| | Quit-during-scrape key (`q`) | `tui/scrapeKeys.ts` | Active only while progress bar is running. |
| | Chapter-list review/edit before scrape | `tui/prompts.ts:1197-1294` | Remove by index/range, add URLs, reverse, view. |
| | Winston logs: combined/error/exceptions/rejections | `logger/index.ts` | Rotating files in `./logs/`. |
| | Colored console output (`chalk`) + spinners (`ora`) | `tui/display.ts` | Fixed-width tags avoid emoji-font misalignment. |
| **Packaging/DX** | ESM TypeScript, `tsx` dev, `tsc` build | `package.json` | `wnscrape` bin via `npm link` after build. |

## 2. Metrics

- **Source LOC:** 7,123 lines of TypeScript (excluding `dist/`, `node_modules/`).
- **Entry-point weight:** `src/index.ts` alone is 864 lines (12 % of all code).
- **Largest UI file:** `src/tui/prompts.ts` — 1,294 lines (two near-duplicate wizards + chapter editor).
- **TUI helpers:** 9 files, ~2,600 lines.
- **Stray directories:** 12 empty dirs in `src/` with literal brace names (e.g. `{types,logger,scraper,queue,epub,tui`) — harmless build artifacts of a bad `mkdir` command; delete during Phase 0.

## 3. Architectural Problems (evidence)

| # | Problem | Evidence | Impact |
|---|---------|----------|--------|
| P1 | **Fragile keyboard layer** | `tui/keys.ts:14-56` patches `Enquirer.prototype.ask` and copies the private `lib/combo.js` ctrl map. Comment: *"none of the above is documented public API."* | Any enquirer upgrade can silently break Ctrl+A/W/U. |
| P2 | **Three prompt wrappers** | `step()` (`tui/wizard.ts:35`), raw `_prompt` (`tui/cookieManager.ts:50`), and `prompt` imported from `prompts.ts` into `index.ts:13`. | Escape/cancel behavior is inconsistent between screens. |
| P3 | **God-file orchestration** | `index.ts` handles menus, browser lifecycle, cookie selection, session persistence, and resume routing. | Hard to test; changing menus risks scraping logic. |
| P4 | **esbuild/tsx `__name` footgun** | `sites/wtrLab.ts:61-73` and `sites/novelfire.ts:134-140` require `page.evaluate` scripts as **strings**, because tsx `keepNames` wraps functions with `__name()` that doesn't exist in browser scope. | Contributors will hit a `ReferenceError` unless this is documented and enforced. |
| P5 | **Duplicated wizard logic** | `gatherConfig` and `gatherAutoConfig` share ~60 % of their steps but are separate functions in one 1,294-line file. | Any selector change must be made twice. |
| P6 | **No CLI / non-interactive mode** | Entry point immediately calls `mainMenu().catch(...)`. | Cannot be scripted, scheduled, or used in CI. |
| P7 | **Tight coupling to Playwright `Cookie` type** | `tui/cookieManager.ts`, `queue/index.ts`, `sessions/store.ts` all import `Cookie` from `playwright`. | Prevents swapping browser drivers and leaks adapter types into core. |

## 4. Data Schemas (must remain readable after migration)

- `~/.config/webnovel-scraper/config.json` — `AppConfig` (see `src/types.ts:12-56`).
- `~/.local/share/webnovel-scraper/cookies.json` — `Record<domain, Record<profile, CookieProfile>>`.
- `~/.local/share/webnovel-scraper/site-profiles.json` — `Record<domain, SiteProfile>`.
- `~/.local/share/webnovel-scraper/sessions/*.json` — `ScrapeSession` (see `src/types.ts:188-203`).
- `./logs/` — combined, error, exceptions, rejections.
- `./output/` — generated EPUBs.

> **Parity rule:** Any schema change must read the old format and migrate transparently.
