// ─────────────────────────────────────────────────────────────────────────────
//  ChapterListService — TOC & sequential chapter-link discovery.
//  Ported from src/scraper/toc.ts and src/scraper/sequential.ts.
//  Uses PageHandle instead of raw Playwright Page; progress events emitted
//  through UIAdapter instead of ora spinners.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import type { PageHandle } from "../../ports/BrowserPort.js";
import type { Logger } from "../../ports/Logger.js";
import type { UIAdapter } from "../../ports/UIAdapter.js";
import type { NextLocator } from "../domain/Locator.js";
import { formatLocator } from "./SelectorService.js";

const NON_CHAPTER_PATTERNS = [
  /\/login/i, /\/register/i, /\/signup/i, /\/logout/i,
  /\/profile/i, /\/account/i, /\/settings/i,
  /\/search/i, /\/tag/i, /\/category/i, /\/genre/i,
  /\/author/i, /\/bookmark/i, /\/library/i, /\/forum/i,
  /\/comment/i, /\/discussion/i,
  /\.(js|css|jpg|jpeg|png|gif|svg|ico|woff|ttf)$/i,
  /^mailto:/i, /^javascript:/i, /^#/,
];

const MAX_CHAPTERS = 10_000;

export class ChapterListService {
  constructor(private log: Logger, private ui: UIAdapter) {}

  async discoverTOC(
    page: PageHandle,
    tocUrl: string,
    waitUntil: "domcontentloaded" | "networkidle" | "load",
    navTimeoutMs: number,
  ): Promise<string[]> {
    this.ui.emit({ type: "discovery.started", url: tocUrl });

    const allLinks = new Map<string, number>();
    let order = 0;
    const visited = new Set<string>();
    const queue = [tocUrl];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      this.ui.emit({
        type: "discovery.progress",
        found: allLinks.size,
        pages: visited.size,
      });

      await page.goto(current, { waitUntil, timeoutMs: navTimeoutMs });
      await delay(randomInt(800, 1800));

      const html = await page.content();
      const $ = cheerio.load(html);
      const origin = new URL(tocUrl).origin;

      $("a[href]").each((_i, el) => {
        const raw = $(el).attr("href");
        if (!raw) return;

        let abs: string;
        try {
          abs = raw.startsWith("http") ? raw : new URL(raw, current).toString();
        } catch {
          return;
        }

        try {
          if (new URL(abs).origin !== origin) return;
        } catch {
          return;
        }

        if (abs === tocUrl || abs === current) return;
        if (NON_CHAPTER_PATTERNS.some((p) => p.test(abs))) return;

        if (!allLinks.has(abs)) {
          allLinks.set(abs, order++);
        }
      });

      // Follow TOC pagination
      const tocPathBase = new URL(tocUrl).pathname
        .split("/")
        .slice(0, -1)
        .join("/");
      $('a[rel="next"]').each((_i, el) => {
        const raw = $(el).attr("href");
        if (!raw) return;
        try {
          const abs = raw.startsWith("http")
            ? raw
            : new URL(raw, current).toString();
          if (new URL(abs).origin === origin && !visited.has(abs)) {
            const path = new URL(abs).pathname;
            if (path.startsWith(tocPathBase)) queue.push(abs);
          }
        } catch {/*ignore*/}
      });
    }

    const sorted = [...allLinks.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([url]) => url);

    this.log.info("TOC scrape complete", {
      links: sorted.length,
      pages: visited.size,
    });

