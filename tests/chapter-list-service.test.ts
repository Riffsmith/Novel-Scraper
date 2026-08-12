// ─────────────────────────────────────────────────────────────────────────────
//  ChapterListService - challenge wait-out + stuck propagation tests.
//
//  These are the first tests for ChapterListService (fix-issue-tui-url-cleanliness
//  §3.5.1). They lock the §3 fix:
//    1. A stuck challenge during `collectSequential` propagates
//       SecurityChallengeError (instead of silently breaking the walk on the
//       first iteration and returning a one-URL list).
//    2. A challenge that clears within the 30 s wait-out window lets the walk
//       proceed and the test fixture's chapter chain is collected.
//
//  The stuck case reuses `tests/fixtures/chapter-challenge.html` (the same
//  fixture `chapter-extractor.test.ts:175-186` uses). The cleared case uses a
//  test-scoped `MutableFakePage` that flips its underlying cheerio API after a
//  configurable number of `locatorCount` calls - `waitOutChallenge` polls every
//  2 s for up to 30 s, so after the configured poll count the page reports the
//  real chapter DOM and the wait-out returns "cleared". Fake timers advance the
//  poll cadence synchronously (no real wall-clock waiting).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

import { ChapterListService } from "../src/core/services/ChapterListService.js";
import { ChapterExtractor } from "../src/core/services/ChapterExtractor.js";
import { SecurityChallengeError } from "../src/core/errors.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const challengeHtml = fs.readFileSync(
  path.join(__dirname, "fixtures", "chapter-challenge.html"),
  "utf8",
);

// Three sequential chapter pages with a `.next-btn` anchor pointing to the
// next chapter - matches the locators passed to `collectSequential` below.
const ch1Html = `
  <html><head><title>Chapter 1</title></head>
  <body>
    <div class="chapter-body"><p>ch1</p></div>
    <a class="next-btn" href="http://test/ch2">Next</a>
  </body></html>`;
const ch2Html = `
  <html><head><title>Chapter 2</title></head>
  <body>
    <div class="chapter-body"><p>ch2</p></div>
    <a class="next-btn" href="http://test/ch3">Next</a>
  </body></html>`;
const ch3Html = `
  <html><head><title>Chapter 3</title></head>
  <body>
    <div class="chapter-body"><p>ch3</p></div>
  </body></html>`;

function makeLogger() {
  const messages: string[] = [];
  const log = {
    debug: (msg: string) => messages.push(`[debug] ${msg}`),
    info: (msg: string) => messages.push(`[info] ${msg}`),
    warn: (msg: string) => messages.push(`[warn] ${msg}`),
    error: (msg: string) => messages.push(`[error] ${msg}`),
  };
  return { messages, log };
}

// Test-scoped FakePage variant whose underlying cheerio API flips from
// challenge HTML to clean HTML after `challengeCalls` locatorCount/title/
// bodyInnerText calls have been made. This lets `waitOutChallenge` observe the
// challenge on its first poll, then observe the clean page on a later poll,
// without waiting real seconds.
//
// The walk itself (collectSequential) uses `findElement` to locate the
// `.next-btn` anchor - after the wait-out flips the DOM, the locator sees the
// clean fixture and the walk proceeds. `hrefOf` then returns the next URL.
class MutableFakePage {
  private $challenge: cheerio.CheerioAPI;
  private $clean: cheerio.CheerioAPI;
  private $: cheerio.CheerioAPI;
  private locatorCalls = 0;
  public gotoCalls: string[] = [];

  constructor(
    private challengeHtmlStr: string,
    private cleanHtmlStr: string,
    private challengeCalls: number,
  ) {
    this.$challenge = cheerio.load(challengeHtmlStr);
    this.$clean = cheerio.load(cleanHtmlStr);
    this.$ = this.$challenge;
  }

  private maybeFlip(): void {
    this.locatorCalls++;
    if (this.locatorCalls > this.challengeCalls) {
      this.$ = this.$clean;
    }
  }

  goto = async (url: string, _opts: { waitUntil: string; timeoutMs: number }) => {
    this.gotoCalls.push(url);
  };
  title = async () => {
    this.maybeFlip();
    const m = /<title[^>]*>(.*?)<\/title>/i.exec(this.$.html() ?? "");
    return m ? m[1] : "";
  };
  content = async () => this.$.html() ?? "";
  urlRef = "";
  url = () => this.urlRef;
  close = async () => {};

  /** Test hook: repoint the "clean" cheerio API at fresh HTML when the walk
   *  advances to a new chapter URL. Mirrors how a real browser's page content
   *  changes on goto() for a different URL. */
  setCleanHtml(html: string): void {
    this.$clean = cheerio.load(html);
    // If we've already flipped, also point `$` at the new clean fixture so
    // subsequent findElement/hrefOf calls see the new chapter's anchors.
    if (this.locatorCalls > this.challengeCalls) {
      this.$ = this.$clean;
    }
  }

