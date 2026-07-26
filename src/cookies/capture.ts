// ─────────────────────────────────────────────────────────────────────────────
//  Cookie capture — isolated headed-browser login flow
//
//  Two-step API (begin/finish) rather than one callback-taking function, so
//  the TUI stays fully in control of *when* to prompt, and each half is
//  independently leak-safe (a failure between the two calls is handled by the
//  caller via abortCaptureSession).
// ─────────────────────────────────────────────────────────────────────────────

import type { Browser, BrowserContext, Cookie as PWCookie } from "playwright";
import {
  launchEphemeralBrowser,
  closeEphemeralBrowser,
  createStealthContext,
  createPage,
} from "../scraper/browser.js";
import type { AppConfig } from "../types.js";
import type { StoredCookie } from "./store.js";
import logger from "../logger/index.js";

export interface CaptureSession {
  browser: Browser;
  context: BrowserContext;
}

export interface CaptureResult {
  cookies: StoredCookie[];
  siteCount: number; // distinct cookie "domain" values seen — shown in the confirmation screen
}

function toStoredCookies(cookies: PWCookie[]): StoredCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: (c.sameSite ?? "Lax") as StoredCookie["sameSite"],
  }));
}

// Launches the isolated browser, opens the login page, and returns as soon as
// it's ready for the person to interact with. Self-contained: if anything
// after the browser launch fails (bad URL, nav timeout), the browser is
// closed before the error propagates — callers never have to worry about a
// partial-failure leak.
export async function beginCaptureSession(
  loginUrl: string,
  appCfg: AppConfig,
): Promise<CaptureSession> {
  const locale =
    appCfg.defaultLanguage === "en" ? "en-US" : appCfg.defaultLanguage;

  const browser = await launchEphemeralBrowser({
    headless: false, // must be headed — a human drives this
    humanize: false, // no synthetic interaction happens here
    humanPreset: appCfg.humanPreset,
    fingerprintSeed: appCfg.fingerprintSeed, // reused deliberately — see note in the header of cookieManager's captureViaLoginFlow
    timezone: "America/New_York",
    locale,
  });

  try {
    const context = await createStealthContext(browser, undefined, locale); // no pre-seeded cookies
    const page = await createPage(context);
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: appCfg.navigationTimeoutMs,
    });
    return { browser, context };
  } catch (e) {
    await closeEphemeralBrowser(browser);
    throw e;
  }
}

// Reads back whatever cookies the session accumulated, then always closes the
// browser (try/finally) regardless of success or failure.
export async function finishCaptureSession(
  session: CaptureSession,
): Promise<CaptureResult> {
  try {
    const rawCookies = await session.context.cookies(); // no URL filter — see D2: safer to keep everything, unrelated cookies are inert on replay
    const stored = toStoredCookies(rawCookies);
    const siteCount = new Set(rawCookies.map((c) => c.domain)).size;
    logger.info(
      `Captured ${stored.length} cookie(s) across ${siteCount} site(s) via manual login`,
    );
    return { cookies: stored, siteCount };
  } finally {
    await closeEphemeralBrowser(session.browser);
  }
}

// Defensive escape hatch for the TUI's catch block — belt-and-suspenders in
// case future code is added between begin/finish that can throw.
export async function abortCaptureSession(
  session: CaptureSession,
): Promise<void> {
  await closeEphemeralBrowser(session.browser);
}
