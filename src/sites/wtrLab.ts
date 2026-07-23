import type { Page } from 'playwright';
import type { SiteAdapter, AutoNovelMetadata } from './types.js';
import type { WaitUntil } from '../types.js';
import logger from '../logger/index.js';

const ORIGIN = 'https://wtr-lab.com';

// ── URL helpers ─────────────────────────────────────────────────────────
function isWtrLabUrl(url: string): boolean {
  try { return /(^|\.)wtr-lab\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function tocUrlFor(novelUrl: string): string {
  const u = new URL(novelUrl);
  u.searchParams.set('tab', 'toc');
  return u.toString();
}

// ─────────────────────────────────────────────────────────────────────────
//  Metadata — title / author / description / cover from the novel's
//  landing page.
// ─────────────────────────────────────────────────────────────────────────
async function scrapeMetadata(page: Page, novelUrl: string): Promise<AutoNovelMetadata> {
  await page.goto(novelUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('h1.text-base', { timeout: 15_000 }).catch(() => {/* best-effort */});

  const title = (await page.locator('h1.text-base').first().textContent().catch(() => null))
    ?.trim() || 'Unknown Title';

  const author = (await page.locator('p.text-xs').first().textContent().catch(() => null))
    ?.trim() || 'Unknown';

  const description = (await page.locator('.description').first().textContent().catch(() => null))
    ?.trim() || '';

  let coverUrl: string | undefined;
  const coverSrc = await page.locator('img.relative').first().getAttribute('src').catch(() => null);
  if (coverSrc) {
    coverUrl = coverSrc.startsWith('http')
      ? coverSrc
      : `${ORIGIN}${coverSrc.startsWith('/') ? '' : '/'}${coverSrc}`;
  }

  logger.info('wtr-lab metadata scraped', { title, author, hasCover: !!coverUrl });
  return { title, author, description, coverUrl };
}

// ─────────────────────────────────────────────────────────────────────────
//  Browser-side batch-expander script.
//
//  IMPORTANT: this is passed to page.evaluate() as a STRING, not a function
//  reference. If you pass an actual function, tsx/esbuild's `keepNames`
//  transform wraps any named `const fn = () => ...` inside it with a
//  `__name(fn, "fn")` helper call for nicer stack traces. That helper lives
//  in the Node module scope — Playwright ships the function's *source text*
//  into the browser via .toString(), where `__name` doesn't exist, causing
//  "ReferenceError: __name is not defined". A plain string is never parsed
//  by esbuild as code, so it can't be rewritten — sidestepping the bug
//  entirely. Keep any future page.evaluate() scripts here as strings too.
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
//  Chapter links — the TOC page lazily reveals chapter URLs in batches of
//  ~100 behind buttons. We click every batch button sequentially inside
//  BATCH_EXPAND_SCRIPT, awaiting a render delay after each click.
// ─────────────────────────────────────────────────────────────────────────
async function scrapeChapterLinks(
  page: Page,
  novelUrl: string,
  opts: { waitUntil: WaitUntil; navTimeoutMs: number },
): Promise<string[]> {
  const toc = tocUrlFor(novelUrl);
  await page.goto(toc, { waitUntil: opts.waitUntil, timeout: opts.navTimeoutMs });
  await page.waitForSelector('button', { timeout: 15_000 }).catch(() => {/* best-effort */});
  await page.waitForTimeout(1_000); // let the initial batch list settle

  const rawLinks = await page.evaluate<string[]>(BATCH_EXPAND_SCRIPT);

  logger.info(`wtr-lab TOC harvest: ${rawLinks.length} raw link(s) before ordering fix`);

  return sortByChapterNumber(rawLinks);
}

// ── Order fix ───────────────────────────────────────────────────────────
// The site sometimes renders the tail of the batch out of order (observed:
// the last several chapters come back descending). Rather than special-
// casing "the last five", we recover the *true* order by parsing the
// chapter number straight out of each URL and sorting on it — this stays
// correct no matter how many entries end up scrambled or where.
function sortByChapterNumber(urls: string[]): string[] {
  let unparsed = 0;

  const withKey = urls.map(url => {
    const m = url.match(/chapter-(\d+)(?:[-.](\d+))?/i);
    if (!m) { unparsed++; return { url, key: Number.POSITIVE_INFINITY }; }
    const major = parseInt(m[1], 10);
    const minor = m[2] ? parseInt(m[2], 10) / 1000 : 0; // handles "131-1" style sub-chapters
    return { url, key: major + minor };
  });

  if (unparsed > 0) {
    logger.warn(`${unparsed} chapter URL(s) didn't match the expected pattern — left in discovery order`);
  }

  return withKey.sort((a, b) => a.key - b.key).map(w => w.url);
}

export const wtrLabAdapter: SiteAdapter = {
  id:    'wtr-lab',
  label: 'WTR-LAB (wtr-lab.com)',
  matches: isWtrLabUrl,
  getTocUrl: tocUrlFor,
  scrapeMetadata,
  scrapeChapterLinks,
  defaultContentSelector:  '.chapter-content', // TODO: verify against a real wtr-lab chapter page
  defaultTitleSelector:    undefined,
  defaultSeparateTitle:    false,
  defaultExcludeSelectors: [],
};
