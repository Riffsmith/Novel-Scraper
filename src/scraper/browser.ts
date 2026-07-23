// ─────────────────────────────────────────────────────────────────────────────
//  Browser — CloakBrowser-backed launcher
//
//  CloakBrowser is a custom Chromium binary with 58 source-level C++ patches
//  covering canvas, WebGL, audio, GPU, screen, WebRTC, automation signals, and
//  CDP input behavior.  It is a drop-in Playwright replacement: launch() returns
//  a standard Playwright Browser object — all context/page APIs work unchanged.
//
//  What CloakBrowser owns (we do NOT duplicate these):
//    • navigator.webdriver removal
//    • plugin list, window.chrome, permissions API
//    • canvas / WebGL / audio noise
//    • UA string, sec-ch-ua client hints
//    • Fingerprint seed → coherent GPU/screen/hardware values
//    • humanize → Bézier mouse curves, per-character typing, scroll patterns
//
//  What we own (network / session layer, not fingerprint):
//    • Resource blocking (ads, trackers, media — bandwidth / speed)
//    • Cookie injection (domain session management)
//    • Accept-Language / Accept headers (HTTP level, complements binary UA)
// ─────────────────────────────────────────────────────────────────────────────

import type { Browser, BrowserContext, Page, Cookie } from 'playwright';
import { createRequire } from 'module';
import logger from '../logger/index.js';

// ── CloakBrowser launch options ───────────────────────────────────────────────
export interface BrowserLaunchOpts {
  headless        : boolean;
  // humanize=true → Bézier mouse curves, per-character keyboard timing, human
  // scroll patterns on every page.click / page.fill / page.type call.
  humanize        : boolean;
  humanPreset     : 'default' | 'careful';
  // fingerprintSeed: deterministic fingerprint across sessions (same seed = same
  // GPU/screen/canvas on every launch).  null = new random identity each time.
  fingerprintSeed : number | null;
  timezone        : string;
  locale          : string;
}

// ── Singleton browser ─────────────────────────────────────────────────────────
let _browser: Browser | null = null;
let _launchOpts: BrowserLaunchOpts | null = null;

export async function getBrowser(opts: BrowserLaunchOpts): Promise<Browser> {
  if (_browser) return _browser;

  logger.info('Launching CloakBrowser (source-level stealth Chromium)…', {
    headless    : opts.headless,
    humanize    : opts.humanize,
    humanPreset : opts.humanPreset,
    seed        : opts.fingerprintSeed ?? 'random',
    timezone    : opts.timezone,
    locale      : opts.locale,
  });

  // Dynamically require cloakbrowser (CJS-compatible path)
  const { launch } = await import('cloakbrowser');

  const extraArgs: string[] = [];
  if (opts.fingerprintSeed !== null) {
    extraArgs.push(`--fingerprint=${opts.fingerprintSeed}`);
  }

  _browser = await launch({
    headless    : opts.headless,
    humanize    : opts.humanize,
    humanPreset : opts.humanPreset,
    timezone    : opts.timezone,
    locale      : opts.locale,
    args        : extraArgs,
  }) as Browser;

  _launchOpts = opts;

  logger.info('CloakBrowser ready');
  return _browser!;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser    = null;
    _launchOpts = null;
    logger.info('Browser closed');
  }
}

// ── Context factory ───────────────────────────────────────────────────────────
// CloakBrowser has already patched the binary-level fingerprint via launch().
// Here we handle the network/session layer only:
//   • Resource blocking (ads, trackers, media)
//   • Cookie injection (domain session management)
//   • Accept / Accept-Language HTTP headers
//
// We intentionally do NOT set userAgent, viewport, or addInitScript — those
// would conflict with CloakBrowser's coherent fingerprint profile.
export async function createStealthContext(
  browser : Browser,
  cookies?: Cookie[],
): Promise<BrowserContext> {
  const locale = _launchOpts?.locale ?? 'en-US';

  const context = await browser.newContext({
    // locale/timezoneId are already baked into the binary via launch() flags.
    // Repeating them here is harmless but unnecessary — we pass locale so
    // Playwright's JS-side navigator.language matches the binary UA.
    locale,
    extraHTTPHeaders: {
      'Accept-Language'          : `${locale},${locale.split('-')[0]};q=0.9,en;q=0.8`,
      'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'DNT'                      : '1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // ── Block non-essential resources ─────────────────────────────────────────
  // This is a bandwidth / speed optimisation — not stealth. Fonts, media, and
  // major ad/analytics networks are aborted before they waste time or reveal
  // automation patterns via timing.
  await context.route('**/*', (route) => {
    const rt  = route.request().resourceType();
    const url = route.request().url();

    const blocked =
      rt === 'media'                         ||
      rt === 'font'                          ||
      url.includes('google-analytics')       ||
      url.includes('googletagmanager')       ||
      url.includes('doubleclick.net')        ||
      url.includes('facebook.net')           ||
      url.includes('adsbygoogle')            ||
      url.includes('amazon-adsystem')        ||
      url.includes('hotjar.com')             ||
      url.includes('disqus.com');

    blocked ? route.abort() : route.continue();
  });

  // ── Inject stored cookies ─────────────────────────────────────────────────
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    logger.debug(`Injected ${cookies.length} stored cookie(s) into context`);
  }

  return context;
}

// ── Page factory ──────────────────────────────────────────────────────────────
// No manual sec-ch-ua headers here — CloakBrowser's binary sets correct Client
// Hints automatically, matching the spoofed UA.  Overriding them would create
// a mismatch that detection systems can catch.
export async function createPage(context: BrowserContext): Promise<Page> {
  return context.newPage();
}

// ── Utility ───────────────────────────────────────────────────────────────────
export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}
