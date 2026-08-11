// ─────────────────────────────────────────────────────────────────────────────
//  Webnovel site adapter - v2 port of reference/webnovel/contentExtractor.mjs
//  onto PageHandle (ADR-P4-A). Per docs/sites/webnovel-port-plan.md §"Named
//  phase `Adapter`":
//    - Pure DOM knowledge (selectors, volume walking, footnote/cleaning).
//    - No browser launch (PlaywrightBrowserPort), no retry (ScrapeService),
//      no fingerprinting (CloakBrowser).
//    - Browser-side scripts are plain string constants (AGENTS.md
//      "page.evaluate() string-constant rule") because PageHandle's
//      evaluateScript ships the source into the page and keepNames would
//      inject a __name helper absent from browser scope.
//    - he.encode is replaced with a local escXml equivalent (the adapter MUST
//      NOT import from epub-archiver - hexagonal boundary; templates.ts keeps
//      its own copy for the EPUB side).
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";

import type { PageHandle } from "../../ports/BrowserPort.js";
import type { AutoNovelMetadata, SiteAdapter } from "../../core/domain/SiteAdapter.js";
import type { AutoNovelVolume } from "../../core/domain/Volume.js";
import type { Footnote } from "../../core/domain/Footnote.js";
import type { Logger } from "../../ports/Logger.js";

import { getCatalogUrl, normalizeChapterUrl, normalizeWebnovelHost } from "./urlUtils.js";

// ── Reference constants (reference/webnovel/constants.mjs, DOM-knowledge only) ──

const SELECTORS = {
  TITLE: "p:has(a[title=home]) > span:last-child",
  TITLE_WAIT: "p > span:last-child",
  AUTHOR_PRIMARY: "a.c_primary",
  DESCRIPTION: "div.g_txt_over",
  DESCRIPTION_REMOVE: "span._readmore",
  COVER: "._sd > i:nth-child(1) > img:nth-child(1)",
  CHAPTER_LINKS: ".volume-item a:not(:has(svg)), a.chapter-item",
  VOLUME_ITEMS: "div.volume-item",
  VOLUME_TITLE: "h4",
  UNLOCKED_CHAPTERS: "a:not(:has(svg))",
  ALTERNATIVE_CHAPTER_SELECTORS: [
    ".volume-item a:not(:has(svg))",
    "a.chapter-item",
    ".chapter-list a",
    ".catalog-content a:not(:has(svg))",
  ],
} as const;

const BLACKLISTED_CLASSES = [
  "icon",
  "para-comment",
  "j_open_para_comment",
  "j_para_comment_count",
  "para-comment-num",
  "cha-hr",
  "cha-info",
  "j_bottom_comment_area",
  "user-links-wrap",
];

const BLACKLISTED_TAGS = ["pirate", "i"];

// Project-wide hard cap (AGENTS.md "don't fork constants": single
// ChapterListService.MAX_CHAPTERS proxy here, not a webnovel-specific constant).
const MAX_CHAPTERS = 10_000;

// ── String scripts (browser-side, AGENTS.md "page.evaluate() string-constant
//    rule"). Passed to PageHandle.evaluateScript as plain STRING constants.
//    Reference: contentExtractor.mjs:52-56 (author), :94-104 (tags / fallback). ──

const AUTHOR_SCRIPT = `
(() => {
  const el = document.querySelector('address div.ell span');
  return el ? (el.textContent || '').trim() : '';
})()
`;

// Catalog walk script - returns one entry per div.volume-item, each entry
// carrying the volume name (from its <h4>) and the array of unlocked chapter
// hrefs inside it (a:not(:has(svg)) skips locked chapters).
//
// Why ONE script does both name+hrefs (instead of pipelined PageHandle calls):
// `_extractVolumeData` walks the catalog volume-by-volume in document order,
// and the per-volume walk has to keep the inner `<a>` elements bound to the
// right `div.volume-item`. Doing that across N piped-out locator calls would
// require shipping element handles back through the port (PageHandle has no such
// surface). Collecting the whole shape in one browser-side pass and returning
// a plain JSON serialisable array is exactly what string scripts are for.
const CATALOG_WALK_SCRIPT = `
(() => {
  const volumes = [];
  const items = document.querySelectorAll('div.volume-item');
  items.forEach((item, index) => {
    const titleEl = item.querySelector('h4');
    const name = titleEl ? (titleEl.innerText || '').trim() : ('Volume ' + (index + 1));
    const hrefs = [];
    const links = item.querySelectorAll('a:not(:has(svg))');
    links.forEach((a) => {
      const href = a.getAttribute('href');
      if (href) hrefs.push(href);
    });
    volumes.push({ index, name, hrefs });
  });
  return volumes;
})()
`;

