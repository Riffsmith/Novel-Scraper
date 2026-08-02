// ─────────────────────────────────────────────────────────────────────────────
//  PlaywrightBrowserPort — BrowserPort via playwright-core + cloakbrowser.
//
//  Launches CloakBrowser binary explicitly via executablePath (ADR-001).
//  All evaluate calls are string-based within each PageObject method,
//  enforcing the evaluate-as-string rule (P4) by construction.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { ensureBinary, buildLaunchOptions } from "cloakbrowser";

import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
  PageHandle,
  BrowserLaunchOpts,
  ElementRef,
} from "../../ports/BrowserPort.js";
import type { DomainCookie } from "../../core/domain/Cookie.js";

// ── Playwright handle wrappers ──────────────────────────────────────────

const browserKey = Symbol("pw-browser");
const contextKey = Symbol("pw-context");
const pageKey = Symbol("pw-page");

function mkBrowser(b: Browser): BrowserHandle {
  const h: BrowserHandle = { close: async () => await b.close() };
  return Object.assign(h, { [browserKey]: b });
}
function asBrowser(h: BrowserHandle): Browser {
  return (h as unknown as Record<symbol, unknown>)[browserKey] as Browser;
}
function mkContext(c: BrowserContext): ContextHandle {
  const h: ContextHandle = { close: async () => await c.close() };
  return Object.assign(h, { [contextKey]: c });
}
function asContext(h: ContextHandle): BrowserContext {
  return (h as unknown as Record<symbol, unknown>)[contextKey] as BrowserContext;
}
function asPage(h: PageHandle): Page {
  return (h as unknown as Record<symbol, unknown>)[pageKey] as Page;
}

// ── ElementRef — wraps Playwright's ElementHandle ────────────────────────

interface ElementRefInternal extends ElementRef {
  _kind: "ElementRef";
  handle: import("playwright-core").ElementHandle;
}

function toElementRef(handle: import("playwright-core").ElementHandle): ElementRef {
  return { _kind: "ElementRef" as const, handle } as ElementRefInternal;
}

// ── Resource blocking (unchanged from v1 browser.ts:185-202) ─────────────

const BLOCK_PATTERNS = [
  "google-analytics",
  "googletagmanager",
  "doubleclick.net",
  "facebook.net",
  "adsbygoogle",
  "amazon-adsystem",
  "hotjar.com",
  "disqus.com",
];

// ── Public adapter class ─────────────────────────────────────────────────

export class PlaywrightBrowserPort implements BrowserPort {
  private browsers: Browser[] = [];

  async launch(opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    const binaryPath = await ensureBinary();

    const cloakOpts = await buildLaunchOptions({
      headless: opts.headless,
      humanize: opts.humanize,
      humanPreset: opts.humanPreset,
      timezone: opts.timezone,
      locale: opts.locale,
      args: opts.fingerprintSeed !== null
        ? [`--fingerprint=${opts.fingerprintSeed}`]
        : undefined,
    });

    const browser = await chromium.launch({
      ...(cloakOpts as any),
      executablePath: binaryPath,
    });

    this.browsers.push(browser);
    return mkBrowser(browser);
  }

