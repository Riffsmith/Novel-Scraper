// ─────────────────────────────────────────────────────────────────────────────
//  Phase 7 / Evidence Phase 2 - Pipeline parity tests.
//
//  Covers the Pipeline-named-phase wiring:
//    P1 - ChapterExtractor invokes adapter.processChapterContent after the
//         generic extraction AND calls adapter.collectFootnotes first (D5
//         deviation). The hook's htmlContent BYPASSES sanitize-html
//         (ADR-P7-D).
//    P2 - ScrapeService.run accepts a trailing-optional `volumes?` and
//         forwards to EpubWriter.write. On resume, session.volumes (when
//         set) overrides the caller arg (resume checkpoint is the source
//         of truth).
//    P3 - runJob forwards job.volumes to ScrapeService.run (covered via
//         the ScrapeService.run arg assertion - runJob.ts forwards
//         `job.volumes` directly, which IS what ScrapeService reads).
//
//  The live-binary scrapeChapterLinks / scrapeVolumes / collectFootnotes
//  paths (string scripts shipped via PageHandle.evaluateScript) are gated
//  on `CLOAKBROWSER_BINARY_AVAILABLE=1` in tests/acceptance.test.ts -
//  FakeBrowserPort's evaluateScript intentionally throws
//  (src/adapters/store-memory/FakeBrowserPort.ts:125-127). These tests
//  drive the hook contract through the in-process adapter strip path
//  (no string scripts) - so the FakeBrowserPort is sufficient.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { ChapterExtractor } from "../src/core/services/ChapterExtractor.js";
import { ScrapeService } from "../src/core/services/ScrapeService.js";
import { FakeBrowserPort, FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";
import { makeWebnovelAdapter } from "../src/adapters/site-webnovel/WebnovelAdapter.js";

import type { JobConfig } from "../src/core/domain/JobConfig.js";
import type { Volume } from "../src/core/domain/Volume.js";
import type { ScrapeSession } from "../src/core/domain/Session.js";
import type { Chapter } from "../src/core/domain/Chapter.js";
import type {
  BrowserPort,
  BrowserHandle,
  BrowserLaunchOpts,
  ContextHandle,
  PageHandle,
} from "../src/ports/BrowserPort.js";
import type { DomainCookie } from "../src/core/domain/Cookie.js";
import type { SiteAdapter } from "../src/core/domain/SiteAdapter.js";
import type { Footnote } from "../src/core/domain/Footnote.js";
import type { ScrapeEvent } from "../src/core/services/events.js";

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Chapter fixture the extractor will pull via .cha-words (the webnovel
// default content selector). The body carries the marker substring the
// adapter's processChapterContent wraps in .chapter-page-title h2 / .decorative-line
// div - so the post-hook's signature is easy to detect in the result.
const chapterHtml = `<!DOCTYPE html>
<html><head><title>My Chapter</title></head>
<body>
  <h1 class="chapter-title">My Chapter</h1>
  <div class="cha-words">
    <p>Body line one.</p>
    <p class="para-comment">Ad noise that the adapter strips.</p>
    <p>Body line two with <i>italic</i>.</p>
  </div>
</body></html>`;

// A PageHandle that records evaluateScript calls so the test can assert
// the FOOTNOTE_COLLECT_SCRIPT browser-side path was invoked. evaluateScript
// returns the programmed stub, so collectFootnotes gets a real array.
class RecordingPage extends FakePage {
  evaluateScriptCalls: string[] = [];
  stubFootnotes: Footnote[] | null = null;
  constructor(html: string) {
    super(html);
  }
  override async evaluateScript<T>(script: string): Promise<T> {
    this.evaluateScriptCalls.push(script);
    if (this.stubFootnotes !== null && /anno\[data-annotation-id\]/.test(script)) {
      return this.stubFootnotes as unknown as T;
    }
    throw new Error("RecordingPage.evaluateScript: no stub for this script");
  }
}

// BrowserPort returning a RecordingPage so each new page records its
// evaluateScript invocations (for the collectFootnotes call assertion).
class RecordingBrowserPort implements BrowserPort {
  page: RecordingPage;
  constructor(html: string) {
    this.page = new RecordingPage(html);
  }
  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }
  async createContext(_b: BrowserHandle, _c?: DomainCookie[]): Promise<ContextHandle> {
    return { close: async () => {} };
  }
  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    return this.page;
  }
  async closeAll() {}
  async launchEphemeral(opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(opts);
  }
}

// Stub EpubWriter that records its invocations so the volume-forwarding
// assertion has a single seam.
class RecordingEpubWriter {
  calls: Array<{ chapters: Chapter[]; volumes: Volume[] | undefined }> = [];
  constructor() {}
  async write(
    chapters: Chapter[],
    _meta: any,
    destDir: string,
    filename: string,
    volumes?: Volume[],
  ): Promise<{ path: string }> {
    this.calls.push({ chapters: [...chapters], volumes });
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, `${filename}.epub`);
    fs.writeFileSync(p, "stub-epub");
    return { path: p };
  }
}

