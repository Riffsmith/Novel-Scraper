// ─────────────────────────────────────────────────────────────────────────────
//  NovelFire site adapter - v2 port of src/sites/novelfire.ts onto PageHandle
//  (ADR-P4-A). Byte-faithful to v1; only the Playwright `Page` import becomes
//  `PageHandle`, and every `page.evaluate(fn)` becomes a `page.evaluateScript`
//  (string-constant) call. The AGENTS.md "page.evaluate() string-constant
//  rule" is enforced by construction because `evaluateScript` takes only a
//  string - never a closure (the keepNames `__name` footgun never reaches the
//  browser scope).
//
//  v1 oracle: src/sites/novelfire.ts:1-228 stays byte-untouched until Phase 6.
// ─────────────────────────────────────────────────────────────────────────────

import type { PageHandle } from "../../ports/BrowserPort.js";
import type { AutoNovelMetadata, SiteAdapter } from "../../core/domain/SiteAdapter.js";
import type { Logger } from "../../ports/Logger.js";

const ORIGIN = "https://novelfire.net";

// ── URL helpers (verbatim v1 :9-35) ─────────────────────────────────────────
function isNovelFireUrl(url: string): boolean {
  try {
    return /(^|\.)novelfire\.net$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Strip trailing slash(es) from the novel URL's path - e.g.
// "/book/shadow-slave/" -> "/book/shadow-slave"
function bookPathBase(novelUrl: string): string {
  return new URL(novelUrl).pathname.replace(/\/+$/, "");
}

function tocUrlFor(novelUrl: string): string {
  const u = new URL(novelUrl);
  u.pathname = `${bookPathBase(novelUrl)}/chapters`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

function tocPageUrl(novelUrl: string, page: number): string {
  const u = new URL(tocUrlFor(novelUrl));
  u.searchParams.set("page", String(page));
  return u.toString();
}

// ── Browser-side string-constant scripts ─────────────────────────────────────
// IMPORTANT: every script is a plain STRING constant - never a closure - so
// esbuild's keepNames transform can't inject a `__name()` helper that's
// absent from browser scope (read AGENTS.md "page.evaluate() string-constant
// rule"). v1 carried the same constant at src/sites/novelfire.ts:141-147 and
// the author-extraction closure at :98-107; v2 ports the author extraction to
// a string too because PageHandle exposes no generic evaluate(fn).

const CHAPTER_LIST_SCRIPT = `
(() => {
  const list = document.querySelector('.chapter-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('a[href]')).map((a) => a.href);
})()
`;

// Author extraction (v1 :98-107): the `.author` block wraps an <a> whose
// `title` attribute holds the plain author name; fall back to the nested
// <span>'s text, then to the block's raw text. Driven by a string script so
// the keepNames rule never bites.
const AUTHOR_SCRIPT = `
(() => {
  const el = document.querySelector('.author');
  if (!el) return '';
  const a = el.querySelector('a');
  if (a) {
    const titleAttr = a.getAttribute('title');
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();
    const span = a.querySelector('span');
    if (span && span.textContent && span.textContent.trim()) return span.textContent.trim();
  }
  return (el.textContent || '').trim();
})()
`;

// ── Metadata - title / author / description / cover (port of v1 :76-131) ─────
async function scrapeMetadata(
  page: PageHandle,
  novelUrl: string,
  log: Logger,
): Promise<AutoNovelMetadata> {
  await page.goto(novelUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  await page.waitForSelector(".novel-title", 15_000).catch(() => {
    /* best-effort */
  });

  const title = (await page.textContent(".novel-title", 8_000))?.trim() || "Unknown Title";

  const author =
    (await page.evaluateScript<string>(AUTHOR_SCRIPT).catch(() => "")) || "Unknown";

  // v1's extractParagraphText strips the nested `div.expand` toggle so its
  // label text doesn't leak into the synopsis - PageHandle.innerText takes
  // the excludeSelectors array and does the same strip best-effort.
  const description = (await page.innerText(".content", 8_000, ["div.expand"])) ?? "";

  let coverUrl: string | undefined;
  // `.cover > img:nth-child(1)` -> first child img of `.cover`. v1 uses the
  // same selector; the `src` then `data-src` lazy-load fallback is exactly
  // what PageHandle.getAttribute(selector, "src", "data-src") does.
  const coverSrc = await page.getAttribute(".cover > img:nth-child(1)", "src", "data-src");
  if (coverSrc) {
    coverUrl = coverSrc.startsWith("http")
      ? coverSrc
      : `${ORIGIN}${coverSrc.startsWith("/") ? "" : "/"}${coverSrc}`;
  }

  log.info("novelfire metadata scraped", { title, author, hasCover: !!coverUrl });
  return { title, author, description, coverUrl };
}

// ── Chapter links (port of v1 :157-215) ─────────────────────────────────────
// TOC is paginated ~100/page via ?page=N. Walk pages sequentially, harvesting
// `.chapter-list a` hrefs, until the list is absent, empty, or repeats the
// previous page's first link (the site wraps an out-of-range page back to
// page 1 instead of returning empty - the dedupe + repeat check catches that).
const MAX_TOC_PAGES = 300;

async function scrapeChapterLinks(
  page: PageHandle,
  novelUrl: string,
  opts: { waitUntil: "domcontentloaded" | "networkidle" | "load"; navTimeoutMs: number },
  log: Logger,
): Promise<string[]> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  let prevFirstLink: string | null = null;

  for (let pageNum = 1; pageNum <= MAX_TOC_PAGES; pageNum++) {
    const url = tocPageUrl(novelUrl, pageNum);
    await page.goto(url, { waitUntil: opts.waitUntil, timeoutMs: opts.navTimeoutMs });

    const hasList = (await page.locatorCount(".chapter-list")) > 0;
    if (!hasList) {
      log.info(`novelfire TOC: .chapter-list absent at page ${pageNum} - stopping`);
      break;
    }

    const batch = await page.evaluateScript<string[]>(CHAPTER_LIST_SCRIPT);

    if (batch.length === 0) {
      log.info(`novelfire TOC: empty batch at page ${pageNum} - stopping`);
      break;
    }

    if (prevFirstLink !== null && batch[0] === prevFirstLink) {
      log.info(`novelfire TOC: page ${pageNum} repeats page ${pageNum - 1} - stopping`);
      break;
    }
    prevFirstLink = batch[0];

    let added = 0;
    for (const link of batch) {
      if (!seen.has(link)) {
        seen.add(link);
        ordered.push(link);
        added++;
      }
    }

    log.info(`novelfire TOC page ${pageNum}: ${batch.length} link(s), ${added} new`);

    if (added === 0) break; // differing first link but nothing new - bail safely
  }

  return ordered;
}

// ── Adapter export ──────────────────────────────────────────────────────────
export function makeNovelFireAdapter(log: Logger): SiteAdapter {
  return {
    id: "novelfire",
    label: "NovelFire (novelfire.net)",
    matches: isNovelFireUrl,
    getTocUrl: tocUrlFor,
    scrapeMetadata: (page, url) => scrapeMetadata(page, url, log),
    scrapeChapterLinks: (page, url, opts) => scrapeChapterLinks(page, url, opts, log),
    defaultContentSelector: "#content",
    defaultTitleSelector: ".chapter-title",
    defaultSeparateTitle: true,
    defaultExcludeSelectors: [],
  };
}

// v1's export: a singleton wired to the project logger. v2 uses the
// makeNovelFireAdapter(log) factory so the composition root owns the logger
// binding; the singleton is here only for parity of surface with
// wtrLabAdapter (read site-registry/index.ts).
export const novelFireAdapter: SiteAdapter = makeNovelFireAdapter({
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger);
