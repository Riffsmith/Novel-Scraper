// ─────────────────────────────────────────────────────────────────────────────
//  FakeBrowserPort — completely synthetic BrowserPort for unit tests.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
  PageHandle,
  BrowserLaunchOpts,
  ElementRef,
  WaitUntil,
  } from "../../ports/BrowserPort.js";
import type { DomainCookie, StoredCookie } from "../../core/domain/Cookie.js";


export class FakePage implements PageHandle {
  private $: cheerio.CheerioAPI;
  /** URLs handed to `goto(...)` - exposed via the FakeBrowserPort for tests
   *  that assert on what was actually navigated to (ADR-P3-FIX-TUI /
   *  fix-issue-tui-url-cleanliness §2.5). */
  gotoCalls: string[] = [];

  constructor(private html: string) {
    this.$ = cheerio.load(html);
  }

  goto = async (url: string, _opts: { waitUntil: WaitUntil; timeoutMs: number }) => {
    this.gotoCalls.push(url);
  };
  title = async () => this.extractTitle();
  content = async () => this.html;
  urlRef = "";
  url = () => this.urlRef;
  close = async () => {};

  async locatorCount(css: string): Promise<number> {
    return this.$(css).length;
  }

  async innerHTML(selector: string, _timeout: number): Promise<string | null> {
    const el = this.$(selector).first();
    if (!el.length) return null;
    return el.html() ?? null;
  }

  async textContent(selector: string, _timeout: number): Promise<string | null> {
    const el = this.$(selector).first();
    if (!el.length) return null;
    return el.text();
  }

  async removeFromDom(_selectors: string[]) {}

  async findAnchorByRegex(pattern: string, flags: string): Promise<ElementRef | null> {
    const re = new RegExp(pattern, flags);
    let found: unknown = null;
    this.$("a[href]").each((_i, el) => {
      if (found) return false;
      const text = this.$(el).text();
      const title = this.$(el).attr("title") ?? "";
      if (re.test(text) || re.test(title)) {
        found = el;
        return false;
      }
    });
    return found ? { _kind: "ElementRef" as const } : null;
  }

  async findElement(selector: string): Promise<ElementRef | null> {
    const el = this.$(selector).first();
    return el.length ? { _kind: "ElementRef" as const } : null;
  }

  async hrefOf(_el: ElementRef): Promise<string | null> {
    return null;
  }

  async clickAndWaitNav(_el: ElementRef, _timeout: number): Promise<string> {
    return "";
  }

  async waitForSelector(_sel: string, _timeout: number) {}

  async bodyInnerText() {
    return this.$("body").text();
  }

  // ── Phase 4 site-adapter hooks (ADR-P4-A) - cheerio-backed test double ────
  //
  // `evaluateScript` doesn't run a JS engine on the fake; the parity tests
  // pass `page.setContent(html)` then call `anchorHrefs` / `getAttribute` /
  // `innerText` directly, NOT the script-based path - so `evaluateScript`
  // throws "not implemented". Real-binary paths run the actual string script
  // against a real page; fake is for the pure-DOM-shape tests.

  async getAttribute(selector: string, attr: string, fallbackAttr?: string): Promise<string | null> {
    const el = this.$(selector).first();
    if (!el.length) return null;
    const primary = el.attr(attr);
    if (primary) return primary;
    return fallbackAttr ? (el.attr(fallbackAttr) ?? null) : null;
  }

  async innerText(selector: string, _timeout: number, excludeSelectors: string[] = []): Promise<string | null> {
    const el = this.$(selector).first();
    if (!el.length) return null;
    if (excludeSelectors.length > 0) {
      // Strip noise descendants before reading text - mirrors Playwright impl.
      const clone = this.$.load(this.$.html(el) ?? "");
      for (const sel of excludeSelectors) {
        clone(sel).remove();
      }
      const raw = clone("body").text() ?? "";
      return raw.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    const raw = el.text() ?? "";
    return raw.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async anchorHrefs(selector: string): Promise<string[]> {
    const out: string[] = [];
    this.$(selector).each((_i, el) => {
      const href = this.$(el).attr("href");
      if (href) out.push(href);
    });
    return out;
  }

  async evaluateScript<T>(_script: string): Promise<T> {
    throw new Error("FakePage.evaluateScript is not implemented - pass HTML fixtures and call the named DOM methods directly");
  }

  private extractTitle(): string {
    const m = /<title[^>]*>(.*?)<\/title>/i.exec(this.html);
    return m ? m[1] : "";
  }
}

export class FakeBrowserPort implements BrowserPort {
  private pageContent: string;
  private contextCookiesMap: StoredCookie[] = [];
  private ephemeralLaunches = 0;
  /** Cookies handed to createContext(...) - additive test hook for any future
   *  test that asserts cookies were attached to a context (ADR-P3-FIX-TUI /
   *  fix-issue-tui-url-cleanliness §2.5 - no current test asserts on it). */
  lastContextCookies: import("../../core/domain/Cookie.js").DomainCookie[] = [];
  /** The most recent FakePage is held here so tests can assert on `gotoCalls`
   *  after running a flow that created a context + page (ADR-P3-FIX-TUI).
   *  Reset by `newPage()`. */
  lastPage: FakePage | null = null;

  constructor(html: string = "") {
    this.pageContent = html;
  }

  setContent(html: string) {
    this.pageContent = html;
  }

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }

  async createContext(_browser: BrowserHandle, cookies?: DomainCookie[]): Promise<ContextHandle> {
    if (cookies) this.lastContextCookies = [...cookies];
    return { close: async () => {} };
  }

  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    const page = new FakePage(this.pageContent);
    this.lastPage = page;
    return page;
  }

  async closeAll() {}

  async launchEphemeral(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    this.ephemeralLaunches++;
    return this.launch(_opts);
  }

  /** Phase 3 / ADR-P3-A: in-memory cookie read-back for capture tests. */
  async contextCookies(_ctx: ContextHandle): Promise<StoredCookie[]> {
    return [...this.contextCookiesMap];
  }

  /** Test-double hook: seed the cookies a future `contextCookies()` call will return. */
  setContextCookies(next: StoredCookie[]): void {
    this.contextCookiesMap = [...next];
  }

  /** Number of headed ephemeral launches observed; useful for capture assertions. */
  ephemeralLaunchCount(): number {
    return this.ephemeralLaunches;
  }
}