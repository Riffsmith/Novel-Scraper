import type { Browser, ElementHandle, Cookie } from 'playwright';
import { createStealthContext, createPage, randomDelay } from './browser.js';
import { findAnchorByRegex, toPlaywrightXPath, isXPath, formatLocator } from './selectors.js';
import type { NextLocator } from '../types.js';
import logger from '../logger/index.js';
import { spinner } from '../tui/display.js';
import chalk from 'chalk';

const MAX_CHAPTERS = 10_000;

// ── Result of resolving the next-button on one page ───────────────────────
interface NextResolution {
  element     : ElementHandle;
  locatorIdx  : number;
  locator     : NextLocator;
}

// ── Try each locator in priority order, return first match ────────────────
async function resolveNextElement(
  page    : import('playwright').Page,
  locators: NextLocator[],
): Promise<NextResolution | null> {
  for (let i = 0; i < locators.length; i++) {
    const loc = locators[i];
    try {
      let el: ElementHandle | null = null;

      if (loc.kind === 'css') {
        // Standard CSS selector
        el = await page.$(loc.value);

      } else if (loc.kind === 'xpath') {
        // XPath — use Playwright's built-in xpath= prefix
        el = await page.$(toPlaywrightXPath(loc.value));

      } else if (loc.kind === 'regex') {
        // Scan all <a href> elements; match on text / title attribute
        el = await findAnchorByRegex(page, loc.value, loc.flags ?? 'i');
      }

      if (el) return { element: el, locatorIdx: i, locator: loc };

    } catch (e) {
      logger.debug(`Locator #${i} (${loc.kind}) error: ${(e as Error).message}`);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Walk from firstUrl → lastUrl using an ordered priority list of locators.
//
//  Locator resolution (per page, in order):
//    css   → page.$(selector)
//    xpath → page.$('xpath=...')
//    regex → scan <a href> by innerText / title attribute
//
//  A fallback (index > 0) is only used when every higher-priority locator
//  found no matching element on that page. Fallback usage is logged as a
//  warning so the user can audit which chapters had anomalous layout.
//
//  Per-element navigation:
//    A) href present → resolve URL directly (no click overhead)
//    B) No usable href → click + await navigation
// ═══════════════════════════════════════════════════════════════════════════
export async function collectLinksSequentially(
  browser      : Browser,
  firstUrl     : string,
  lastUrl      : string,
  locators     : NextLocator[],
  delayMin     : number  = 600,
  delayMax     : number  = 1_500,
  cookies?     : Cookie[],
  waitUntil    : 'domcontentloaded' | 'networkidle' | 'load' = 'domcontentloaded',
  navTimeoutMs : number = 30_000,
): Promise<string[]> {
  if (locators.length === 0) {
    throw new Error('At least one next-button locator is required');
  }

  const hasFallbacks = locators.length > 1;
  const spin         = spinner('Collecting chapter URLs via navigation…');
  const context      = await createStealthContext(browser, cookies);
  const page         = await createPage(context);

  const links: string[]  = [];
  const visited           = new Set<string>();
  let   currentUrl        = firstUrl;

  // Per-locator usage stats for end-of-run summary
  const hits: number[] = new Array(locators.length).fill(0);

  try {
    while (currentUrl && links.length < MAX_CHAPTERS) {
      if (visited.has(currentUrl)) {
        spin.warn(`Navigation loop detected at ${currentUrl} — stopping`);
        break;
      }
      visited.add(currentUrl);
      links.push(currentUrl);

      spin.text = `Collecting URLs… ${links.length} chapter(s)`;

      if (currentUrl === lastUrl) {
        spin.succeed(`Reached last chapter. Collected ${links.length} URL(s).`);
        break;
      }

      // ── Navigate ───────────────────────────────────────────────────────
      try {
        await page.goto(currentUrl, { waitUntil, timeout: navTimeoutMs });
        await randomDelay(Math.floor(delayMin * 0.4), Math.floor(delayMax * 0.4));
      } catch (e) {
        logger.error(`Navigation failed: ${currentUrl}`, { error: (e as Error).message });
        break;
      }

      // ── Resolve next-button ────────────────────────────────────────────
      const resolved = await resolveNextElement(page, locators);

      if (!resolved) {
        const tried = locators
          .map((l, i) => `  ${i === 0 ? 'primary  ' : `fallback ${i}`}: ${formatLocator(l)}`)
          .join('\n');
        logger.warn(`No next-button found at ch.${links.length}.\nTried:\n${tried}`);

        if (hasFallbacks) {
          spin.warn(
            `No "Next" element found at chapter ${links.length} after trying all ${locators.length} locators.\n` +
            `  This may be the final chapter or a layout gap not covered by any locator.`,
          );
        } else {
          spin.succeed(`No more chapters detected. Collected ${links.length} URL(s).`);
        }
        break;
      }

      // ── Log fallback usage ─────────────────────────────────────────────
      hits[resolved.locatorIdx]++;

      if (resolved.locatorIdx > 0) {
        const lbl = formatLocator(resolved.locator);
        logger.warn(
          `Fallback #${resolved.locatorIdx} used at chapter ${links.length}: ${lbl}`,
          { url: currentUrl },
        );
        spin.text = chalk.yellow(
          `⚠  Fallback #${resolved.locatorIdx} triggered at ch.${links.length}: ${lbl}`,
        );
        await new Promise(r => setTimeout(r, 1_200));
      }

      // ── Strategy A: direct href resolution ────────────────────────────
      const href = await resolved.element.getAttribute('href').catch(() => null);
      if (href?.trim() && !href.startsWith('#') && !/^javascript:/i.test(href)) {
        try {
          currentUrl = href.startsWith('http')
            ? href.trim()
            : new URL(href.trim(), currentUrl).toString();
          await randomDelay(Math.floor(delayMin * 0.3), Math.floor(delayMax * 0.3));
          continue;
        } catch { /* fall through to click */ }
      }

      // ── Strategy B: click → await navigation ──────────────────────────
      try {
        const prevUrl = page.url();
        await resolved.element.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
        const newUrl = page.url();
        if (newUrl === prevUrl) {
          logger.warn('Click did not change URL — stopping');
          break;
        }
        currentUrl = newUrl;
      } catch (e) {
        logger.error(`Click navigation failed at ${currentUrl}`, { error: (e as Error).message });
        break;
      }

      await randomDelay(Math.floor(delayMin * 0.3), Math.floor(delayMax * 0.3));
    }

    if (links.length >= MAX_CHAPTERS) spin.warn(`Safety limit (${MAX_CHAPTERS}) reached`);

    if (lastUrl && !links.includes(lastUrl) && links.length > 0) {
      logger.warn(
        `Last chapter URL never reached.\n` +
        `  Last visited: ${links.at(-1)}\n` +
        `  Causes: wrong locator, locked chapters, or a navigation gap.`,
      );
    }

    // Locator usage summary (only when fallbacks exist — shows which locators
    // covered which parts of the novel)
    if (hasFallbacks) {
      const summary = locators.map((l, i) =>
        `  ${i === 0 ? 'primary  ' : `fallback ${i}`}  ${formatLocator(l)}  → ${hits[i]} chapter(s)`,
      ).join('\n');
      logger.info(`Locator usage summary:\n${summary}`);
    }

    return links;

  } catch (e) {
    spin.fail(`Sequential collection failed: ${(e as Error).message}`);
    logger.error('collectLinksSequentially error', { error: e });
    return links;
  } finally {
    await context.close();
  }
}
