import type { Browser, BrowserContext, Page, Cookie } from 'playwright';
import { createRequire } from 'module';
import logger from '../logger/index.js';

// playwright-extra is CJS internally – safe dynamic require via chromium export
import { chromium as _chromium } from 'playwright-extra';

const require = createRequire(import.meta.url);

// Register stealth plugin (catches: webdriver flag, navigator.plugins, canvas
// fingerprint, WebGL, hairline feature, broken image dimensions, etc.)
try {
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  _chromium.use(StealthPlugin());
  logger.debug('Stealth plugin registered');
} catch (e) {
  logger.warn('puppeteer-extra-plugin-stealth not available – running without stealth');
}

// Cast to the type playwright consumers expect
export const chromium = _chromium as unknown as {
  launch: (opts?: object) => Promise<Browser>;
};

// ── Real UA pool ──────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900  },
  { width: 1366, height: 768  },
  { width: 1280, height: 800  },
  { width: 1536, height: 864  },
];

// ── Singleton browser ─────────────────────────────────────────────────────
let _browser: Browser | null = null;

export async function getBrowser(headless = true): Promise<Browser> {
  if (_browser) return _browser;

  logger.info('Launching browser (stealth mode)…');

  _browser = await (chromium as any).launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  logger.info('Browser ready');
  return _browser!;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
    logger.info('Browser closed');
  }
}

// ── Stealth context factory ───────────────────────────────────────────────
// cookies: optional Playwright Cookie array loaded from the cookie store.
// They are injected after the context is configured so they're present on
// the very first navigation — no login redirect needed.
export async function createStealthContext(
  browser : Browser,
  cookies?: Cookie[],
): Promise<BrowserContext> {
  const ua       = pick(USER_AGENTS);
  const viewport = pick(VIEWPORTS);

  const context = await browser.newContext({
    userAgent : ua,
    viewport,
    locale    : 'en-US',
    timezoneId: 'America/New_York',
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language'         : 'en-US,en;q=0.9',
      'Accept'                  : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'DNT'                     : '1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // ── Block non-essential resources (ads, tracking, media) ──────────────
  await context.route('**/*', (route) => {
    const rt  = route.request().resourceType();
    const url = route.request().url();

    const blocked =
      rt === 'media' ||
      rt === 'font'  ||
      url.includes('google-analytics')  ||
      url.includes('googletagmanager')  ||
      url.includes('doubleclick.net')   ||
      url.includes('facebook.net')      ||
      url.includes('adsbygoogle')       ||
      url.includes('amazon-adsystem')   ||
      url.includes('hotjar.com')        ||
      url.includes('disqus.com');

    blocked ? route.abort() : route.continue();
  });

  // ── Deep JS stealth overrides ─────────────────────────────────────────
  await context.addInitScript(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // navigator.languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Realistic plugin list
    const pluginData = [
      { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',           description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client',      filename: 'internal-nacl-plugin',           description: '' },
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = pluginData.map(p => {
          const mime = { type: 'application/x-nacl', suffixes: '', description: '', enabledPlugin: null };
          return Object.assign(Object.create(Plugin.prototype), { ...p, length: 1, 0: mime });
        });
        return Object.assign(arr, { length: arr.length, namedItem: (n: string) => arr.find(p => p.name === n), refresh: () => {} });
      },
    });

    // chrome object
    (window as unknown as Record<string, unknown>).chrome = {
      runtime: {}, loadTimes: () => {}, csi: () => {}, app: {},
    };

    // Permissions
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    window.navigator.permissions.query = (p: PermissionDescriptor) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus)
        : origQuery(p);

    // Canvas noise – subtle fingerprint perturbation
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    const noisePixel = () => Math.floor(Math.random() * 10) - 5;

    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const pxl = ctx.getImageData(0, 0, 1, 1);
        pxl.data[0] = Math.min(255, Math.max(0, pxl.data[0] + noisePixel()));
        ctx.putImageData(pxl, 0, 0);
      }
      return toDataURL.apply(this, args as Parameters<typeof toDataURL>);
    };
    HTMLCanvasElement.prototype.toBlob = toBlob;
    CanvasRenderingContext2D.prototype.getImageData = getImageData;
  });

  // ── Inject stored cookies ─────────────────────────────────────────────
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    logger.debug(`Injected ${cookies.length} stored cookie(s) into context`);
  }

  return context;
}

// ── Page factory ──────────────────────────────────────────────────────────
export async function createPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();

  await page.setExtraHTTPHeaders({
    'sec-ch-ua'         : '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile'  : '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest'    : 'document',
    'sec-fetch-mode'    : 'navigate',
    'sec-fetch-site'    : 'none',
    'sec-fetch-user'    : '?1',
  });

  return page;
}

// ── Utility ───────────────────────────────────────────────────────────────
export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
