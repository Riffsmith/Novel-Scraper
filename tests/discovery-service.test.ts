// ─────────────────────────────────────────────────────────────────────────────
//  DiscoveryService.discoverJobChapters - challenge retry behaviour tests.
//
//  These are the first tests for discoverJobChapters (fix-issue-tui-url-cleanliness
//  §3.5.2). They lock the §3 fix: a stuck security challenge no longer closes
//  the discovery browser immediately and returns a one-URL list. Instead the
//  discovery launches a fresh browser per attempt and backs off with
//  attempt * 45 s inter-attempt delays, mirroring ScrapeService.ts:233-275,
//  up to DISCOVERY_MAX_RETRIES (3) + the original attempt = 4 launches max.
//
//  Fake timers drive the in-page wait-out (2 s poll over 30 s) and the
//  inter-attempt backoff (`attempt * 45_000ms`) without wall-clock waits.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { discoverJobChapters } from "../src/core/services/DiscoveryService.js";
import { SecurityChallengeError } from "../src/core/errors.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";
import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
  PageHandle,
  BrowserLaunchOpts,
} from "../src/ports/BrowserPort.js";
import type { JobConfig } from "../src/core/domain/JobConfig.js";
import type { DomainCookie, StoredCookie } from "../src/core/domain/Cookie.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const challengeHtml = fs.readFileSync(
  path.join(__dirname, "fixtures", "chapter-challenge.html"),
  "utf8",
);

// A real sequential chapter fixture used by the clears-on-retry test.
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

// Minimal PageHandle that serves one cheerio-parsed HTML snapshot and reports
// the right title/locatorCount/bodyInnerText for the challenge detector. It
// does not implement the walk-side anchor methods (hrefOf etc.) because the
// stuck case never advances the walk and the clears-on-retry case uses a
// full-fixture sequence via `FakePage` (imported below).
class StaticPage implements PageHandle {
  private titleStr: string;
  private bodyText: string;
  private markerCount: number;
  public gotoCalls: string[] = [];

  constructor(html: string) {
    this.titleStr = /<title[^>]*>(.*?)<\/title>/i.exec(html)?.[1] ?? "";
    this.bodyText = cheerioLoadText(html);
    this.markerCount = Number(/#challenge-form|#cf-wrapper|#challenge-running/i.test(html));
  }

  goto = async (url: string) => {
    this.gotoCalls.push(url);
  };
  title = async () => this.titleStr;
  content = async () => "";
  urlRef = "";
  url = () => this.urlRef;
  close = async () => {};
  async locatorCount(selector: string): Promise<number> {
    // Return 1 only for the DOM markers the challenge fixture carries; 0 for
    // the next-button locator used by the walk (forcing resolveNext to bail).
    if (selector === "#cf-wrapper" || selector === "#challenge-form") return 1;
    return 0;
  }
  async innerHTML(): Promise<string | null> {
    return null;
  }
  async textContent(): Promise<string | null> {
    return null;
  }
  async removeFromDom() {}
  async findAnchorByRegex(): Promise<null> {
    return null;
  }
  async findElement(selector: string): Promise<{ _kind: "ElementRef" } | null> {
    // The walk only reaches here on the cleared page; for the stuck page it
    // is never called (waitOutChallenge throws first). Return null for unknown
    // selectors, but allow `.next-btn` for the cleared-page fixture.
    if (selector === ".next-btn") return { _kind: "ElementRef" };
    return null;
  }
  async hrefOf(): Promise<string | null> {
    return null;
  }
  async clickAndWaitNav(): Promise<string> {
    return "";
  }
  async waitForSelector() {}
  async bodyInnerText(): Promise<string> {
    return this.bodyText;
  }
  async getAttribute(): Promise<string | null> {
    return null;
  }
  async innerText(): Promise<string | null> {
    return null;
  }
  async anchorHrefs(): Promise<string[]> {
    return [];
  }
  async evaluateScript<T>(): Promise<T> {
    throw new Error("not implemented");
  }
}

function cheerioLoadText(html: string): string {
  // avoid importing cheerio at the top so this file stays dependency-light;
  // we only need a strip of the body text for the challenge body-text check.
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch ? bodyMatch[1] : html;
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// A FakeBrowserPort whose `newPage` returns pages from a per-attempt queue:
// the test populates `pagesByAttempt` before each launch to control whether
// the Nth discovery attempt serves a challenge page or a clean chapter page.
// `launches` is incremented on every `launch()` for the test's count assertion.
class FakeBrowser implements BrowserPort {
  launches = 0;
  /** Pages handed out by newPage(), one per attempt. Each entry is a fresh
   *  PageHandle instance (re-checked out on every newPage call). */
  pageQueue: PageHandle[] = [];
  lastContextCookies: DomainCookie[] = [];

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    this.launches++;
    return { close: async () => {} };
  }
  async createContext(_b: BrowserHandle, cookies?: DomainCookie[]): Promise<ContextHandle> {
    if (cookies) this.lastContextCookies = [...cookies];
    return { close: async () => {} };
  }
  async newPage(_c: ContextHandle): Promise<PageHandle> {
    const p = this.pageQueue.shift();
    if (!p) throw new Error("FakeBrowser.pageQueue exhausted");
    return p;
  }
  async closeAll() {}
  async contextCookies(): Promise<StoredCookie[]> {
    return [];
  }
}

function makeSequentialJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    method: "sequential",
    firstChapterUrl: "http://test/ch1",
    lastChapterUrl: "http://test/ch2",
    nextButtonLocators: [{ kind: "css", value: ".next-btn" }],
    contentSelector: ".chapter-body",
    separateTitle: false,
    excludeSelectors: [],
    metadata: { title: "Test Novel", author: "Test" } as JobConfig["metadata"],
    outputDir: "/tmp/out",
    outputFilename: "test",
    concurrency: 1,
    delayMin: 10,
    delayMax: 20,
    headless: true,
    output: { epub: false },
    ...overrides,
  } as JobConfig;
}

