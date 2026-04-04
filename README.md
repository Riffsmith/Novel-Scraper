# WebNovel Scraper (Vibe Coded)

**Elite TUI-based web novel scraper → EPUB packager**

Playwright-powered, stealth-layered, concurrency-controlled scraper with a clean terminal UI. Scrapes web novel and packages it into a polished, standard-compliant EPUB 3 file.

---

## Features

| Capability | Details |
|---|---|
| **Two scraping modes** | TOC URL auto-discovery *or* sequential next-button navigation |
| **Three locator kinds** | CSS selector, XPath expression, or Regex text match for next-button |
| **Fallback locator chain** | Priority-ordered list; fallback fires only when every higher locator fails |
| **Full stealth** | `playwright-extra` + stealth plugin — webdriver flag, canvas noise, plugin spoofing, permissions |
| **Resource blocking** | Ads, trackers, fonts, media blocked at network layer |
| **Concurrency queue** | `p-queue` — N parallel browser pages with exponential-backoff retry |
| **Human-like delays** | Configurable jitter range between every request |
| **Smart extraction** | Cheerio + `sanitize-html`; CSS and XPath selectors everywhere |
| **EPUB 3 output** | Nav document, NCX (EPUB 2 compat), OPF, per-chapter XHTML, CSS, cover, title page |
| **Cookie store** | Per-domain persistent cookies in XDG_DATA_HOME — paste a `Cookie:` header once, reuse forever |
| **Site profiles** | Per-domain extraction presets saved after first scrape — selectors pre-fill on return visits |
| **Global config** | XDG_CONFIG_HOME/webnovel-scraper/config.json — fully documented, editable in-app or by hand |
| **TUI** | `enquirer` prompts, `ora` spinners, `cli-progress` bars, `chalk` colour |
| **Logging** | `winston` — pretty console + rotating file transports, level controlled from settings |

---

## Requirements

- **Node.js** ≥ 18.0
- **pnpm** ≥ 9.0
- Chromium (installed automatically by Playwright)

---

## Installation

```bash
git clone <repo-url> && cd webnovel-scraper

pnpm install
pnpm exec playwright install chromium

```

---

## Usage

```bash
# Development (TypeScript, no build step)
pnpm dev

# Production
pnpm build && pnpm start

# Global install
pnpm build && npm link   # adds `wnscrape` to PATH
wnscrape
```

---

## Main Menu

```
  What would you like to do?
  ❯ 📖  Start a new scrape → EPUB
    🍪  Manage saved cookies
    ⚙   Settings & site profiles
    ✖   Quit
```

---

## Scraping Modes

### TOC URL
Point the scraper at the novel's chapter-list page. It loads the page (following TOC pagination if present), extracts and filters all same-origin chapter links, then lets you review/edit the list before scraping.

### Sequential navigation
Provide the first and last chapter URLs plus a locator for the "Next Chapter" button. The scraper walks the chain collecting URLs, then scrapes in parallel.

---

## Next-Button Locator Kinds

All three kinds are available for the primary locator and any fallbacks.

### CSS selector
Standard CSS. The most reliable option when the button has a unique class or `rel` attribute.
```
.btn-next
a[rel="next"]
#nextchap
p.navigation > a:last-child
```

### XPath expression
Use when there is no good CSS hook but the DOM structure is predictable.
```
//a[contains(@class,"next")]
//p[@class="has-text-align-center"]/a[last()]
//a[@title and contains(@title,"Next")]
```
Enter with or without the `xpath=` prefix — both are accepted.

### Regex text match
Scans every `<a href>` on the page and matches against the element's **visible decoded text** and **title attribute**. Use when the button has no stable class/id but always has the same label.

```
>>                        matches the >> link text literally
^\s*>>\s*$               anchored: entire link text is >>
Next\s*Chapter            matches "Next Chapter", "NextChapter", etc.
下一章                    CJK — use flag: u or iu
```

> **Important:** The regex tests `a.textContent` (decoded, normalised), not HTML source. Do not write `&gt;&gt;` or `<a href=...>` patterns — write what you would *see* in the browser.

Recommended flags: `i` for Latin text (default), `u` for Unicode/CJK, `iu` for both.

### Fallback chain
After entering the primary locator you can add fallbacks. On each page the engine tries them in order; the first match wins. A warning is logged whenever index > 0 fires, so you can audit which chapters used a different layout.

---

## Content & Title Selectors

All selector fields (content container, title element, exclusions) accept both CSS and XPath:

```
CSS:   .chapter-content
CSS:   #chapter-body
XPath: //div[@class="chapter-body"]
XPath: xpath=//article/div[1]
```

---

## Cookie Manager

Reach via main menu → **🍪 Manage saved cookies**.

Cookies are stored in `$XDG_DATA_HOME/webnovel-scraper/cookies.json` (Linux), `~/Library/Application Support/webnovel-scraper/cookies.json` (macOS), or `%APPDATA%\webnovel-scraper\cookies.json` (Windows).

**Adding cookies — easiest method:**
1. Log in to the novel site in your browser
2. Open DevTools → Network → any request → Headers → copy the `Cookie:` value
3. In the Cookie Manager, select the domain → "Paste raw Cookie: header"
4. Done — cookies are injected into every browser context automatically

