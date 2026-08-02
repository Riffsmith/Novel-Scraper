// ─────────────────────────────────────────────────────────────────────────────
//  ChapterExtractor — port of src/scraper/chapter.ts.
//  All browser interactions go through PageHandle; all DOM operations are
//  implemented as evaluate-as-string inside the adapter.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";

import type { Chapter } from "../domain/Chapter.js";
import type { PageHandle } from "../../ports/BrowserPort.js";
import type { Logger } from "../../ports/Logger.js";
import { SecurityChallengeError } from "../errors.js";
import { isXPath } from "./SelectorService.js";

// ── Challenge detection & wait-out ──────────────────────────────────────

const CHALLENGE_MAX_WAIT_MS = 30_000;
const CHALLENGE_POLL_MS = 2_000;
const CHALLENGE_BODY_TEXT_MAX_LEN = 2_000;

const CHALLENGE_TITLE_SIGNS = [
  /just a moment/i,
  /attention required/i,
  /security check/i,
  /checking your browser/i,
  /please wait/i,
  /access denied/i,
];

const CHALLENGE_BODY_SIGNS = [
  /security check required/i,
  /unusual (reading|browsing) activity/i,
  /verify you.?re (a )?human/i,
  /checking your browser/i,
  /just a moment/i,
  /loading security challenge/i,
];

const CHALLENGE_DOM_MARKERS = [
  "#cf-wrapper",
  "#challenge-form",
  "#challenge-running",
  'iframe[src*="challenges.cloudflare.com"]',
  'div[class*="cf-browser-verification"]',
];

interface ChallengeCheckResult {
  matched: boolean;
  reason?: string;
}

// ── Sanitisation allow-list (unchanged from v1, incl. ruby/rb/rt/rp for CJK)
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "b", "i", "em", "strong", "u", "s", "del",
    "span", "div", "section",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code",
    "ul", "ol", "li",
    "a", "img", "hr",
    "ruby", "rb", "rt", "rp",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    span: ["class", "style"],
    div: ["class"],
    p: ["class", "style"],
    "*": ["lang"],
  },
  allowedStyles: {
    "*": {
      "text-align": [/^(left|right|center|justify)$/],
      "font-style": [/^(italic|normal)$/],
      "font-weight": [/^(bold|normal|\d+)$/],
      color: [/^#[0-9a-fA-F]{3,6}$/, /^rgba?\(/],
    },
  },
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
};

export interface ChapterScrapeOpts {
  contentSelector: string;
  titleSelector?: string;
  separateTitle: boolean;
  excludeSelectors: string[];
  delayMin: number;
  delayMax: number;
  waitUntil: "domcontentloaded" | "networkidle" | "load";
  navTimeoutMs: number;
}

export class ChapterExtractor {
  constructor(private log: Logger) {}

  async detectChallenge(page: PageHandle): Promise<ChallengeCheckResult> {
    // 1) Structural DOM markers
    for (const sel of CHALLENGE_DOM_MARKERS) {
      const found = await page.locatorCount(sel);
      if (found > 0) return { matched: true, reason: `dom marker "${sel}"` };
    }

    // 2) Title
    const title = await page.title().catch(() => "");
    for (const re of CHALLENGE_TITLE_SIGNS) {
      if (re.test(title)) return { matched: true, reason: `title matched ${re}` };
    }

    // 3) Body text — only on short pages
    const text = await page.bodyInnerText().catch(() => "");
    if (text.length <= CHALLENGE_BODY_TEXT_MAX_LEN) {
      for (const re of CHALLENGE_BODY_SIGNS) {
        if (re.test(text))
          return { matched: true, reason: `body text (len ${text.length}) matched ${re}` };
      }
    }

    return { matched: false };
  }

  async waitOutChallenge(page: PageHandle): Promise<"cleared" | "stuck" | "none"> {
    const initial = await this.detectChallenge(page);
    if (!initial.matched) return "none";

    this.log.warn(`Security challenge detected (${initial.reason}) — waiting for it to clear...`);
    const deadline = Date.now() + CHALLENGE_MAX_WAIT_MS;

    while (Date.now() < deadline) {
      await delay(CHALLENGE_POLL_MS);
      const check = await this.detectChallenge(page);
      if (!check.matched) {
        this.log.info("Security challenge cleared");
        return "cleared";
      }
    }

    this.log.warn(`Security challenge still present after ${CHALLENGE_MAX_WAIT_MS}ms`);
    return "stuck";
  }

  async extract(
    page: PageHandle,
    url: string,
    index: number,
    opts: ChapterScrapeOpts,
  ): Promise<Chapter | null> {
    this.log.debug(`→  chapter ${index}: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: opts.waitUntil,
        timeoutMs: opts.navTimeoutMs,
      });

      const challenge = await this.waitOutChallenge(page);
      if (challenge === "stuck") {
        throw new SecurityChallengeError(url);
      }

      await page.waitForSelector(opts.contentSelector, 10_000);
      await delay(randomInt(150, 600));

      // Remove excluded elements from the live DOM
      if (opts.excludeSelectors.length > 0) {
        await page.removeFromDom(opts.excludeSelectors);
      }

      // Extract title
      let title = `Chapter ${index}`;
      if (opts.separateTitle && opts.titleSelector) {
        const raw = await page.textContent(opts.titleSelector, 5_000);
        if (raw?.trim()) title = raw.trim();
      }

      // Extract content HTML
      const rawHtml = await page.innerHTML(opts.contentSelector, 8_000);
      if (rawHtml === null) {
        this.log.error(`Content selector "${opts.contentSelector}" matched nothing at ${url}`);
        return null;
      }

      // Cheerio post-processing
      const $c = cheerio.load(`<div id="__root">${rawHtml}</div>`);
      const root = $c("#__root");

      if (opts.separateTitle && opts.titleSelector && !isXPath(opts.titleSelector)) {
        root.find(opts.titleSelector).remove();
      }

      root
        .find('[style*="display:none"], [style*="display: none"], [hidden]')
        .remove();
      root.find('[aria-hidden="true"]').remove();

      let clean = sanitizeHtml(root.html() ?? "", SANITIZE_OPTS);
      clean = clean
        .replace(/<p[^>]*>\s*<\/p>/gi, "")
        .replace(/(<br\s*\/?>\s*){3,}/gi, "<br/><br/>")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      // Page <title> fallback
      if (title === `Chapter ${index}`) {
        const pageTitleRaw = await page.title().catch(() => "");
        if (pageTitleRaw) title = pageTitleRaw;
      }

      const wordCount = cheerio
        .load(clean)
        .text()
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

      this.log.debug(`✓  chapter ${index} "${title}" — ${wordCount} words`);

      return { index, title, url, htmlContent: clean, wordCount };
    } catch (e) {
      if (e instanceof SecurityChallengeError) throw e;
      this.log.error(`scrapeChapter failed at ${url}: ${(e as Error).message}`);
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Re-exports for consumers
export { SecurityChallengeError } from "../errors.js";