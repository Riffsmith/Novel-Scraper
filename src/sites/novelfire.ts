import type { Page } from "playwright";
import type { SiteAdapter, AutoNovelMetadata } from "./types.js";
import type { WaitUntil } from "../types.js";
import logger from "../logger/index.js";

const ORIGIN = "https://novelfire.net";

// ── URL helpers ─────────────────────────────────────────────────────────
function isNovelFireUrl(url: string): boolean {
  try {
    return /(^|\.)novelfire\.net$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Strip trailing slash(es) from the novel URL's path — e.g.
// "/book/shadow-slave/" → "/book/shadow-slave"
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

async function extractParagraphText(
  page: Page,
  selector: string,
  excludeSelectors: string[] = [],
): Promise<string> {
  const container = page.locator(selector).first();

  // Strip out nested "noise" elements (e.g. the "show full synopsis" toggle
  // button living in a nested div.expand) before reading innerText, so its
  // label text doesn't leak into the scraped description.
  if (excludeSelectors.length > 0) {
    await container
      .evaluate((el, sels: string[]) => {
        sels.forEach((s) => el.querySelectorAll(s).forEach((n) => n.remove()));
      }, excludeSelectors)
      .catch(() => {
        /* best-effort — fall through to raw text if this fails */
      });
  }

  const raw = await container.innerText({ timeout: 8_000 }).catch(() => null);
  if (!raw) return "";

  return raw
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────
//  Metadata — title / author / description / cover from the novel's
//  landing page.
//
//  Author extraction: `.author` wraps an <a> whose `title` attribute
//  usually holds the plain author name. If that's missing, fall back to
//  the nested <span>'s text, then to the block's raw text as a last resort.
// ─────────────────────────────────────────────────────────────────────────
async function scrapeMetadata(
  page: Page,
  novelUrl: string,
): Promise<AutoNovelMetadata> {
  await page.goto(novelUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(".novel-title", { timeout: 15_000 }).catch(() => {
    /* best-effort */
  });

  const title =
    (
      await page
        .locator(".novel-title")
        .first()
        .textContent()
        .catch(() => null)
    )?.trim() || "Unknown Title";

  const author =
    (await page
      .locator(".author")
      .first()
      .evaluate((el) => {
        const a = el.querySelector("a");
        if (a) {
          const titleAttr = a.getAttribute("title");
          if (titleAttr?.trim()) return titleAttr.trim();
          const span = a.querySelector("span");
          if (span?.textContent?.trim()) return span.textContent.trim();
        }
        return el.textContent?.trim() ?? "";
      })
      .catch(() => "")) || "Unknown";

  const description = await extractParagraphText(page, ".content", [
    "div.expand",
  ]);

  let coverUrl: string | undefined;
  const coverEl = page.locator(".cover > img:nth-child(1)").first();
  const coverSrc =
    (await coverEl.getAttribute("src").catch(() => null)) ??
    (await coverEl.getAttribute("data-src").catch(() => null)); // lazy-load fallback
  if (coverSrc) {
    coverUrl = coverSrc.startsWith("http")
      ? coverSrc
      : `${ORIGIN}${coverSrc.startsWith("/") ? "" : "/"}${coverSrc}`;
  }

  logger.info("novelfire metadata scraped", {
    title,
    author,
    hasCover: !!coverUrl,
  });
  return { title, author, description, coverUrl };
}

// ─────────────────────────────────────────────────────────────────────────
//  Browser-side extraction script.
//
//  Passed to page.evaluate() as a STRING rather than a function reference —
//  see the note in wtrLab.ts's BATCH_EXPAND_SCRIPT for why (esbuild/tsx's
//  keepNames transform can inject a `__name` helper that doesn't exist in
//  the browser context). Keeping this as a string sidesteps it entirely.
// ─────────────────────────────────────────────────────────────────────────
const CHAPTER_LIST_SCRIPT = `
(() => {
  const list = document.querySelector('.chapter-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('a[href]')).map((a) => a.href);
})()
`;

// ─────────────────────────────────────────────────────────────────────────
//  Chapter links — the TOC is classically paginated (~100 chapters/page)
//  via ?page=N. Walk pages sequentially, harvesting `.chapter-list a`
//  hrefs, until `.chapter-list` no longer appears — or a page returns the
//  exact same batch as the previous one, which signals the site has
//  wrapped an out-of-range page number back to page 1 instead of
//  returning an empty list.
// ─────────────────────────────────────────────────────────────────────────
const MAX_TOC_PAGES = 300;

async function scrapeChapterLinks(
  page: Page,
  novelUrl: string,
  opts: { waitUntil: WaitUntil; navTimeoutMs: number },
): Promise<string[]> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  let prevFirstLink: string | null = null;

  for (let pageNum = 1; pageNum <= MAX_TOC_PAGES; pageNum++) {
    const url = tocPageUrl(novelUrl, pageNum);
    await page.goto(url, {
      waitUntil: opts.waitUntil,
      timeout: opts.navTimeoutMs,
    });

    const hasList = (await page.locator(".chapter-list").count()) > 0;
    if (!hasList) {
      logger.info(
        `novelfire TOC: .chapter-list absent at page ${pageNum} — stopping`,
      );
      break;
    }

    const batch = await page.evaluate<string[]>(CHAPTER_LIST_SCRIPT);

    if (batch.length === 0) {
      logger.info(`novelfire TOC: empty batch at page ${pageNum} — stopping`);
      break;
    }

    if (prevFirstLink !== null && batch[0] === prevFirstLink) {
      logger.info(
        `novelfire TOC: page ${pageNum} repeats page ${pageNum - 1} — stopping`,
      );
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

    logger.info(
      `novelfire TOC page ${pageNum}: ${batch.length} link(s), ${added} new`,
    );

    if (added === 0) break; // differing first link but nothing new — bail safely
  }

  return ordered;
}

export const novelFireAdapter: SiteAdapter = {
  id: "novelfire",
  label: "NovelFire (novelfire.net)",
  matches: isNovelFireUrl,
  getTocUrl: tocUrlFor,
  scrapeMetadata,
  scrapeChapterLinks,
  defaultContentSelector: "#content",
  defaultTitleSelector: ".chapter-title",
  defaultSeparateTitle: true,
  defaultExcludeSelectors: [],
};
