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
import type { DomainCookie } from "../../core/domain/Cookie.js";


export class FakePage implements PageHandle {
  private $: cheerio.CheerioAPI;

  constructor(private html: string) {
    this.$ = cheerio.load(html);
  }

  goto = async (_url: string, _opts: { waitUntil: WaitUntil; timeoutMs: number }) => {};
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
    let found: any = null;
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



  private extractTitle(): string {
    const m = /<title[^>]*>(.*?)<\/title>/i.exec(this.html);
    return m ? m[1] : "";
  }
}

export class FakeBrowserPort implements BrowserPort {
  private pageContent: string;

  constructor(html: string = "") {
    this.pageContent = html;
  }

  setContent(html: string) {
    this.pageContent = html;
    }

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }

  async createContext(_browser: BrowserHandle, _cookies?: DomainCookie[]): Promise<ContextHandle> {
    return { close: async () => {} };
  }

  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    return new FakePage(this.pageContent);
  }

  async closeAll() {}

  async launchEphemeral(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(_opts);
  }
}