class RecordingUI {
  events: ScrapeEvent[] = [];
  emit(e: ScrapeEvent) { this.events.push(e); }
  onProgress() {}
}

// ── Pipeline Phase 1: ChapterExtractor adapter hook ────────────────────────

describe("Pipeline Phase 1 - ChapterExtractor invokes adapter hooks", () => {
  it("runs adapter.processChapterContent after generic extraction and the hook output bypasses sanitize-html", async () => {
    const adapter = makeWebnovelAdapter(nullLogger() as any) as Pick<
      SiteAdapter,
      "processChapterContent" | "collectFootnotes"
    >;

    const extractor = new ChapterExtractor(nullLogger() as any, adapter);
    const page = new FakePage(chapterHtml);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: "div.cha-words",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).not.toBeNull();
    // The adapter wraps the body in this h2 / decorative-line block - so
    // the post-hook ran. That proves processChapterContent was invoked.
    expect(chapter!.htmlContent).toContain('<h2 class="chapter-page-title">My Chapter</h2>');
    expect(chapter!.htmlContent).toContain('<div class="decorative-line">');
    // Blacklisted tag `i` is stripped by the adapter (NOT by sanitize-html,
    // which allows `i`). If sanitize-html had run on the post-hook output,
    // `<i>italic</i>` would have survived, which it does not.
    expect(chapter!.htmlContent).not.toContain("<i>italic</i>");
    // Blacklisted class `.para-comment` is stripped by the adapter too.
    expect(chapter!.htmlContent).not.toContain("para-comment");
    // Title still on the Chapter domain shape (unchanged per ADR-P7-D).
    expect(chapter!.title).toBe("My Chapter");
  });

  it("does not invoke collectFootnotes when adapter leaves it unset (flat-catalog adapter path)", async () => {
    // WTR-Lab has neither processChapterContent nor collectFootnotes. The
    // extractor must fall through to its sanitize-html path byte-identical
    // to today (regression-guarded by tests/chapter-extractor.test.ts).
    const adapter: Pick<SiteAdapter, "processChapterContent" | "collectFootnotes"> =
      {} as Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">;
    const extractor = new ChapterExtractor(nullLogger() as any, adapter);
    const page = new FakePage(chapterHtml);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: "div.cha-words",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).not.toBeNull();
    // sanitize-html allows `i`, so the italic token survives (no adapter
    // post-hook ran). This is the no-adapter regression baseline.
    expect(chapter!.htmlContent).toContain("<i>italic</i>");
    // sanitize-html did NOT see .para-comment as a class to strip; the
    // text content survives in the sanitized html.
    expect(chapter!.htmlContent).toContain("Ad noise that the adapter strips.");
  });

  it("invokes collectFootnotes before processChapterContent when adapter provides both (D5 deviation)", async () => {
    const adapter = makeWebnovelAdapter(nullLogger() as any) as Pick<
      SiteAdapter,
      "processChapterContent" | "collectFootnotes"
    >;

    const extractor = new ChapterExtractor(nullLogger() as any, adapter);
    const recordingPage = new RecordingPage(chapterHtml);
    // Stub the FOOTNOTE_COLLECT_SCRIPT browser-side return - one footnote.
    recordingPage.stubFootnotes = [
      { ref: "abc", title: "Footnote Title", content: "Footnote body." },
    ];

    const chapter = await extractor.extract(recordingPage, "http://test/ch1", 1, {
      contentSelector: "div.cha-words",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).not.toBeNull();
    // evaluateScript was called exactly once - for the FOOTNOTE_COLLECT_SCRIPT
    // (the webnovel adapter has no other evaluateScript surface in the
    // extract() path; AUTHOR_SCRIPT only runs in scrapeMetadata).
    expect(recordingPage.evaluateScriptCalls.length).toBe(1);
    expect(recordingPage.evaluateScriptCalls[0]).toContain("anno[data-annotation-id]");
    // The footnote section was emitted into htmlContent, proving the
    // collected footnotes flowed from collectFootnotes -> processChapterContent
    // -> htmlContent (the hook's footnotes input arg).
    expect(chapter!.htmlContent).toContain("footnotes-section");
    expect(chapter!.htmlContent).toContain("Footnote Title");
    expect(chapter!.htmlContent).toContain("Footnote body.");
  });

  it("proceeds without footnotes when collectFootnotes returns empty (fail-soft)", async () => {
    const adapter = makeWebnovelAdapter(nullLogger() as any) as Pick<
      SiteAdapter,
      "processChapterContent" | "collectFootnotes"
    >;

    // RecordingPage with no footnote stub -> adapter's collectFootnotes
    // catches the evaluateScript throw and returns undefined (D5 deviation:
    // fail-soft is owned by the adapter's collectFootnotes, which swallows
    // the browser-side throw; ChapterExtractor then calls processChapterContent
    // with footnotes ?? undefined).
    const recordingPage = new RecordingPage(chapterHtml);
    recordingPage.stubFootnotes = null;
    const warnCalls: string[] = [];
    const log = {
      debug() {},
      info() {},
      warn: (msg: string) => warnCalls.push(msg),
      error() {},
    };
    const extractor = new ChapterExtractor(log as any, adapter);

    const chapter = await extractor.extract(recordingPage, "http://test/ch1", 1, {
      contentSelector: "div.cha-words",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).not.toBeNull();
    // No footnotes section emitted because collectFootnotes returned
    // undefined (fail-soft inside the adapter).
    expect(chapter!.htmlContent).not.toContain("footnotes-section");
    // Body still wrapped via the post-hook - chapter body extracted fine.
    expect(chapter!.htmlContent).toContain('<h2 class="chapter-page-title">My Chapter</h2>');
  });
});