  async locatorCount(selector: string): Promise<number> {
    this.maybeFlip();
    return this.$(selector).length;
  }
  async innerHTML(selector: string, _t: number): Promise<string | null> {
    return this.$(selector).first().html() ?? null;
  }
  async textContent(selector: string, _t: number): Promise<string | null> {
    return this.$(selector).first().text() ?? null;
  }
  async removeFromDom(_s: string[]) {}
  async findAnchorByRegex(_p: string, _f: string): Promise<null> {
    return null;
  }
  async findElement(selector: string): Promise<{ _kind: "ElementRef" } | null> {
    const el = this.$(selector).first();
    return el.length ? { _kind: "ElementRef" } : null;
  }
  async hrefOf(_el: { _kind: "ElementRef" }): Promise<string | null> {
    // Match the .next-btn href at the current flip state. The walk calls
    // hrefOf AFTER the wait-out has flipped the DOM, so the next chapter URL
    // is present in the clean cheerio API.
    const el2 = this.$(".next-btn").first();
    if (!el2.length) return null;
    return el2.attr("href") ?? null;
  }
  async clickAndWaitNav(_el: { _kind: "ElementRef" }, _t: number): Promise<string> {
    return "";
  }
  async waitForSelector(_s: string, _t: number) {}
  async bodyInnerText(): Promise<string> {
    this.maybeFlip();
    return this.$("body").text() ?? "";
  }
  async getAttribute(_s: string, _a: string, _fa?: string): Promise<string | null> {
    return null;
  }
  async innerText(_s: string, _t: number, _ex?: string[]): Promise<string | null> {
    return null;
  }
  async anchorHrefs(_s: string): Promise<string[]> {
    return [];
  }
  async evaluateScript<T>(_s: string): Promise<T> {
    throw new Error("not implemented in test double");
  }
}

describe("ChapterListService.collectSequential - challenge handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws SecurityChallengeError when the first page is a stuck challenge", async () => {
    const { log } = makeLogger();
    const extractor = new ChapterExtractor(log);
    const page = new MutableFakePage(challengeHtml, ch1Html, Number.MAX_SAFE_INTEGER);
    const svc = new ChapterListService(log, new NoopUIAdapter(), extractor);

    const promise = svc.collectSequential(
      page,
      "http://test/ch1",
      "http://test/ch3",
      [{ kind: "css", value: ".next-btn" }],
      10,
      20,
      "domcontentloaded",
      5_000,
    );
    // Attach a no-op catch immediately so the rejection isn't flagged as
    // unhandled between the timer advance and the rejects.toThrow assertion.
    promise.catch(() => {});

    // waitOutChallenge polls every 2 s for 30 s = 15 polls max. Advance the
    // clock far enough that all 15 polls fire and the wait-out returns "stuck".
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(promise).rejects.toThrow(SecurityChallengeError);
  });

  it("proceeds with the walk when the challenge clears within the wait-out window", async () => {
    const { log } = makeLogger();
    const extractor = new ChapterExtractor(log);
    // Flip to clean HTML after 3 challenge-detection calls - the very first
    // poll of waitOutChallenge sees the challenge, the second poll (2 s later)
    // sees the clean fixture and the wait-out returns "cleared". Subsequent
    // pages (ch2, ch3) have no challenge markers so waitOutChallenge returns
    // "none" immediately.
    const page = new MutableFakePage(challengeHtml, ch1Html, 3);
    const svc = new ChapterListService(log, new NoopUIAdapter(), extractor);

    // The MutableFakePage starts at challenge HTML; `goto` for ch1 returns
    // immediately (FakePage.goto is a no-op recording URLs). The first
    // page.goto inside collectSequential is for "http://test/ch1".
    //
    // The fixture HTML returned by content()/findElement before the flip
    // is the challenge HTML; after the flip it is ch1Html (which has a
    // .next-btn link to ch2). The walk needs ch2/ch3 fixtures as well - we
    // swap them in via the gotoCalls-side mapping below.
    //
    // Simpler: extend the test page so the "clean" cheerio instance can be
    // re-pointed at ch2/ch3 when the walk advances. We'll intercept goto()
    // to swap the clean cheerio state to the URL the walk navigated to.
    const pages: Record<string, string> = {
      "http://test/ch1": ch1Html,
      "http://test/ch2": ch2Html,
      "http://test/ch3": ch3Html,
    };
    page.goto = async (url: string, _opts: { waitUntil: string; timeoutMs: number }) => {
      page.gotoCalls.push(url);
      // Repoint the clean fixture to the URL the walk navigated to.
      // The test double exposes this via the setter used below.
      page.setCleanHtml(pages[url] ?? ch1Html);
    };

    const promise = svc.collectSequential(
      page,
      "http://test/ch1",
      "http://test/ch3",
      [{ kind: "css", value: ".next-btn" }],
      10,
      20,
      "domcontentloaded",
      5_000,
    );

    // First wait-out: challenge clears after one poll (2 s). The walk then
    // pushes ch1 + navigates to ch2 (another 2 s wait happens inside
    // delay(Math.floor(delayMin * 0.4)) and delay(Math.floor(delayMin * 0.3))
    // but those are real-interval delays unaffected by challenge wait-out).
    // Drive enough timers for the whole walk to finish. delayMin=10, so
    // each delay is ~4ms / ~3ms - tiny. Just advance generously.
    await vi.advanceTimersByTimeAsync(60_000);
    const urls = await promise;

    expect(urls.length).toBe(3);
    expect(urls).toEqual(["http://test/ch1", "http://test/ch2", "http://test/ch3"]);
  });

  it("has no challenge handling when no extractor is injected (pre-fix behavior)", async () => {
    const { log } = makeLogger();
    const page = new MutableFakePage(challengeHtml, ch1Html, Number.MAX_SAFE_INTEGER);
    const svc = new ChapterListService(log, new NoopUIAdapter());

    const promise = svc.collectSequential(
      page,
      "http://test/ch1",
      "http://test/ch3",
      [{ kind: "css", value: ".next-btn" }],
      10,
      20,
      "domcontentloaded",
      5_000,
    );

    // No challenge wait-out injected; the challenge DOM has no .next-btn, so
    // resolveNext returns null and the walk breaks after the first iteration.
    // The returned list is the first URL only (the pre-fix bug behaviour).
    await vi.advanceTimersByTimeAsync(5_000);
    const urls = await promise;
    expect(urls).toEqual(["http://test/ch1"]);
  });
});
