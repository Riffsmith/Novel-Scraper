import * as cheerio    from 'cheerio';
import sanitizeHtml    from 'sanitize-html';
import type { Page }   from 'playwright';
import type { Chapter } from '../types.js';
import logger           from '../logger/index.js';
import { randomDelay }  from './browser.js';
import {
  isXPath,
  extractInnerHtml,
  extractTextContent,
  removeFromDom,
  waitForSelector,
} from './selectors.js';

// ── Anti-bot / security-check interstitial handling ───────────────────────
// Sites that rate-limit scraping (WTR-LAB included) serve a "verifying
// activity" page instead of the chapter when the request pattern looks
// automated. These can clear on their own within seconds if the browser
// looks legitimate — but only if we wait instead of failing on first sight.
const CHALLENGE_MAX_WAIT_MS = 30_000;
const CHALLENGE_POLL_MS     = 2_000;

const CHALLENGE_SIGNS = [
  /security check required/i,
  /unusual (reading|browsing) activity/i,
  /verify you.?re (a )?human/i,
  /checking your browser/i,
  /just a moment/i,
  /loading security challenge/i,
];

async function looksLikeChallenge(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  return CHALLENGE_SIGNS.some(re => re.test(text));
}

async function waitOutChallenge(page: Page): Promise<'cleared' | 'stuck' | 'none'> {
  if (!(await looksLikeChallenge(page))) return 'none';

  logger.warn('Security challenge detected — waiting for it to clear…');
  const deadline = Date.now() + CHALLENGE_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CHALLENGE_POLL_MS));
    if (!(await looksLikeChallenge(page))) {
      logger.info('Security challenge cleared');
      return 'cleared';
    }
  }
  logger.warn(`Security challenge still present after ${CHALLENGE_MAX_WAIT_MS}ms`);
  return 'stuck';
}

export class SecurityChallengeError extends Error {
  constructor(url: string) {
    super(`Security challenge did not clear: ${url}`);
    this.name = 'SecurityChallengeError';
  }
}

// ── Sanitisation allow-list ──────────────────────────────────────────────
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'del',
    'span', 'div', 'section',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'code',
    'ul', 'ol', 'li',
    'a', 'img', 'hr',
    'ruby', 'rb', 'rt', 'rp',
  ],
  allowedAttributes: {
    'a'   : ['href', 'title'],
    'img' : ['src', 'alt', 'title'],
    'span': ['class', 'style'],
    'div' : ['class'],
    'p'   : ['class', 'style'],
    '*'   : ['lang'],
  },
  allowedStyles: {
    '*': {
      'text-align' : [/^(left|right|center|justify)$/],
      'font-style' : [/^(italic|normal)$/],
      'font-weight': [/^(bold|normal|\d+)$/],
      'color'      : [/^#[0-9a-fA-F]{3,6}$/, /^rgba?\(/],
    },
  },
  allowedSchemes    : ['http', 'https'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
};

// ── Chapter scrape options ──────────────────────────────────────────────
export interface ChapterScrapeOpts {
  contentSelector  : string;
  titleSelector?   : string;
  separateTitle    : boolean;
  excludeSelectors : string[];
  delayMin         : number;
  delayMax         : number;
  // Passed through from AppConfig so the global waitUntil and timeout apply
  // to every chapter page load rather than being hardcoded here.
  waitUntil        : 'domcontentloaded' | 'networkidle' | 'load';
  navTimeoutMs     : number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  scrapeChapter — extracts title + body from a single chapter page.
//
//  All selectors (content, title, exclude) now accept both CSS and XPath:
//    • CSS  →  ".chapter-content"  |  "#content"
//    • XPath → "//div[@class='chapter-body']"  |  "xpath=//h1"
//
//  When the content selector is CSS, the page is loaded into cheerio for
//  fast, stateless DOM manipulation.
//  When it is XPath, Playwright Locators are used for extraction instead,
//  and any XPath exclude selectors are removed from the live DOM before
//  the content is captured.
// ═══════════════════════════════════════════════════════════════════════════
export async function scrapeChapter(
  page  : Page,
  url   : string,
  index : number,
  opts  : ChapterScrapeOpts,
): Promise<Chapter | null> {
  logger.debug(`→  chapter ${index}: ${url}`);

  try {
    await page.goto(url, { waitUntil: opts.waitUntil, timeout: opts.navTimeoutMs });

    if ((await waitOutChallenge(page)) === 'stuck') {
      throw new SecurityChallengeError(url);
    }

    // Best-effort wait; XPath selectors work here too via waitForSelector helper
    await waitForSelector(page, opts.contentSelector, 10_000);

    await randomDelay(150, 600);

    // ── Remove excluded elements from the live DOM ───────────────────────
    // This runs before content extraction so both CSS and XPath exclusions
    // affect the snapshot we actually read.
    if (opts.excludeSelectors.length > 0) {
      await removeFromDom(page, opts.excludeSelectors);
    }

    // ── Extract title ────────────────────────────────────────────────────
    let title = `Chapter ${index}`;
    if (opts.separateTitle && opts.titleSelector) {
      const raw = await extractTextContent(page, opts.titleSelector);
      if (raw?.trim()) title = raw.trim();
    }

    // ── Extract content HTML ─────────────────────────────────────────────
    const rawHtml = await extractInnerHtml(page, opts.contentSelector);

    if (rawHtml === null) {
      logger.error(`Content selector "${opts.contentSelector}" matched nothing at ${url}`);
      return null;
    }

    // Load the extracted fragment into cheerio for post-processing.
    // We don't use the full page HTML here — only the container's innerHTML.
    const $c = cheerio.load(`<div id="__root">${rawHtml}</div>`);
    const root = $c('#__root');

    // Remove the title element from inside the container if it was extracted
    // separately (avoids duplication in the EPUB chapter body).
    if (opts.separateTitle && opts.titleSelector && !isXPath(opts.titleSelector)) {
      root.find(opts.titleSelector).remove();
    }

    // Remove hidden / aria-hidden nodes
    root.find('[style*="display:none"], [style*="display: none"], [hidden]').remove();
    root.find('[aria-hidden="true"]').remove();

    // ── Sanitise ─────────────────────────────────────────────────────────
    let clean = sanitizeHtml(root.html() ?? '', SANITIZE_OPTS);

    // ── Post-clean artefacts ─────────────────────────────────────────────
    clean = clean
      .replace(/<p[^>]*>\s*<\/p>/gi, '')
      .replace(/(<br\s*\/?>\s*){3,}/gi, '<br/><br/>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Page <title> fallback
    if (title === `Chapter ${index}`) {
      const pageTitleRaw = await page.title().catch(() => '');
      if (pageTitleRaw) title = pageTitleRaw;
    }

    // ── Word count ───────────────────────────────────────────────────────
    const wordCount = cheerio.load(clean)
      .text().trim().split(/\s+/).filter(Boolean).length;

    logger.debug(`✓  chapter ${index} "${title}" — ${wordCount} words`);

    return { index, title, url, htmlContent: clean, wordCount };
    } catch (e) {
    if (e instanceof SecurityChallengeError) throw e; // let the queue apply a longer backoff
    logger.error(`scrapeChapter failed at ${url}: ${(e as Error).message}`);
    return null;
  }
    
}