// ── Pipeline Phase 2 + 3: ScrapeService.run threads volumes through ────────

describe("Pipeline Phase 2 + 3 - ScrapeService.run threads volumes to EpubWriter", () => {
  let dataDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-pipeline-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("forwards the trailing-optional volumes arg to EpubWriter.write", async () => {
    const log = nullLogger();
    const browser = new FakeBrowserPort(chapterHtml);
    const sessions = new JsonSessionStore(log as any);
    const recordingEpub = new RecordingEpubWriter();
    const ui = new class extends RecordingUI {}();

    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1", "http://test/c2"],
      contentSelector: ".cha-words",
      separateTitle: true,
      titleSelector: "h1.chapter-title",
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
    // Note: the chapter fixture's content selector is `.cha-words` but
    // chapterHtml variants below need to actually have text matching the
    // title selector; the FakeBrowserPort always returns the same page
    // HTML for every URL, so both chapters will look the same.

    const session: ScrapeSession = {
      id: "vol-test",
      status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
      errors: [],
    };
    await sessions.save(session);

    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub: recordingEpub as any,
      ui,
      log: log as any,
    });

    const volumes: Volume[] = [
      {
        name: "Volume 1",
        chapterUrls: ["http://test/c1", "http://test/c2"],
      },
    ];
    const result = await service.run(job, [], { session }, volumes);

    expect(result.chapters).toHaveLength(2);
    expect(recordingEpub.calls.length).toBe(1);
    expect(recordingEpub.calls[0]!.volumes).toEqual(volumes);
  });

  it("forwards undefined to EpubWriter when no volumes are provided", async () => {
    const log = nullLogger();
    const browser = new FakeBrowserPort(chapterHtml);
    const sessions = new JsonSessionStore(log as any);
    const recordingEpub = new RecordingEpubWriter();
    const ui = new class extends RecordingUI {}();

    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1"],
      contentSelector: ".cha-words",
      separateTitle: true,
      titleSelector: "h1.chapter-title",
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
      id: "no-vol-test",
      status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
      errors: [],
    };
    await sessions.save(session);

    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub: recordingEpub as any,
      ui,
      log: log as any,
    });

    await service.run(job, [], { session });

    expect(recordingEpub.calls.length).toBe(1);
    expect(recordingEpub.calls[0]!.volumes).toBeUndefined();
  });

  it("on resume, session.volumes overrides the caller-supplied volumes arg", async () => {
    const log = nullLogger();
    const browser = new FakeBrowserPort(chapterHtml);
    const sessions = new JsonSessionStore(log as any);
    const recordingEpub = new RecordingEpubWriter();
    const ui = new class extends RecordingUI {}();

    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1"],
      contentSelector: ".cha-words",
      separateTitle: true,
      titleSelector: "h1.chapter-title",
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

    const sessionVolumes: Volume[] = [
      { name: "Persisted Volume", chapterUrls: ["http://test/c1"] },
    ];
    const session: ScrapeSession = {
      id: "resume-vol",
      status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
      errors: [],
      volumes: sessionVolumes,
    };
    await sessions.save(session);

    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub: recordingEpub as any,
      ui,
      log: log as any,
    });

    // Caller passes a DIFFERENT volumes list; resume checkpoint should win.
    const callerVolumes: Volume[] = [
      { name: "Caller Volume - SHOULD LOSE", chapterUrls: ["http://test/c1"] },
    ];
    await service.run(job, [], { session }, callerVolumes);

    expect(recordingEpub.calls.length).toBe(1);
    expect(recordingEpub.calls[0]!.volumes).toEqual(sessionVolumes);
    expect(recordingEpub.calls[0]!.volumes?.[0]?.name).toBe("Persisted Volume");
  });

  it("ScrapeService deps.siteAdapter propagates to ChapterExtractor so the adapter post-hook runs", async () => {
    const log = nullLogger();
    const browser = new RecordingBrowserPort(chapterHtml);
    // Footnote collector stub: an empty stub means evaluateScript returns
    // an empty array - adapter.collectFootnotes returns undefined (no
    // footnotes for this chapter), but the call itself records the script
    // invocation. The post-hook still runs and wraps the body.
    browser.page.stubFootnotes = [];
    const sessions = new JsonSessionStore(log as any);
    const recordingEpub = new RecordingEpubWriter();
    const ui = new class extends RecordingUI {}();
    const adapter = makeWebnovelAdapter(nullLogger() as any) as Pick<
      SiteAdapter,
      "processChapterContent" | "collectFootnotes"
    >;

    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1"],
      contentSelector: ".cha-words",
      separateTitle: true,
      titleSelector: "h1.chapter-title",
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
      id: "adapter-wire",
      status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
      errors: [],
    };
    await sessions.save(session);

    const service = new ScrapeService({
      browser: browser as BrowserPort,
      sessions,
      epub: recordingEpub as any,
      ui,
      log: log as any,
      siteAdapter: adapter,
    });

    const result = await service.run(job, [], { session });

    // Adapter post-hook ran inside the extractor (covers deps.siteAdapter
    // -> ChapterExtractor wiring). The chapter-page-title h2 is the
    // adapter's signature wrapping (NOT sanitize-html, which would not
    // emit it).
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]!.htmlContent).toContain(
      '<h2 class="chapter-page-title">My Chapter</h2>',
    );
    expect(recordingEpub.calls.length).toBe(1);
  });
});