Cookies are loaded per-domain: if the entry URL is `www.webnovel.com`, the store key `webnovel.com` is matched automatically.

---

## Site Profiles

After successfully scraping a domain for the first time, the scraper asks whether to save the extraction settings as a reusable profile (controlled by `askSaveProfile` in global settings).

On return visits, the profile pre-fills:
- Scraping method
- Content selector, title toggle, title selector, exclusion selectors
- Next-button locators (shown with use/override choice)
- Per-site performance overrides (concurrency, delay range)

Profiles are stored in `$XDG_DATA_HOME/webnovel-scraper/site-profiles.json`.

Manage profiles via main menu → **⚙ Settings → 🗂 Site Profiles**: view, edit selectors, edit performance, or delete.

---

## Global Configuration

File: `$XDG_CONFIG_HOME/webnovel-scraper/config.json`  
(Linux default: `~/.config/webnovel-scraper/config.json`)

Created automatically on first run with all defaults. Edit in-app via **⚙ Settings → 🌐 Global Settings** or open the JSON file directly. Unknown keys are preserved across in-app writes.

| Setting | Default | Description |
|---|---|---|
| `defaultOutputDir` | `./output` | Where EPUBs are saved |
| `defaultConcurrency` | `2` | Parallel browser pages (1–5) |
| `defaultDelayMin` | `1200` | Min request jitter (ms) |
| `defaultDelayMax` | `3500` | Max request jitter (ms) |
| `headless` | `true` | `false` = visible browser window |
| `waitUntil` | `domcontentloaded` | Navigation event to wait for (`domcontentloaded` / `load` / `networkidle`) |
| `navigationTimeoutMs` | `30000` | Page load timeout (ms) |
| `maxRetries` | `3` | Failed chapter retries before drop |
| `defaultLanguage` | `en` | ISO 639-1 code pre-filled in metadata |
| `defaultAuthor` | `Unknown` | Author pre-filled in metadata |
| `defaultPublisher` | `WebNovel Scraper` | Publisher pre-filled in metadata |
| `logLevel` | `info` | Console log level (`error`/`warn`/`info`/`debug`) |
| `askSaveProfile` | `true` | Offer to save a site profile after first scrape |

`waitUntil` values:
- `domcontentloaded` — fastest, sufficient for most static/SSR sites
- `load` — waits for all sub-resources (images, fonts)
- `networkidle` — waits until no network activity for 500 ms; use for heavy SPA/React sites

---

## EPUB Output Structure

```
output.epub
├── mimetype                         (uncompressed, EPUB OCF spec)
├── META-INF/container.xml           (correct OCF namespace — works in Readest, Sigil, Calibre)
└── OEBPS/
    ├── content.opf                  (EPUB 3 package + manifest + spine)
    ├── nav.xhtml                    (EPUB 3 navigation document)
    ├── toc.ncx                      (EPUB 2 backward compat)
    ├── title.xhtml                  (title page + synopsis)
    ├── cover.xhtml / images/cover.jpg
    ├── styles/style.css             (reader-optimised typography)
    └── chapters/
        ├── chapter-1.xhtml
        └── …
```

Compatible with: Readest, Calibre, Apple Books, KOReader, Moon+ Reader, Thorium, and any EPUB 3 reader.

---

## Logs

All runs write to `./logs/`:

| File | Content |
|---|---|
| `combined.log` | Full JSON log (all levels) |
| `error.log` | Errors only |
| `exceptions.log` | Uncaught exceptions |
| `rejections.log` | Unhandled promise rejections |

---

## Common Selector Cheatsheet

```
Content area:
  .chapter-content          Royal Road, ScribbleHub
  #chapter-container        Wuxiaworld
  article.entry-content     WordPress novels
  //div[@id="chr-content"]  XPath alternative

Title element:
  .chapter-title
  h1.title
  //h1[@class="chapter-heading"]

Next button:
  a[rel="next"]             semantic next link
  .btn-next                 generic class
  >>                        regex — link text is ">>"
  Next\s*Chapter            regex — link text contains "Next Chapter"
  //p/a[last()]             XPath — last anchor in a paragraph

Exclusions:
  .ads, .adsbygoogle        advertisements
  .author-note              skip author notes
  .translator-note          skip translator notes
  #donation-banner          donation prompts
  //div[@class="ad-wrap"]   XPath exclusion
```

---

## Troubleshooting

**"No package document defined" in EPUB reader** — Fixed. The OCF container namespace is now the exact string required by strict readers like Readest.

**No content extracted** — The `contentSelector` doesn't match. Open DevTools, right-click the chapter text, Inspect, find the wrapper element's class or id.

**0 links on TOC** — The page may require JS to render. Try `waitUntil: networkidle` in global settings. Or switch to sequential mode.

**Regex next-button not matching** — Regex tests `a.textContent` (decoded visible text), not HTML source. Enter `>>` not `&gt;&gt;`. Enter `Next Chapter` not `<a>Next Chapter</a>`.

**Blocked / CAPTCHA** — Reduce concurrency to `1`, increase delays, set `headless: false` to debug visually.

**Cookies not working** — Verify the domain key in `cookies.json` matches the bare hostname (no `www.`, no protocol). The store normalises automatically.

---

