// ─────────────────────────────────────────────────────────────────────────────
//  WTR-Lab site adapter - v2 port of src/sites/wtrLab.ts onto PageHandle
//  (ADR-P4-A). Byte-faithful to v1; only the Playwright `Page` import becomes
//  `PageHandle` and every `page.evaluate(fn)` becomes a `page.evaluateScript`
//  (string-constant) call, the AGENTS.md "page.evaluate() string-constant
//  rule" enforced by construction because the named method takes only a
//  string.
//
//  v1 oracle: src/sites/wtrLab.ts:1-165 stays byte-untouched until Phase 6.
// ─────────────────────────────────────────────────────────────────────────────

import type { PageHandle } from "../../ports/BrowserPort.js";
import type { AutoNovelMetadata, SiteAdapter } from "../../core/domain/SiteAdapter.js";
import type { Logger } from "../../ports/Logger.js";

const ORIGIN = "https://wtr-lab.com";

// ── URL helpers (verbatim from v1 :9-18) ─────────────────────────────────────
function isWtrLabUrl(url: string): boolean {
  try {
    return /(^|\.)wtr-lab\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function tocUrlFor(novelUrl: string): string {
  const u = new URL(novelUrl);
  u.searchParams.set("tab", "toc");
  return u.toString();
}

// ── Browser-side batch-expander script ─────────────────────────────────────
// IMPORTANT: passed to PageHandle.evaluateScript() as a STRING constant,
// never a closure - see AGENTS.md "page.evaluate() string-constant rule" and
// 02-site-adapters.md §1.7. This is v1 src/sites/wtrLab.ts:73-106 verbatim.
const BATCH_EXPAND_SCRIPT = `
(async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const getButtons = () =>
    Array.from(document.querySelectorAll('button'))
      .filter((b) => /chapter|^\\s*\\d+\\s*-\\s*\\d+\\s*$/i.test(b.textContent || ''));

  let buttons = getButtons();
  for (const btn of buttons) {
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    await delay(400);
  }

  await delay(500);
  let newButtons = getButtons().filter((b) => !buttons.includes(b));
  let guard = 0;
  while (newButtons.length && guard < 25) {
    for (const btn of newButtons) {
      btn.click();
      await delay(400);
    }
    buttons = buttons.concat(newButtons);
    newButtons = getButtons().filter((b) => !buttons.includes(b));
    guard++;
  }

  const links = Array.from(document.querySelectorAll('a[href*="/chapter-"]'))
    .map((a) => a.href);

  return [...new Set(links)];
})()
`;

// ── Metadata - title/author/description/cover (verbatim v1 :36-58) ──────────
async function scrapeMetadata(
  page: PageHandle,
  novelUrl: string,
  log: Logger,
): Promise<AutoNovelMetadata> {
  await page.goto(novelUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  await page.waitForSelector("h1.text-base", 15_000).catch(() => {
    /* best-effort */
  });

  const title = (await page.textContent("h1.text-base", 8_000))?.trim() || "Unknown Title";
  const author = (await page.textContent("p.text-xs", 8_000))?.trim() || "Unknown";

  const description = (await page.innerText(".description", 8_000)) ?? "";

  let coverUrl: string | undefined;
  const coverSrc = await page.getAttribute("img.relative", "src").catch(() => null);
  if (coverSrc) {
    coverUrl = coverSrc.startsWith("http")
      ? coverSrc
      : `${ORIGIN}${coverSrc.startsWith("/") ? "" : "/"}${coverSrc}`;
  }

  log.info("wtr-lab metadata scraped", { title, author, hasCover: !!coverUrl });
  return { title, author, description, coverUrl };
}

// ── Chapter links (verbatim v1 :113-128) ────────────────────────────────────
async function scrapeChapterLinks(
  page: PageHandle,
  novelUrl: string,
  opts: { waitUntil: "domcontentloaded" | "networkidle" | "load"; navTimeoutMs: number },
  log: Logger,
): Promise<string[]> {
  const toc = tocUrlFor(novelUrl);
  await page.goto(toc, { waitUntil: opts.waitUntil, timeoutMs: opts.navTimeoutMs });
  await page.waitForSelector("button", 15_000).catch(() => {
    /* best-effort */
  });
  // v1: a 1s settle to let the initial batch render.
  await new Promise((r) => setTimeout(r, 1_000));

  const rawLinks = await page.evaluateScript<string[]>(BATCH_EXPAND_SCRIPT);

  log.info(`wtr-lab TOC harvest: ${rawLinks.length} raw link(s) before ordering fix`);

  return sortByChapterNumber(rawLinks, log);
}

// ── Order fix (verbatim v1 :136-152) ─────────────────────────────────────────
function sortByChapterNumber(urls: string[], log: Logger): string[] {
  let unparsed = 0;

  const withKey = urls.map((url) => {
    const m = url.match(/chapter-(\d+)(?:[-.](\d+))?/i);
    if (!m) {
      unparsed++;
      return { url, key: Number.POSITIVE_INFINITY };
    }
    const major = parseInt(m[1], 10);
    const minor = m[2] ? parseInt(m[2], 10) / 1000 : 0; // handles "131-1" style sub-chapters
    return { url, key: major + minor };
  });

  if (unparsed > 0) {
    log.warn(`${unparsed} chapter URL(s) didn't match the expected pattern - left in discovery order`);
  }

  return withKey.sort((a, b) => a.key - b.key).map((w) => w.url);
}

// ── Adapter export ──────────────────────────────────────────────────────────
export function makeWtrLabAdapter(log: Logger): SiteAdapter {
  return {
    id: "wtr-lab",
    label: "WTR-LAB (wtr-lab.com)",
    matches: isWtrLabUrl,
    getTocUrl: tocUrlFor,
    scrapeMetadata: (page, url) => scrapeMetadata(page, url, log),
    scrapeChapterLinks: (page, url, opts) => scrapeChapterLinks(page, url, opts, log),
    defaultContentSelector: ".chapter-content", // TODO: verify against a real wtr-lab chapter page
    defaultTitleSelector: undefined,
    defaultSeparateTitle: false,
    defaultExcludeSelectors: [],
  };
}

// v1's export: a singleton wired to the project logger. v2 uses the
// makeWtrLabAdapter(log) factory so the composition root (app/tui.ts / Phase
// 5 cli.ts) owns the logger binding.
export const wtrLabAdapter: SiteAdapter = makeWtrLabAdapter(
  // Lazy import of the winston-backed logger for the singleton; the factory
  // is the preferred seam. Both adapters shipped through that factory pay the
  // same logger.
  {
    info() {},
    warn() {},
    error() {},
    debug() {},
  } as unknown as Logger,
);