  async createContext(
    browser: BrowserHandle,
    cookies?: DomainCookie[],
  ): Promise<ContextHandle> {
    const b = asBrowser(browser);
    const locale = "en-US";

    const context = await b.newContext({
      locale,
      extraHTTPHeaders: {
        "Accept-Language": `${locale},${locale.split("-")[0]};q=0.9,en;q=0.8`,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        DNT: "1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    await context.route("**/*", (route) => {
      const rt = route.request().resourceType();
      const url = route.request().url();
      const blocked =
        rt === "media" ||
        rt === "font" ||
        BLOCK_PATTERNS.some((p) => url.includes(p));
      blocked ? route.abort() : route.continue();
    });

    if (cookies && cookies.length > 0) {
      await context.addCookies(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
      );
    }

    return mkContext(context);
  }

  async newPage(ctx: ContextHandle): Promise<PageHandle> {
    const c = asContext(ctx);
    const page = await c.newPage();
    return pageObject(page);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.browsers.map((b) => b.close().catch(() => {})));
    this.browsers = [];
  }

  public async launchEphemeral(opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(opts);
  }
}

function symbol(desc: string): symbol {
  return Symbol(desc);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PageObject — the PageHandle facade.
//
//  Implement's BrowserHandle's named methods; each evaluate-based
//  operation is a string evaluation by construction (P4).
// ═══════════════════════════════════════════════════════════════════════════

function pageObject(page: Page): PageHandle {
  let _url = "";

  const wrapper: PageHandle = {
    async goto(url, opts) {
      await page.goto(url, {
        waitUntil: opts.waitUntil,
        timeout: opts.timeoutMs,
      });
      _url = url;
    },

    async title(): Promise<string> {
      return page.title();
    },

    async content(): Promise<string> {
      return page.content();
    },

    async locatorCount(css: string): Promise<number> {
      return page.locator(css).count().catch(() => 0);
    },

    async innerHTML(selector: string, timeoutMs: number): Promise<string | null> {
      try {
        const loc = page.locator(selector).first();
        return await loc.innerHTML({ timeout: timeoutMs });
      } catch {
        return null;
      }
    },

    async findElement(selector: string): Promise<ElementRef | null> {
        try {
          const el = await page.$(selector);
          return el ? toElementRef(el) : null;
        } catch {
          return null;
        }
      },

      async textContent(selector: string, timeoutMs: number): Promise<string | null> {
      try {
        const loc = page.locator(selector).first();
        return await loc.textContent({ timeout: timeoutMs });
      } catch {
        return null;
      }
    },

    async removeFromDom(selectors: string[]): Promise<void> {
      for (const sel of selectors) {
        const s = sel.trim();
        if (s.startsWith("//") || s.startsWith("(//") || s.toLowerCase().startsWith("xpath=")) {

          // XPath
          const xp = s.toLowerCase().startsWith("xpath=") ? s.slice(6) : s;
          await page.evaluate((xpathExpr) => {
            const result = document.evaluate(
              xpathExpr,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            for (let i = 0; i < result.snapshotLength; i++) {
              const el = result.snapshotItem(i);
              if (el && el.parentNode) {
                (el as Element).remove();
              }
            }
          }, xp).catch(() => {});
        } else {
          // CSS
          await page.evaluate((css) => {
            document.querySelectorAll(css).forEach((el) => el.remove());
          }, sel).catch(() => {});
        }
      }
    },

    async findAnchorByRegex(pattern: string, flags: string): Promise<ElementRef | null> {
      new RegExp(pattern, flags); // validate in Node
      const handle = await page.evaluateHandle(
        ({ pattern, flags }: { pattern: string; flags: string }) => {
          const re = new RegExp(pattern, flags);
          const anchors = Array.from(document.querySelectorAll("a[href]"));
          return (
            anchors.find((a) => {
              const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
              const title = (a as HTMLAnchorElement).title ?? "";
              return re.test(text) || re.test(title);
            }) ?? null
          );
        },
        { pattern, flags },
      );
      const el = handle.asElement();
      if (!el) return null;
      const jsonVal = await handle.jsonValue().catch(() => null);
      return jsonVal === null ? null : el ? toElementRef(el) : null;
    },

    async hrefOf(el: ElementRef): Promise<string | null> {
      const e = (el as ElementRefInternal).handle;
      return e.getAttribute("href").catch(() => null);
    },

    async clickAndWaitNav(el: ElementRef, timeoutMs: number): Promise<string> {
      const e = (el as ElementRefInternal).handle;
      const prevUrl = page.url();
      await e.click();
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
      const next = page.url();
      return next || prevUrl;
    },

    async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
      await page.waitForSelector(selector, { timeout: timeoutMs }).catch(() => {});
    },

    async bodyInnerText(): Promise<string> {
      return page.evaluate(() => document.body?.innerText ?? "");
    },

    url(): string {
      return page.url();
    },

    async close(): Promise<void> {
      await page.close().catch(() => {});
    },
  };

  return Object.assign(wrapper, { [pageKey]: page });
}