// ── Evidence Phase 3: end-to-end ScrapeService -> ArchiverEpubWriter ────────
//
// Existing `tests/epub-archiver.test.ts` covers the ArchiverEpubWriter.write
// volume-page surface directly (8 tests). This block adds the missing
// end-to-end assertion: a real ArchiverEpubWriter fed via ScrapeService.run
// with volumes produces a valid EPUB archive containing one
// `OEBPS/volumes/volume-N.xhtml` page per volume-with-chapters (Pipeline
// Phase 2 + 3 contract). The EPUB is opened via python3 (the existing
// tests/epub-archiver.test.ts zipListing helper pattern) so the assertion
// doesn't re-import the writer; it inspects the persistent file.
describe("ScrapeService -> ArchiverEpubWriter end-to-end volumes (Pipeline Phase 2 + 3)", () => {
  let dataDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-e2e-vol-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("emits OEBPS/volumes/volume-N.xhtml pages when ScrapeService.run receives volumes", async () => {
    const { execFileSync } = await import("child_process");
    const log = nullLogger();
    const browser = new FakeBrowserPort(chapterHtml);
    const sessions = new JsonSessionStore(log as any);
    const epub = new (await import("../src/adapters/epub-archiver/ArchiverEpubWriter.js"))
      .ArchiverEpubWriter(nullLogger() as any);
    const ui = new NoopUIAdapter();

    const job: JobConfig = {
      method: "toc",
      chapterLinks: ["http://test/c1", "http://test/c2"],
      contentSelector: ".cha-words",
      separateTitle: true,
      titleSelector: "h1.chapter-title",
      excludeSelectors: [],
      metadata: { title: "N", author: "A", language: "en", coverSource: "none" },
      outputDir: path.join(dataDir, "out"),
      outputFilename: "vols-e2e",
      concurrency: 1,
      delayMin: 0,
      delayMax: 0,
      headless: true,
      output: { epub: true },
    };

    const session: ScrapeSession = {
      id: "vol-e2e",
      status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test",
      novelTitle: "N",
      config: { ...job } as any,
      chapterUrls: job.chapterLinks!,
      completedChapters: [],
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

    const volumes: Volume[] = [
      {
        name: "Volume A",
        chapterUrls: ["http://test/c1"],
      },
      {
        name: "Volume B",
        chapterUrls: ["http://test/c2"],
      },
    ];
    await service.run(job, [], { session }, volumes);

    const epubPath = path.join(dataDir, "out", "vols-e2e.epub");
    expect(fs.existsSync(epubPath)).toBe(true);
    const py = `
import zipfile, json
with zipfile.ZipFile(${JSON.stringify(epubPath)}, "r") as z:
    print(json.dumps([i.filename for i in z.infolist()]))
`;
    const out = execFileSync("python3", ["-c", py], { encoding: "utf8" });
    const names = JSON.parse(out) as string[];
    expect(names).toContain("OEBPS/volumes/volume-1.xhtml");
    expect(names).toContain("OEBPS/volumes/volume-2.xhtml");
  });
});
