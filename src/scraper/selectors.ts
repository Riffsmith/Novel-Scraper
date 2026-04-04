// ─────────────────────────────────────────────────────────────────────────────
//  Selector helpers — shared between chapter.ts, sequential.ts, and toc.ts.
//  Provides XPath detection + normalisation, and the regex anchor-finder used
//  by the sequential collector.
// ─────────────────────────────────────────────────────────────────────────────

import type { Page, ElementHandle } from 'playwright';

// ── XPath detection ──────────────────────────────────────────────────────────
// A selector is treated as XPath if it:
//   • starts with "//"                 → absolute path  e.g. //div[@class='c']
//   • starts with "(//"               → wrapped path   e.g. (//a)[1]
//   • starts with "xpath=" (case-ins) → explicit prefix
export function isXPath(sel: string): boolean {
  const s = sel.trim();
  return s.startsWith('//') || s.startsWith('(//')
      || s.toLowerCase().startsWith('xpath=');
}

// Normalise to "xpath=..." so Playwright's selector engine handles it.
export function toPlaywrightXPath(sel: string): string {
  const s = sel.trim();
  return s.toLowerCase().startsWith('xpath=') ? s : `xpath=${s}`;
}

// ── Playwright wait-for helper that supports both CSS and XPath ───────────────
export async function waitForSelector(
  page   : Page,
  sel    : string,
  timeout: number = 10_000,
): Promise<void> {
  const pwSel = isXPath(sel) ? toPlaywrightXPath(sel) : sel;
  await page.waitForSelector(pwSel, { timeout }).catch(() => {/* best-effort */});
}

// ── Extract innerHTML via Playwright (supports CSS & XPath) ──────────────────
// Returns null when the element is not found rather than throwing.
export async function extractInnerHtml(
  page: Page,
  sel : string,
): Promise<string | null> {
  try {
    const pwSel = isXPath(sel) ? toPlaywrightXPath(sel) : sel;
    const loc   = page.locator(pwSel).first();
    return await loc.innerHTML({ timeout: 8_000 });
  } catch {
    return null;
  }
}

// ── Extract text content via Playwright (supports CSS & XPath) ───────────────
export async function extractTextContent(
  page: Page,
  sel : string,
): Promise<string | null> {
  try {
    const pwSel = isXPath(sel) ? toPlaywrightXPath(sel) : sel;
    const loc   = page.locator(pwSel).first();
    return await loc.textContent({ timeout: 5_000 });
  } catch {
    return null;
  }
}

// ── Remove elements from the live DOM (CSS or XPath) ────────────────────────
// Used by chapter.ts to strip excluded selectors before extracting content.
export async function removeFromDom(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    if (isXPath(sel)) {
      // For XPath we use document.evaluate inside the page
      const expr = sel.trim().toLowerCase().startsWith('xpath=')
        ? sel.trim().slice(6)
        : sel.trim();
      await page.evaluate((xp) => {
        const result = document.evaluate(
          xp, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null,
        );
        for (let i = 0; i < result.snapshotLength; i++) {
          (result.snapshotItem(i) as Element)?.remove();
        }
      }, expr).catch(() => {/* selector may match nothing – fine */});
    } else {
      // CSS: fast querySelectorAll removal
      await page.evaluate((css) => {
        document.querySelectorAll(css).forEach(el => el.remove());
      }, sel).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Regex anchor-finder
//
//  Scans every <a href> on the page and returns the first element whose
//  visible text content or title attribute matches the supplied regex.
//
//  Matches are tested against:
//    • innerText  (decoded, whitespace-normalised)
//    • title attribute
//
//  The search runs inside the browser context so the regex is serialised as
//  a { pattern, flags } pair and reconstructed inside page.evaluateHandle.
// ═══════════════════════════════════════════════════════════════════════════
export async function findAnchorByRegex(
  page   : Page,
  pattern: string,
  flags  : string = 'i',
): Promise<ElementHandle | null> {
  // Validate the regex in Node context first (gives a clear error before
  // sending it to the browser where the error would be swallowed)
  new RegExp(pattern, flags); // throws on invalid pattern/flags

  const handle = await page.evaluateHandle(
    ({ pattern, flags }: { pattern: string; flags: string }) => {
      const re      = new RegExp(pattern, flags);
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors.find(a => {
        const text  = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
        const title = (a as HTMLAnchorElement).title ?? '';
        return re.test(text) || re.test(title);
      }) ?? null;
    },
    { pattern, flags },
  );

  const el = handle.asElement();
  // evaluateHandle can return a JSHandle wrapping null — unwrap correctly
  if (!el) return null;
  const jsonVal = await handle.jsonValue().catch(() => null);
  return jsonVal === null ? null : el;
}

// ── Format a NextLocator for display in the TUI ───────────────────────────────
export function formatLocator(loc: { kind: string; value: string; flags?: string }): string {
  switch (loc.kind) {
    case 'css'  : return `[css]   ${loc.value}`;
    case 'xpath': return `[xpath] ${loc.value}`;
    case 'regex': return `[regex/${loc.flags ?? 'i'}] ${loc.value}`;
    default     : return `[?]     ${loc.value}`;
  }
}
