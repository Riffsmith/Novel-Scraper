// ─────────────────────────────────────────────────────────────────────────────
//  T5 (subset) — Resume: completed chapters are not re-scraped.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { ScrapeService } from "../src/core/services/ScrapeService.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import { FakeBrowserPort, FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";

import type { JobConfig } from "../src/core/domain/JobConfig.js";
import type { ScrapeSession } from "../src/core/domain/Session.js";
import type { Chapter } from "../src/core/domain/Chapter.js";
import type { BrowserPort, BrowserHandle, ContextHandle, PageHandle, BrowserLaunchOpts, WaitUntil } from "../src/ports/BrowserPort.js";
import type { DomainCookie } from "../src/core/domain/Cookie.js";

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Tracking fake that records each goto URL
class TrackingBrowserPort implements BrowserPort {
  visitedUrls: string[] = [];
  pageHtml: string;
  constructor(html: string) { this.pageHtml = html; }

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }
  async createContext(_browser: BrowserHandle, _cookies?: DomainCookie[]): Promise<ContextHandle> {
    return { close: async () => {} };
  }
  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- arrow mutates outer pageHtml on each goto
    const outer = this;
    const fake = new FakePage(this.pageHtml);
    const orig = fake.goto;
    fake.goto = async (url: string, _opts: { waitUntil: WaitUntil; timeoutMs: number }) => {
      outer.visitedUrls.push(url);
      await orig(url, _opts);
    };
    return fake;
  }
  async closeAll() {}
  async launchEphemeral(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(_opts);
  }
}

class StubEpubWriter {
  async write(_chapters: any[], _meta: any, destDir: string, filename: string) {
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, filename.endsWith(".epub") ? filename : `${filename}.epub`);
    fs.writeFileSync(p, "stub");
    return { path: p };
  }
}

const chHtml = (i: number) => `<!DOCTYPE html><html><head><title>Chapter ${i}</title></head>
<body><h1 class="t">Chapter ${i}</h1><div class="c"><p>Content ${i}.</p></div></body></html>`;

describe("ScrapeService — resume (T5 subset)", () => {
  let dataDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-resume-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips already-completed chapters on resume", async () => {
    const log = nullLogger();
    const browser = new TrackingBrowserPort(chHtml(99));
    const sessions = new JsonSessionStore(log as any);
    const epub = new StubEpubWriter() as any;
    const ui = new NoopUIAdapter();

    const allUrls = ["http://test/c1", "http://test/c2", "http://test/c3", "http://test/c4"];
    const completed: Chapter[] = [
      { index: 1, title: "Chapter 1", url: allUrls[0], htmlContent: "<p>x</p>", wordCount: 1 },
      { index: 2, title: "Chapter 2", url: allUrls[1], htmlContent: "<p>y</p>", wordCount: 1 },
    ];

    const job: JobConfig = {
      method: "toc",
      chapterLinks: allUrls,
      contentSelector: ".c",
      separateTitle: true,
      titleSelector: ".t",
      excludeSelectors: [],
      metadata: { title: "N", author: "A", language: "en", coverSource: "none" },
      outputDir: path.join(dataDir, "out"),
      outputFilename: "n",
      concurrency: 1,
      delayMin: 0,
      delayMax: 0,
      headless: true,
      output: { epub: true },
    };

    const session: ScrapeSession = {
      id: "resume-test",
      status: "in-progress",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: allUrls,
      completedChapters: completed,
      errors: [],
    };

    await sessions.save(session);
    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub,
      ui,
      log: log as any,
    });

    const result = await service.run(job, [], { session });

    // Only chapters 3 and 4 should have been visited
    expect(result.chapters).toHaveLength(4);
    expect(browser.visitedUrls).toEqual(["http://test/c3", "http://test/c4"]);
  });
});