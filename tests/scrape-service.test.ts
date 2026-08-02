// ─────────────────────────────────────────────────────────────────────────────
//  T7 (subset) — UIAdapter receives progress events from the ScrapeEvent
//  pipeline using a fake BrowserPort.  Validates event sequence shape only;
//  the offline fixture-site full-pipeline test is a Phase 1 acceptance run.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { ScrapeService } from "../src/core/services/ScrapeService.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import { ArchiverEpubWriter } from "../src/adapters/epub-archiver/ArchiverEpubWriter.js";
import { FakeBrowserPort, FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";

import type { JobConfig } from "../src/core/domain/JobConfig.js";
import type { ScrapeEvent } from "../src/core/services/events.js";
import type { BrowserPort, BrowserHandle, ContextHandle, PageHandle, ElementRef, BrowserLaunchOpts, WaitUntil } from "../src/ports/BrowserPort.js";
import type { DomainCookie } from "../src/core/domain/Cookie.js";

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Recording UI adapter
class RecordingUI {
  events: ScrapeEvent[] = [];
  emit(e: ScrapeEvent) { this.events.push(e); }
  onProgress() {}
}

// Stub BrowserPort returning a fake page that yields chapter content
class StubBrowserPort implements BrowserPort {
  pageHtml: string;
  constructor(html: string) { this.pageHtml = html; }

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }
  async createContext(_browser: BrowserHandle, _cookies?: DomainCookie[]): Promise<ContextHandle> {
    return { close: async () => {} };
  }
  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    return new FakePage(this.pageHtml);
  }
  async closeAll() {}
  async launchEphemeral(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(_opts);
  }
}

// Stub EpubWriter that writes a marker file to a tmp dir
class StubEpubWriter {
  constructor() {}
  async write(_chapters: any[], _meta: any, destDir: string, filename: string) {
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, filename.endsWith(".epub") ? filename : `${filename}.epub`);
    fs.writeFileSync(p, "stub-epub");
    return { path: p };
  }
}

const chapterHtml = (i: number) => `<!DOCTYPE html><html><head><title>Chapter ${i}</title></head>
<body><h1 class="t">Chapter ${i}</h1><div class="c"><p>Content of chapter ${i}. Word word word.</p></div></body></html>`;

describe("ScrapeService + UIAdapter events (T7 subset)", () => {
  let dataDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-svc-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("emits chapter.done, checkpoint.saved, epub.started, epub.done", async () => {
    const ui = new RecordingUI();
    const log = nullLogger();
    const browser = new StubBrowserPort(chapterHtml(1));
    const sessions = new JsonSessionStore(log as any);
    const epub = new StubEpubWriter() as any;

    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub,
      ui,
      log: log as any,
    });

    const outputDir = path.join(dataDir, "out");
    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1", "http://test/c2"],
      contentSelector: ".c",
      separateTitle: true,
      titleSelector: ".t",
      excludeSelectors: [],
      metadata: { title: "N", author: "A", language: "en", coverSource: "none" },
      outputDir,
      outputFilename: "n",
      concurrency: 1,
      delayMin: 0,
      delayMax: 0,
      headless: true,
      output: { epub: true },
    };

    // Inject a session so checkpoints fire
    const session = {
      id: "evt-test",
      status: "in-progress" as const,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
      errors: [],
    };
    await sessions.save(session);

    const result = await service.run(job, [], { session });

    expect(result.chapters).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    const types = ui.events.map((e) => e.type);
    expect(types).toContain("chapter.done");
    expect(types).toContain("checkpoint.saved");
    expect(types).toContain("epub.started");
    expect(types).toContain("epub.done");

    // Final checkpoint and bookend events
    const checkpointEvents = ui.events.filter((e) => e.type === "checkpoint.saved");
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
    const lastCp = checkpointEvents[checkpointEvents.length - 1] as any;
    expect(lastCp.done).toBe(2);

    // EPUB file was actually created via the stub
    expect(fs.existsSync(path.join(outputDir, "n.epub"))).toBe(true);

    // Session file deleted after EPUB success (parity rule)
    const loaded = await sessions.load("evt-test");
    expect(loaded).toBeNull();
  });
});