    this.ui.emit({ type: "discovery.done", urls: sorted });
    return sorted;
  }

  async collectSequential(
    page: PageHandle,
    firstUrl: string,
    lastUrl: string,
    locators: NextLocator[],
    delayMin: number,
    delayMax: number,
    waitUntil: "domcontentloaded" | "networkidle" | "load",
    navTimeoutMs: number,
  ): Promise<string[]> {
    if (locators.length === 0) {
      throw new Error("At least one next-button locator is required");
    }

    this.ui.emit({ type: "discovery.started", url: firstUrl });

    const links: string[] = [];
    const visited = new Set<string>();
    let currentUrl = firstUrl;
    const hits: number[] = new Array(locators.length).fill(0);

    while (currentUrl && links.length < MAX_CHAPTERS) {
      if (visited.has(currentUrl)) {
        this.log.warn(`Navigation loop detected at ${currentUrl} — stopping`);
        break;
      }
      visited.add(currentUrl);
      links.push(currentUrl);

      this.ui.emit({
        type: "discovery.progress",
        found: links.length,
        pages: visited.size,
      });

      if (currentUrl === lastUrl) {
        this.log.info(`Reached last chapter. Collected ${links.length} URL(s).`);
        break;
      }

      try {
        await page.goto(currentUrl, { waitUntil, timeoutMs: navTimeoutMs });
        await delay(Math.floor(delayMin * 0.4));
      } catch (e) {
        this.log.error(`Navigation failed: ${currentUrl}`, { error: (e as Error).message });
        break;
      }

      const resolved = await this.resolveNext(page, locators, hits, links.length);
      if (!resolved) break;

      const href = await page.hrefOf(resolved.element).catch(() => null);
      if (href?.trim() && !href.startsWith("#") && !/^javascript:/i.test(href)) {
        try {
          currentUrl = href.startsWith("http")
            ? href.trim()
            : new URL(href.trim(), currentUrl).toString();
          await delay(Math.floor(delayMin * 0.3));
          continue;
        } catch {
          // fall through to click
        }
      }

      // Strategy B: click + wait for navigation
      try {
        const newUrl = await page.clickAndWaitNav(resolved.element, 15_000);
        if (newUrl === currentUrl) {
          this.log.warn("Click did not change URL — stopping");
          break;
        }
        currentUrl = newUrl;
      } catch (e) {
        this.log.error(`Click navigation failed at ${currentUrl}`, { error: (e as Error).message });
        break;
      }

      await delay(Math.floor(delayMin * 0.3));
    }

    if (links.length >= MAX_CHAPTERS) {
      this.log.warn(`Safety limit (${MAX_CHAPTERS}) reached`);
    }

    if (lastUrl && !links.includes(lastUrl) && links.length > 0) {
      this.log.warn(
        `Last chapter URL never reached.\n  Last visited: ${links.at(-1)}\n  Causes: wrong locator, locked chapters, or navigation gap.`,
      );
    }

    // Locator usage summary
    if (hits.length > 0) {
      const summary = locators
        .map((l, i) => `  ${i === 0 ? "primary  " : `fallback ${i}`}  ${formatLocator(l)}  → ${hits[i]} chapter(s)`)
        .join("\n");
      this.log.info(`Locator usage summary:\n${summary}`);
    }

    this.ui.emit({ type: "discovery.done", urls: links });
    return links;
  }

  private async resolveNext(
    page: PageHandle,
    locators: NextLocator[],
    hits: number[],
    chapterNo: number,
  ): Promise<{ element: import("../../ports/BrowserPort.js").ElementRef; idx: number } | null> {
    type ElementRef = import("../../ports/BrowserPort.js").ElementRef;

    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      try {
        let el: ElementRef | null = null;

        if (loc.kind === "regex") {
          el = await page.findAnchorByRegex(loc.value, loc.flags ?? "i");
        } else if (loc.kind === "css") {
          el = await page.findElement(loc.value);
        } else if (loc.kind === "xpath") {
          const pwSel = `xpath=${loc.value}`;
          el = await page.findElement(pwSel);
        }

        if (el) {
          hits[i]++;
          return { element: el, idx: i };
        }
      } catch (e) {
        this.log.debug(`Locator #${i} (${loc.kind}) error: ${(e as Error).message}`);
      }

      if (i > 0) {
        this.log.warn(
          `Fallback #${i} used at chapter ${chapterNo}: ${formatLocator({ kind: loc.kind, value: loc.value, flags: loc.flags })}`,
        );
      }
    }

    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}