// Collect every chapter href on the page (used as the alternative-selector
// fallback when the volume-walk finds nothing - reference contentExtractor.mjs
// :218-237 _extractAlternativeChapters). Same selector bucket the reference
// iterates; first one matching > 0 links wins.
function makeAltChapterScript(selector: string): string {
  return `
(() => {
  const out = [];
  const links = document.querySelectorAll(${JSON.stringify(selector)});
  links.forEach((a) => {
    const href = a.getAttribute('href');
    if (href) out.push(href);
  });
  return out;
})()
`;
}

// ── Equivalent of he.encode via escXml - entity encoder the reference uses,
//    ported inline so this adapter doesn't pull `he` or `html-entities`
//    (neither is a project dependency). Byte-identical to he.encode's default
//    mode and to templates.ts:5-12 escXml output. ──
function escXml(s: string): string {
  return s
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;")
    .replace(/'/g, "&" + "apos;");
}

// ── URL match (reference: hostname includes "webnovel.com"; here: regex test
//    per AGENTS.md "matches() as a hostname regex test, never a substring"). ──
function isWebnovelUrl(url: string): boolean {
  try {
    return /^([^.]+\.)*webnovel\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function tocUrlFor(novelUrl: string): string {
  return getCatalogUrl(novelUrl);
}

// ── Adapter Phase 2: scrapeMetadata ─────────────────────────────────────────────
// Port of reference/webnovel/contentExtractor.mjs:14-110. Each field has a
// logged fallback per AGENTS.md §"Adapter authoring checklist" / docs/sites/
// adding-a-site.md §3.
async function scrapeMetadata(
  page: PageHandle,
  novelUrl: string,
  log: Logger,
): Promise<AutoNovelMetadata> {
  await page.goto(novelUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  await page.waitForSelector(SELECTORS.TITLE_WAIT, 15_000).catch(() => {
    /* best-effort */
  });

  // Title - reference contentExtractor.mjs:21-22. p:has(a[title=home]) > span:last-child
  let title = (await page.textContent(SELECTORS.TITLE, 8_000))?.trim() || "";
  if (!title) {
    log.warn("webnovel: empty title via primary selector");
    title = "Unknown Title";
  }

  // Author - reference :44-61. Try a.c_primary first, then 'address div.ell span'.
  let author = (await page.textContent(SELECTORS.AUTHOR_PRIMARY, 8_000))?.trim() || "";
  if (!author) {
    author =
      (await page.evaluateScript<string>(AUTHOR_SCRIPT).catch(() => ""))?.trim() ||
      "Unknown";
  }

  // Description - reference :68-83. innerHTML of div.g_txt_over, strip
  // span._readmore (the "show full synopsis" toggle label). PageHandle has no
  // cheerio-side strip; pull innerHTML and clean with cheerio here, same as the
  // reference's cheerio post-cleaning.
  let description = "";
  const descHtml = await page.innerHTML(SELECTORS.DESCRIPTION, 8_000);
  if (descHtml) {
    const $ = cheerio.load(descHtml);
    $(SELECTORS.DESCRIPTION_REMOVE).remove();
    description = $.html().trim();
  }

  // Cover - reference :28. ._sd > i:nth-child(1) > img:nth-child(1) src.
  // Protocol-relative URLs (//img.webnovel.com/...) get https: prefix.
  let coverUrl: string | undefined;
  const coverSrc = await page.getAttribute(SELECTORS.COVER, "src").catch(() => null);
  if (coverSrc) {
    coverUrl = coverSrc.startsWith("//")
      ? `https:${coverSrc}`
      : coverSrc.startsWith("http")
        ? coverSrc
        : `https://www.webnovel.com${coverSrc.startsWith("/") ? "" : "/"}${coverSrc}`;
  }

  log.info("webnovel metadata scraped", {
    title,
    author,
    hasCover: !!coverUrl,
    descLen: description.length,
  });
  return { title, author, description, coverUrl };
}

// ── Adapter Phase 3+4: shared catalog walk (D2 deviation, ADR-P7-B) ───────────
// The adapter page visits the catalog ONCE per invocation. Both
// scrapeChapterLinks (returns allUrls) and scrapeVolumes (returns volumes)
// share this private helper - reference contentExtractor.mjs:117-189 split
// the walk from the return shape but the live traversal happens once.
interface RawVolumeEntry {
  index: number;
  name: string;
  hrefs: string[];
}

async function walkCatalogVolumes(
  page: PageHandle,
  novelUrl: string,
  pageUrl: string,
  log: Logger,
): Promise<{ volumes: AutoNovelVolume[]; allUrls: string[] }> {
  // Wait for chapter links (either selector in the comma-separated CHAPTER_LINKS).
  await page.waitForSelector(SELECTORS.CHAPTER_LINKS, 10_000).catch(() => {
    /* best-effort: the fallback bucket may still match */
  });

  let raw = await page.evaluateScript<RawVolumeEntry[]>(CATALOG_WALK_SCRIPT).catch(
    () => [] as RawVolumeEntry[],
  );

  // Alternative-selector fallback if volume-walk found nothing - reference
  // contentExtractor.mjs:136-141 + :218-237.
  if (!raw || raw.length === 0 || raw.every((v) => v.hrefs.length === 0)) {
    log.info("webnovel: volume walk found 0 links, trying alternative selectors");
    for (const sel of SELECTORS.ALTERNATIVE_CHAPTER_SELECTORS) {
      const hrefs = await page.evaluateScript<string[]>(makeAltChapterScript(sel)).catch(
        () => [] as string[],
      );
      if (hrefs.length > 0) {
        log.info(`webnovel: alternative selector "${sel}" matched ${hrefs.length} links`);
        // No volume structure - emit a single pseudo-volume carrying all hrefs
        raw = [{ index: 0, name: "Additional Chapters", hrefs }];
        break;
      }
    }
  }

  const seen = new Set<string>();
  const volumes: AutoNovelVolume[] = [];
  const allUrls: string[] = [];

  for (const r of raw) {
    const volUrls: string[] = [];
    for (const href of r.hrefs) {
      const normalized = normalizeChapterUrl(href, pageUrl);
      if (seen.has(normalized)) continue;
      if (allUrls.length >= MAX_CHAPTERS) break;
      seen.add(normalized);
      allUrls.push(normalized);
      volUrls.push(normalized);
    }
    // D4 deviation: fallback name "Volume <index+1>" instead of reference's
    // `Volume ${Date.now()}` (reference :163-165 leaves a non-deterministic
    // placeholder; v2's epubExtractor.mjs-style fallback is stable).
    const name = r.name || `Volume ${r.index + 1}`;
    if (volUrls.length > 0) {
      volumes.push({ name, chapterUrls: volUrls });
    }
  }

  log.info("webnovel catalog walk", {
    volumes: volumes.length,
    urls: allUrls.length,
  });
  return { volumes, allUrls };
}

// ── Adapter Phase 3: scrapeChapterLinks (catalog walk -> flat url list) ────────
async function scrapeChapterLinks(
  page: PageHandle,
  novelUrl: string,
  opts: { waitUntil: "domcontentloaded" | "networkidle" | "load"; navTimeoutMs: number },
  log: Logger,
): Promise<string[]> {
  const toc = tocUrlFor(novelUrl);
  await page.goto(toc, { waitUntil: opts.waitUntil, timeoutMs: opts.navTimeoutMs });
  const { allUrls } = await walkCatalogVolumes(page, novelUrl, toc, log);
  return allUrls;
}

// ── Adapter Phase 4: scrapeVolumes (catalog walk -> volume list) ───────────────
async function scrapeVolumes(
  page: PageHandle,
  novelUrl: string,
  opts: { waitUntil: "domcontentloaded" | "networkidle" | "load"; navTimeoutMs: number },
  log: Logger,
): Promise<AutoNovelVolume[] | undefined> {
  const toc = tocUrlFor(novelUrl);
  await page.goto(toc, { waitUntil: opts.waitUntil, timeoutMs: opts.navTimeoutMs });
  const { volumes } = await walkCatalogVolumes(page, novelUrl, toc, log);
  return volumes.length > 0 ? volumes : undefined;
}

// Footnote collector - browser-side single string async-IIFE doing the
// reference's click-wait-collect loop (`_extractFootnotes`
// contentExtractor.mjs:276-342) entirely in browser scope. PageHandle
// exposes no generic element-handle `$$` / `click` surface, so the whole
// loop must execute inside one evaluateScript string (per AGENTS.md
// "page.evaluate() string-constant rule" and the plan §"Cross-cutting
// instructions / String-evaluate rule"). Returns `Footnote[]`-shaped
// `{ ref, title, content }` JSON; ChapterExtractor feeds that into
// processChapterContent. No retry or backoff in here (ScrapeService owns
// the retry pipeline; collectFootnotes failures fall through to a warn
// and processChapterContent runs without footnotes).
const FOOTNOTE_COLLECT_SCRIPT = `
(async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const footnotes = [];
  const annos = Array.from(document.querySelectorAll('anno[data-annotation-id]'));
  for (const anno of annos) {
    try {
      const annotationId = anno.getAttribute('data-annotation-id');
      if (!annotationId) continue;
      const sup = anno.querySelector('sup');
      if (!sup) continue;
      sup.click();
      await delay(500);
      const popup = anno.querySelector('.anno-drop');
      if (!popup) continue;
      const titleEl = popup.querySelector('.anno-drop-hd');
      const contentEl = popup.querySelector('.anno-drop-bd');
      const title = titleEl ? (titleEl.textContent || '').trim() : '';
      const content = contentEl ? (contentEl.textContent || '').trim() : '';
      if (title || content) {
        footnotes.push({ ref: annotationId, title, content });
      }
      const parentP = anno.closest('p');
      if (parentP) {
        parentP.click();
        await delay(200);
      }
    } catch (e) {
      // Continue to the next annotation rather than aborting the whole
      // loop - matches the reference's continue-on-error guard.
    }
  }
  return footnotes;
})()
`;

// ── Pipeline Phase 1: collectFootnotes (D5 deviation) ─────────────────────
// Live-page click-wait-collect loop. Runs at ChapterExtractor time (after
// challenge wait-out + content selector pull and before the
// processChapterContent post-hook) because clicking the `<sup>` to trigger
// `.anno-drop` requires a LIVE page (the post-hook is a pure cheerio path
// over already-extracted HTML). Per the plan §"Adapter Phase 5 step 8" +
// §"Pipeline Phase 1", this method was deliberately deferred to Pipeline
// Phase 1 by Scaffold Phase 3, NOT added by Adapter Phase 5.
//
// The whole click-wait-collect loop runs inside one `evaluateScript`
// string async-IIFE (FOOTNOTE_COLLECT_SCRIPT) because PageHandle exposes
// no generic `$$` / `click` element-handle surface - only
// `evaluateScript(string)` (AGENTS.md "page.evaluate() string-constant
// rule"). Returns `Footnote[]` (possibly empty); ChapterExtractor feeds
// that array into processChapterContent's `footnotes` input.
async function collectFootnotes(page: PageHandle): Promise<Footnote[] | undefined> {
  const out = await page
    .evaluateScript<Footnote[]>(FOOTNOTE_COLLECT_SCRIPT)
    .catch(() => [] as Footnote[]);
  return out && out.length > 0 ? out : undefined;
}

// ── Adapter Phase 5: processChapterContent (D3 deviation: skip reference's
//    text-node re-escape; v2's toXhtml() already handles ampersands) ──────────
// Port of reference/webnovel/contentExtractor.mjs:351-470. The reference's
// re-escape pass (contentProcessor.mjs:42-82) is intentionally NOT ported:
// v2's templates.ts:39-50 toXhtml() already escapes bare ampersands and
// self-closes void tags, so re-applying the reference's escape here would
// double-encode (& -> & -> &). Documented in deviation-log D3.
function processChapterContent(input: {
  rawHtml: string;
  title: string;
  footnotes?: Footnote[];
}): { htmlContent: string; footnotes?: Footnote[] } {
  const $ = cheerio.load(input.rawHtml);

  // Remove blacklisted tags + classes (reference contentExtractor.mjs:411-422)
  for (const tag of BLACKLISTED_TAGS) {
    $(tag).remove();
  }
  for (const cls of BLACKLISTED_CLASSES) {
    $(`[class*="${cls}"]`).remove();
  }
  // Remove already-collected footnote popups.
  $(".anno-drop").remove();

  // Replace <sup> inside <anno data-annotation-id> with footnote links.
  // Per-paragraph footnote counter restarts at 1 for each <p> (reference
  // contentExtractor.mjs:361-379).
  const paragraphs: string[] = [];
  $("p").each((_, el) => {
    let footnoteCounter = 0;
    const $p = $(el).clone();
    $p.find("anno[data-annotation-id] sup").each((_index, sup) => {
      const $sup = $(sup);
      const $anno = $sup.closest("anno");
      const annotationId = $anno.attr("data-annotation-id");
      footnoteCounter++;
      if (annotationId) {
        const link = `<a href="#footnote-${escXml(annotationId)}" class="footnote-link" id="footnote-ref-${escXml(annotationId)}">${footnoteCounter}</a>`;
        $sup.replaceWith(link);
      }
    });
    // Strip class/id/style from each <p> (reference contentExtractor.mjs:397-398)
    $p.removeAttr("class").removeAttr("id").removeAttr("style");
    paragraphs.push($.html($p));
  });

  const safeTitle = escXml(input.title || "Chapter");
  const footnotesHTML = createFootnotesHTML(input.footnotes ?? []);

  // Wrap. Byte-faithful to reference :386-403. The decorative-line + ending-line
  // divs use the CSS classes already present in templates.ts:671-686 - no
  // stylesheet change.
  const body = paragraphs.map((p) => `    ${p}`).join("\n");
  const htmlContent = `<h2 class="chapter-page-title">${safeTitle}</h2>
    <div class="decorative-line">━━━━━✧✧✧✧━━━━━</div>
${body}
    <div class="ending-line">✦ ✧ ✦ ✧ ✦</div>${footnotesHTML}`;

  return { htmlContent, footnotes: input.footnotes };
}

// Port of reference contentExtractor.mjs:434-470 _createFootnotesHTML.
// he.encode substituted with local escXml (no `he`/`html-entities` dependency
// in v2). Sequential numbering for display, matching the reference.
function createFootnotesHTML(footnotes: Footnote[]): string {
  if (!footnotes || footnotes.length === 0) return "";
  const items = footnotes
    .map((footnote, index) => {
      const n = index + 1;
      const ref = escXml(footnote.ref);
      const title = escXml(footnote.title);
      const content = escXml(footnote.content);
      if (footnote.title) {
        return `        <div class="footnote-item" id="footnote-${ref}">
        <span class="footnote-ref">
          <a href="#footnote-ref-${ref}" class="footnote-back-link">Back to text</a>
          ${n}:
        </span>
        <span class="footnote-title">${title}</span>
        <span class="footnote-separator"> - </span>
        <span class="footnote-content">${content}</span>
      </div>`;
      }
      return `        <div class="footnote-item" id="footnote-${ref}">
        <span class="footnote-ref">
          <a href="#footnote-ref-${ref}" class="footnote-back-link">Back to text</a>
          ${n}:
        </span>
        <span class="footnote-content">${content}</span>
      </div>`;
    })
    .join("\n");

  return `
    <div class="footnotes-section">
      <h3>Footnotes</h3>
      <div class="footnotes-list">
${items}
      </div>
    </div>`;
}

// ── Adapter export ──────────────────────────────────────────────────────────
export function makeWebnovelAdapter(log: Logger): SiteAdapter {
  return {
    id: "webnovel",
    label: "Webnovel (webnovel.com)",
    matches: isWebnovelUrl,
    getTocUrl: tocUrlFor,
    scrapeMetadata: (page, url) => scrapeMetadata(page, normalizeWebnovelHost(url), log),
    scrapeChapterLinks: (page, url, opts) => scrapeChapterLinks(page, url, opts, log),
    scrapeVolumes: (page, url, opts) => scrapeVolumes(page, url, opts, log),
    processChapterContent,
    collectFootnotes,
    defaultContentSelector: "div.cha-words",
    defaultTitleSelector:
      "h1.dib.mb0.fw700.fs24.lh1\\.5, h1.chapter-title, .j_chapterName",
    defaultSeparateTitle: true,
    defaultExcludeSelectors: [
      ".para-comment",
      ".cha-hr",
      ".cha-info",
      ".icon",
      ".j_bottom_comment_area",
      ".user-links-wrap",
    ],
  };
}

// Singleton wired to a no-op logger; the composition root (app/tui.ts) owns the
// real logger binding via the makeWebnovelAdapter(log) factory. Mirrors the
// WTR-Lab / NovelFire singleton pattern (site-registry/index.ts emitting both
// the factory and the singleton for parity's surface, but registration in the
// default SITE_ADAPTERS list keeps the singleton so the registry stays
// side-effect free).
export const webnovelAdapter: SiteAdapter = makeWebnovelAdapter({
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger);
