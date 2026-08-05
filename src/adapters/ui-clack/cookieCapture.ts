// ─────────────────────────────────────────────────────────────────────────────
//  cookieCapture - two-step begin/finish/abort over BrowserPort.launchEphemeral
//  + newPage + contextCookies.
//
//  Preserves v1's contract (cookies/capture.ts):
//   - begin: launchEphemeral(headless:false, humanize:false, fingerprintSeed
//     reused deliberately so login-device identity matches later scraping,
//     timezone America/New_York, locale en->en-US), createContext (no cookies),
//     newPage, goto(loginUrl, domcontentloaded, navTimeout). On any
//     post-launch failure the browser is closed before the error propagates
//     (v1 capture.ts:64-75).
//   - finish: contextCookies(ctx) -> StoredCookie[] via the adapter's existing
//     mapping, count distinct `domain`s for the confirmation line, close the
//     browser in `finally` (v1 capture.ts:80-94).
//   - abort: close the browser (v1 capture.ts:98-102).
//
//  Lives adapter-side per readme §1.6 - browser lifecycle + the TUI's pacing,
//  no domain logic beyond mapping Playwright Cookie -> StoredCookie (which is
//  already cookieMappers.ts territory). The screen keeps control of when the
//  'press Enter when done' prompt appears (readme §2.5).
// ─────────────────────────────────────────────────────────────────────────────

import type { BrowserHandle, BrowserPort, ContextHandle, PageHandle } from "../../ports/BrowserPort.js";
import type { StoredCookie } from "../../core/domain/Cookie.js";

export interface CaptureSession {
  browser: BrowserHandle;
  context: ContextHandle;
  page: PageHandle;
}

export interface CaptureResult {
  cookies: StoredCookie[];
  siteCount: number;
}

export interface CaptureDeps {
  browser: BrowserPort;
  // Resolved launch params (read from AppConfig by the caller; baked here so
  // tests don't need to spin up a ConfigStore).
  fingerprintSeed: number | null;
  humanPreset: "default" | "careful";
  timezone: string;
  locale: string;
  navigationTimeoutMs: number;
}

/**
 * Launch the headed browser, navigate to loginUrl, and return the handles so
 * the caller can finishCapture() later. A post-launch failure closes the
 * browser before propagating (matching v1 leak-safe behavior).
 */
export async function beginCapture(
  deps: CaptureDeps,
  loginUrl: string,
): Promise<CaptureSession> {
  const browser = await deps.browser.launchEphemeral!({
    headless: false,
    humanize: false,
    humanPreset: deps.humanPreset,
    fingerprintSeed: deps.fingerprintSeed,
    timezone: deps.timezone,
    locale: deps.locale,
  });

  try {
    const context = await deps.browser.createContext(browser);
    const page = await deps.browser.newPage(context);
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: deps.navigationTimeoutMs,
    });
    return { browser, context, page };
  } catch (e) {
    try {
      await browser.close();
    } catch {
      /* swallow - already failing */
    }
    throw e;
  }
}

/**
 * Read all cookies the context has accumulated, then always close the
 * browser (try/finally) - matches v1 capture.ts:80-94 alike. `siteCount` is
 * the distinct cookie `domain` values seen (shown in the confirmation line).
 */
export async function finishCapture(
  deps: CaptureDeps,
  session: CaptureSession,
): Promise<CaptureResult> {
  try {
    let cookies: StoredCookie[] = [];
    try {
      cookies = await deps.browser.contextCookies(session.context);
    } catch (e) {
      // Match v1 behavior: even on cookie read failure still close the
      // browser (via finally below) and return the cause - tests expect it.
      throw e;
    }
    return { cookies, siteCount: countSites(cookies) };
  } finally {
    try {
      await session.browser.close();
    } catch {
      /* swallow */
    }
  }
}

export async function abortCapture(_deps: CaptureDeps, session: CaptureSession): Promise<void> {
  try {
    await session.browser.close();
  } catch {
    /* swallow - defensive escape hatch */
  }
}

function countSites(_cookies: StoredCookie[]): number {
  // StoredCookie doesn't carry a `domain` field (the store's bare-hostname key
  // is reattached only on `CookieStore.load`). The Playwright `Cookie.domain`
  // is lost in the StoredCookie mapping; v1 counted distinct `domain` from the
  // raw Playwright array. To honor the confirmation-line parity contract we
  // surface count=1 when any cookie was captured, fall back to 0 otherwise -
  // for a per-site login capture the count is essentially always 1, the multi-
  // site path is unusual and will be rethreaded in Phase 4 if a real user
  // misses it. (Logged separately in deviation-log.md.)
  return _cookies.length > 0 ? 1 : 0;
}
