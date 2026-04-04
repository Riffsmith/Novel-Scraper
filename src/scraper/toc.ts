import * as cheerio              from 'cheerio';
import type { Browser, Cookie }  from 'playwright';
import { createStealthContext, createPage, randomDelay } from './browser.js';
import logger                    from '../logger/index.js';
import { spinner }               from '../tui/display.js';

// Common URL fragments that indicate non-chapter pages
const NON_CHAPTER_PATTERNS = [
  /\/login/i, /\/register/i, /\/signup/i, /\/logout/i,
  /\/profile/i, /\/account/i, /\/settings/i,
  /\/search/i, /\/tag/i, /\/category/i, /\/genre/i,
  /\/author/i, /\/bookmark/i, /\/library/i,
  /\/forum/i, /\/comment/i, /\/discussion/i,
  /\.(js|css|jpg|jpeg|png|gif|svg|ico|woff|ttf)$/i,
  /^mailto:/i, /^javascript:/i, /^#/,
];

// ═══════════════════════════════════════════════════════════════════════════
//  Scrape a Table of Contents page and return all candidate chapter URLs.
//
//  Strategy:
//    1. Navigate to TOC URL
//    2. Collect every <a href> on the page
//    3. Filter to same-origin URLs that don't match non-chapter patterns
//    4. De-duplicate while preserving order
//    5. If the page uses pagination (<a rel="next"> or similar), follow it
// ═══════════════════════════════════════════════════════════════════════════
export async function scrapeTOC(
  browser       : Browser,
  tocUrl        : string,
  cookies?      : Cookie[],
  waitUntil     : 'domcontentloaded' | 'networkidle' | 'load' = 'domcontentloaded',
  navTimeoutMs  : number = 30_000,
): Promise<string[]> {
  const spin    = spinner(`Scraping TOC: ${tocUrl}`);
  const context = await createStealthContext(browser, cookies);
  const page    = await createPage(context);

  try {
    const allLinks = new Map<string, number>(); // url → order
    let   order    = 0;
    const visited  = new Set<string>();
    const queue    = [tocUrl];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      spin.text = `Scraping TOC (page ${visited.size})…`;

      await page.goto(current, { waitUntil, timeout: navTimeoutMs });
      await randomDelay(800, 1800);

      const html    = await page.content();
      const $       = cheerio.load(html);
      const origin  = new URL(tocUrl).origin;

      // ── Collect links ──────────────────────────────────────────────────
      $('a[href]').each((_i: number, el: Element) => {
        const raw = $(el).attr('href');
        if (!raw) return;

        let abs: string;
        try   { abs = raw.startsWith('http') ? raw : new URL(raw, current).toString(); }
        catch { return; }

        // Must be same origin
        try { if (new URL(abs).origin !== origin) return; }
        catch { return; }

        // Skip TOC page itself
        if (abs === tocUrl || abs === current) return;

        // Skip non-chapter URLs
        if (NON_CHAPTER_PATTERNS.some(p => p.test(abs))) return;

        if (!allLinks.has(abs)) {
          allLinks.set(abs, order++);
        }
      });

      // ── Follow TOC pagination (e.g. "next page of TOC") ───────────────
      //  Heuristics: <a rel="next"> OR link text matches "Next" that points
      //  back to same directory as TOC
      const tocPathBase = new URL(tocUrl).pathname.split('/').slice(0, -1).join('/');
      $('a[rel="next"]').each((_i: number, el: Element) => {
        const raw = $(el).attr('href');
        if (!raw) return;
        try {
          const abs = raw.startsWith('http') ? raw : new URL(raw, current).toString();
          if (new URL(abs).origin === origin && !visited.has(abs)) {
            // Only follow if it looks like a TOC page (not a chapter)
            const path = new URL(abs).pathname;
            if (path.startsWith(tocPathBase)) queue.push(abs);
          }
        } catch { /* ignore */ }
      });
    }

    // ── Sort by discovery order and return as array ───────────────────────
    const sorted = [...allLinks.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([url]) => url);

    spin.succeed(`Found ${sorted.length} chapter links across ${visited.size} TOC page(s)`);
    logger.info('TOC scrape complete', { links: sorted.length, pages: visited.size });

    return sorted;
  } catch (e) {
    spin.fail(`TOC scraping failed: ${(e as Error).message}`);
    logger.error('scrapeTOC error', { error: e });
    return [];
  } finally {
    await context.close();
  }
}