// DISCOVERY_MAX_RETRIES + the initial attempt = 4 total launches on a stuck
// challenge (per the §3.5.2 implementation: `attempt <= DISCOVERY_MAX_RETRIES`
// triggers a retry, so attempt 4 bubbles out).
const EXPECTED_MAX_LAUNCHES_STUCK = 4;

describe("discoverJobChapters - challenge retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries discovery up to DISCOVERY_MAX_RETRIES on a stuck challenge, then bubbles SecurityChallengeError", async () => {
    const { log } = makeLogger();
    const browser = new FakeBrowser();
    // Every attempt serves a challenge page that never clears.
    for (let i = 0; i < EXPECTED_MAX_LAUNCHES_STUCK; i++) {
      browser.pageQueue.push(new StaticPage(challengeHtml));
    }
    const job = makeSequentialJob();

    const promise = discoverJobChapters(job, {
      browser,
      cookies: [],
      ui: new NoopUIAdapter(),
      log: log,
    });
    promise.catch(() => {});

    // Drive every attempt: each is 30 s max in-page poll + attempt*45 s backoff.
    //   attempt 1: 30 s wait-out + 1*45 s backoff = 75 s   (cumul  75s)
    //   attempt 2: 30 s wait-out + 2*45 s backoff = 120 s   (cumul 195s)
    //   attempt 3: 30 s wait-out + 3*45 s backoff = 165 s   (cumul 360s)
    //   attempt 4: 30 s wait-out only (no retry, bubbles)   (cumul 390s)
    // Advance well beyond 390 s so the rejection has fully settled.
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    await expect(promise).rejects.toThrow(SecurityChallengeError);

    // Every served page was a challenge, so every browser launch had a stuck
    // wait-out: we should have used exactly EXPECTED_MAX_LAUNCHES_STUCK pages
    // (one per launch) and stopped.
    expect(browser.launches).toBe(EXPECTED_MAX_LAUNCHES_STUCK);
    expect(browser.pageQueue.length).toBe(0);
  });

  it("returns the URL list on the second attempt if the first hits a stuck challenge that clears on retry", async () => {
    const { log } = makeLogger();
    const browser = new FakeBrowser();
    // Attempt 1: challenge page (stuck). Attempt 2: a real chapter chain that
    // collectSequential will walk (ch1 -> ch2, ch2 has no .next-btn so the walk
    // ends naturally at lastUrl "http://test/ch2").
    browser.pageQueue.push(new StaticPage(challengeHtml));
    browser.pageQueue.push(new StaticPage(ch1Html) as PageHandle);

    const job = makeSequentialJob();
    const promise = discoverJobChapters(job, {
      browser,
      cookies: [],
      ui: new NoopUIAdapter(),
      log: log,
    });
    promise.catch(() => {});

    // Attempt 1: 30 s stuck wait-out + 1*45 s backoff = 75 s before attempt 2
    // starts. Then attempt 2's waitOutChallenge immediately returns "none"
    // (ch1Html has no challenge markers) and the walk runs - it visits ch1,
    // tries .next-btn findElement, but StaticPage.findElement returns a bare
    // ElementRef and hrefOf returns null, so the walk falls back to
    // clickAndWaitNav which returns "" - breaking the walk with ch1 only.
    //
    // For this test to assert the retry SUCCEEDS (returns multiple URLs), we
    // need a page that actually supports the walk. Swap attempt 2's page for a
    // richer double that routes hrefOf to ch2.
    class WalkablePage implements PageHandle {
      public gotoCalls: string[] = [];
      private byUrl: Record<string, string>;
      private current = "http://test/ch1";
      constructor() {
        this.byUrl = {
          "http://test/ch1": ch1Html,
          "http://test/ch2": ch2Html,
        };
      }
      goto = async (url: string) => {
        this.gotoCalls.push(url);
        this.current = url;
      };
      title = async () => /<title[^>]*>(.*?)<\/title>/i.exec(this.byUrl[this.current])?.[1] ?? "";
      content = async () => this.byUrl[this.current] ?? "";
      urlRef = "";
      url = () => this.urlRef;
      close = async () => {};
      async locatorCount(selector: string): Promise<number> {
        // No challenge markers on any chapter page; .next-btn exists on ch1.
        if (selector === "#cf-wrapper" || selector === "#challenge-form") return 0;
        if (selector === ".next-btn") {
          return this.current === "http://test/ch1" ? 1 : 0;
        }
        return 0;
      }
      async innerHTML(): Promise<string | null> {
        return null;
      }
      async textContent(): Promise<string | null> {
        return null;
      }
      async removeFromDom() {}
      async findAnchorByRegex(): Promise<null> {
        return null;
      }
      async findElement(selector: string): Promise<{ _kind: "ElementRef" } | null> {
        if (selector === ".next-btn" && this.current === "http://test/ch1") {
          return { _kind: "ElementRef" };
        }
        return null;
      }
      async hrefOf(): Promise<string | null> {
        return this.current === "http://test/ch1" ? "http://test/ch2" : null;
      }
      async clickAndWaitNav(): Promise<string> {
        return this.current === "http://test/ch1" ? "http://test/ch2" : "";
      }
      async waitForSelector() {}
      async bodyInnerText(): Promise<string> {
        return cheerioLoadText(this.byUrl[this.current] ?? "");
      }
      async getAttribute(): Promise<string | null> {
        return null;
      }
      async innerText(): Promise<string | null> {
        return null;
      }
      async anchorHrefs(): Promise<string[]> {
        return [];
      }
      async evaluateScript<T>(): Promise<T> {
        throw new Error("not implemented");
      }
    }

    // Replace the second queued page with the walkable one.
    browser.pageQueue[1] = new WalkablePage();

    // Drive the clock past attempt 1's stuck wait-out (30 s) + backoff (45 s)
    // so attempt 2's walk runs.
    await vi.advanceTimersByTimeAsync(90_000);
    // After attempt 2's walk finishes (no challenge poll needed - the chapter
    // page has no markers; the wait-out returns "none" immediately), the
    // promise resolves with the walk's collected URLs.
    const urls = await promise;
    expect(urls).toEqual(["http://test/ch1", "http://test/ch2"]);
    expect(browser.launches).toBe(2);
  });

  it("returns job.chapterLinks as-is when already pre-resolved (no browser launched)", async () => {
    const { log } = makeLogger();
    const browser = new FakeBrowser();
    const job = makeSequentialJob({ chapterLinks: ["http://test/pre-resolved"] });

    const urls = await discoverJobChapters(job, {
      browser,
      cookies: [],
      ui: new NoopUIAdapter(),
      log: log,
    });

    expect(urls).toEqual(["http://test/pre-resolved"]);
    expect(browser.launches).toBe(0);
  });
});
