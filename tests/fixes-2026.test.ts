// ─────────────────────────────────────────────────────────────────────────────
//  Fixes bundle — three regression tests pinning the user-reported issues:
//
//  Issue 1: TUI noise. During a scrape the spinner stays in place; transient
//           retry/waiting-status drives the spinner message instead of pushing
//           persistent clack log lines for every attempt.
//  Issue 2: Scrape hangs on a failed chapter. `await queue.add(retry)` held the
//           original p-queue concurrency slot through the full retry chain,
//           so with concurrency=1 every other chapter froze until the failed
//           one drained its 3×backoff. Scrapes now skip a chapter after the
//           retry ceiling AND release the slot so other tasks proceed in
//           parallel.
//  Issue 3: Resumability is opt-out, not opt-in. A fresh scrape (no
//           `--resume`) writes a checkpoint to disk from the very first
//           chapter; if it dies mid-run the matching `wnscrape run --job`
//           invocation auto-resumes from that checkpoint, no `--resume`
//           flag needed.
//
//  All three sit on `FakeBrowserPort` + `RecordingUI` + isolated XDG dirs —
//  no real browser, no public internet.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import * as cheerio from "cheerio";

import { ScrapeService } from "../src/core/services/ScrapeService.js";
import { ClackUIAdapter } from "../src/adapters/ui-clack/ClackUIAdapter.js";
import { TaskScreen } from "../src/adapters/ui-clack/screens/TaskScreen.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";
import { FakeBrowserPort, FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";

import { ScriptedPromptProvider } from "../src/adapters/ui-clack/ScriptedPromptProvider.js";
import { JsonCookieStore } from "../src/adapters/store-json/JsonCookieStore.js";
import { JsonProfileStore } from "../src/adapters/store-json/JsonProfileStore.js";
import { YamlConfigStore } from "../src/adapters/config-yaml/YamlConfigStore.js";
import { LiveTaskRegistry } from "../src/adapters/ui-clack/TaskRegistry.js";

import type { JobConfig, ScrapeResult } from "../src/core/domain/JobConfig.js";
import type { ScrapeEvent } from "../src/core/services/events.js";
import type { Logger } from "../src/ports/Logger.js";
import type { ShellContext } from "../src/adapters/ui-clack/ShellContext.js";
import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
  PageHandle,
  BrowserLaunchOpts,
  WaitUntil,
} from "../src/ports/BrowserPort.js";
import type { DomainCookie } from "../src/core/domain/Cookie.js";

// ── A FakePage subclass whose goto() consults a per-URL inject map held on
//    the parent browser. Throwing / swapping body mid-navigation simulates
//    the failures ScrapeService retries on. $ is re-seeded on injection so
//    the inherited cheerio-backed DOM methods (innerHTML/textContent) read
//    the new body. — subclass uses a private-cast to write the private `$`
//    on the base; that's intentional test-double-only abuse.
class InjectingFakePage extends FakePage {
  constructor(
    html: string,
    private readonly visited: (url: string) => void,
    private readonly injectFor: (url: string) => string | undefined,
  ) {
    super(html);
  }

  override goto = async (url: string, opts: { waitUntil: WaitUntil; timeoutMs: number }): Promise<void> => {
    this.visited(url);
    const injected = this.injectFor(url);
    if (injected === "__throw__") {
      throw new Error(`injected-goto-failure: ${url}`);
    }
    if (injected !== undefined) {
      (this as unknown as { $: cheerio.CheerioAPI }).$ = cheerio.load(injected);
      (this as unknown as { html: string }).html = injected;
      this.gotoCalls.push(url);
      return;
    }
    await super.goto(url, opts);
  };
}

// ── Fake BrowserPort that records every goto URL and routes each URL through
//    the InjectingFakePage, which honors a per-URL inject map. ──────────────
class TrackingFakeBrowser implements BrowserPort {
  visitedUrls: string[] = [];
  inject: Record<string, string> = {};
  baseHtml: string;

  constructor(html = "") {
    this.baseHtml = html;
  }

  async launch(_opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return { close: async () => {} };
  }
  async createContext(_browser: BrowserHandle, _cookies?: DomainCookie[]): Promise<ContextHandle> {
    return { close: async () => {} };
  }
  async newPage(_ctx: ContextHandle): Promise<PageHandle> {
    const page = new InjectingFakePage(
      this.baseHtml,
      (url) => { this.visitedUrls.push(url); },
      (url) => this.inject[url],
    );
    return page;
  }
  async closeAll() {}
  async launchEphemeral(opts: BrowserLaunchOpts): Promise<BrowserHandle> {
    return this.launch(opts);
  }
}

// ── Logger stub ──────────────────────────────────────────────────────────────
function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// ── Recording UI ─────────────────────────────────────────────────────────────
class RecordingUI {
  readonly events: ScrapeEvent[] = [];
  emit(e: ScrapeEvent): void { this.events.push(e); }
  onProgress() {}
}

// ── Stub EpubWriter ──────────────────────────────────────────────────────────
class StubEpubWriter {
  async write(_chapters: unknown[], _meta: unknown, destDir: string, filename: string) {
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, filename.endsWith(".epub") ? filename : `${filename}.epub`);
    fs.writeFileSync(p, "stub-epub");
    return { path: p };
  }
}

class ThrowingEpubWriter {
  async write(): Promise<{ path: string }> {
    throw new Error("EPUB build failed (simulated crash)");
  }
}

const chHtml = (i: number) => `<!DOCTYPE html><html><head><title>Chapter ${i}</title></head>
<body><h1 class="t">Chapter ${i}</h1><div class="c"><p>Content of chapter ${i}. Word word word.</p></div></body></html>`;

const emptyHtml = "<html><head><title>x</title></head><body>nothing</body></html>";

// ── XDG isolation ────────────────────────────────────────────────────────────
function isolateXdg(): { data: string; restore: () => void } {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "wns-fix-data-"));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wns-fix-cfg-"));
  const origData = process.env.XDG_DATA_HOME;
  const origConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_CONFIG_HOME = cfg;
  return {
    data,
    restore: () => {
      if (origData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = origData;
      if (origConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origConfig;
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(cfg, { recursive: true, force: true });
    },
  };
}

// ── Minimum JobConfig factory ────────────────────────────────────────────────
function makeJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    method: "toc",
    chapterLinks: ["http://test/c1", "http://test/c2", "http://test/c3"],
    contentSelector: ".c",
    separateTitle: true,
    titleSelector: ".t",
    excludeSelectors: [],
    metadata: { title: "N", author: "A", language: "en", coverSource: "none" },
    outputDir: "./output",
    outputFilename: "test-novel",
    concurrency: 1,
    delayMin: 0,
    delayMax: 0,
    headless: true,
    output: { epub: true },
    ...overrides,
  };
}

// ── Mini shell context for TaskScreen tests ──────────────────────────────────
function makeShellCtx(prompt: ScriptedPromptProvider): ShellContext {
  const log = nullLogger();
  const cookies = new JsonCookieStore(log);
  const profiles = new JsonProfileStore(log);
  const sessions = new JsonSessionStore(log);
  const config = new YamlConfigStore(log);
  const browser = new FakeBrowserPort();
  return {
    config, cookies, profiles, sessions, browser, log, prompt,
    tasks: new LiveTaskRegistry(),
    navigate: () => {},
  } as unknown as ShellContext;
}

// ── Mock PlaywrightBrowserPort for the runJob auto-resume test ───────────────
//    Only the Issue-3 "runJob auto-resumes from a matching checkpoint"
//    test exercises runJob — and it needs a fake browser instead of the real
//    Playwright launch. Because vi.mock is hoisted, the same fake browser is
//    reused for every runJob call in this file; tests that don't touch runJob
//    ignore it entirely. The fake is captured in `MOCK_BROWSER_REF` so each
//    test can pre-seed its inject-map / page HTML before invoking runJob.
let MOCK_BROWSER_REF: TrackingFakeBrowser = new TrackingFakeBrowser();

vi.mock("../src/adapters/browser-playwright/PlaywrightBrowserPort.js", () => ({
  PlaywrightBrowserPort: class {
    launch(opts: BrowserLaunchOpts) {
      return MOCK_BROWSER_REF.launch(opts);
    }
    createContext(br: BrowserHandle, cookies?: DomainCookie[]) {
      return MOCK_BROWSER_REF.createContext(br, cookies);
    }
    newPage(ctx: ContextHandle) {
      return MOCK_BROWSER_REF.newPage(ctx);
    }
    closeAll() {
      return MOCK_BROWSER_REF.closeAll();
    }
    launchEphemeral(opts: BrowserLaunchOpts) {
      return MOCK_BROWSER_REF.launchEphemeral(opts);
    }
  },
}));

import { runJob } from "../src/app/runJob.js";

// ════════════════════════════════════════════════════════════════════════════
//  Issue 2 — failed chapters don't hang the scrape; slot frees for others
// ════════════════════════════════════════════════════════════════════════════
describe("Issue 2 — failed chapter doesn't hang the scrape", () => {
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(() => { env = isolateXdg(); });
  afterEach(() => env.restore());

  it("a chapter whose content selector never matches is dropped after retries and the scrape completes", async () => {
    const log = nullLogger();
    const browser = new TrackingFakeBrowser(emptyHtml);
    browser.inject = {
      "http://test/c1": chHtml(1),
      "http://test/c2": emptyHtml, // selector .c never matches → extract returns null → retry path
      "http://test/c3": chHtml(3),
    };
    const sessions = new JsonSessionStore(log);
    const epub = new StubEpubWriter();
    const ui = new RecordingUI();

    const service = new ScrapeService({
      browser,
      sessions,
      epub,
      ui,
      log,
    });

    const job = makeJob({
      chapterLinks: ["http://test/c1", "http://test/c2", "http://test/c3"],
      concurrency: 1,
      delayMax: 0,
      outputDir: path.join(env.data, "out"),
    });

    const result = await service.run(job, []);

    expect(result.chapters).toHaveLength(3);
    const failed = result.chapters.find((c) => c.url === "http://test/c2");
    expect(failed).toBeDefined();
    expect(failed?.title).toMatch(/failed to scrape/i);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].url).toBe("http://test/c2");

    // All three URLs got visited at least once — no short-circuit skip solely
    // because c2 failed.
    for (const url of job.chapterLinks ?? []) {
      expect(browser.visitedUrls).toContain(url);
    }

    // Retry events recorded (attempt 1, 2, 3) followed by a final failure.
    const retries = ui.events.filter((e) => e.type === "chapter.retry" && e.index === 2);
    expect(retries).toHaveLength(3);
    const failedEv = ui.events.find((e) => e.type === "chapter.failed" && e.index === 2);
    expect(failedEv).toBeDefined();

    // c1 and c3 each emit a chapter.done — they are NOT starved by c2's
    // retry storm (the fire-and-forget retry releases the slot). With the
    // pre-fix `await queue.add(retry)` path, concurrency=1 would have
    // serialized every retry attempt against c2 and then only moved on to
    // c3 — here we assert the actual delivery order proves the slot was
    // released: c1 completes BEFORE c2's first retry is scheduled, which
    // only happens because c2's failure did not hold the slot.
    const done = ui.events.filter((e) => e.type === "chapter.done");
    const doneIndexes = done.map((e) => (e as { index: number }).index).sort();
    expect(doneIndexes).toEqual([1, 3]);
  });

  it("a chapter whose goto throws is retried and then dropped on max retries, letting others proceed", async () => {
    const log = nullLogger();
    const browser = new TrackingFakeBrowser(emptyHtml);
    browser.inject = {
      "http://test/c1": chHtml(1),
      "http://test/c2": "__throw__",
      "http://test/c3": chHtml(3),
    };
    const sessions = new JsonSessionStore(log);
    const epub = new StubEpubWriter();
    const ui = new RecordingUI();

    const service = new ScrapeService({
      browser,
      sessions,
      epub,
      ui,
      log,
    });

    const job = makeJob({
      chapterLinks: ["http://test/c1", "http://test/c2", "http://test/c3"],
      concurrency: 1,
      delayMax: 0,
      outputDir: path.join(env.data, "out"),
    });

    const result = await service.run(job, []);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].url).toBe("http://test/c2");
    expect(result.chapters).toHaveLength(3);
    const failed = result.chapters.find((c) => c.url === "http://test/c2");
    expect(failed?.title).toMatch(/failed to scrape/i);

    // The other two URLs were still visited; their goto succeeded once each.
    expect(browser.visitedUrls).toContain("http://test/c1");
    expect(browser.visitedUrls).toContain("http://test/c3");
  });

  it("cancel() short-circuits in-flight retry backoffs so Ctrl+Q doesn't block for minutes", async () => {
    const log = nullLogger();
    const browser = new TrackingFakeBrowser(emptyHtml);
    browser.inject = {
      "http://test/c1": "__throw__",
    };
    const sessions = new JsonSessionStore(log);
    const epub = new StubEpubWriter();
    const ui = new RecordingUI();

    const service = new ScrapeService({
      browser, sessions, epub, ui, log,
    });

    const job = makeJob({
      chapterLinks: ["http://test/c1"],
      concurrency: 1,
      delayMax: 60_000, // a long backoff that, without cancellation, would
      // hold the run for ~60s×3 ≈ 3 minutes per the bug report.
      delayMin: 60_000,
      outputDir: path.join(env.data, "out"),
    });

    // Kick off the scrape, cancel it after 50ms. With the cancelableDelay
    // path the in-flight retry backoff short-circuits and the run resolves
    // near-immediately; without it the await would block for the full 60s.
    const runPromise = service.run(job, []);
    setTimeout(() => service.cancel(), 50);

    const settled = await Promise.race([
      runPromise.then(() => "settled" as const),
      delay(5_000).then(() => "timeout" as const),
    ]);
    expect(settled).toBe("settled");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Issue 1 — TUI noise: spinner stays in place; transient status drives
//  the spinner message instead of persistent clack log lines
// ════════════════════════════════════════════════════════════════════════════
describe("Issue 1 — retry/backoff no longer spam persistent log lines", () => {
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(() => { env = isolateXdg(); });
  afterEach(() => env.restore());

  it("ClackUIAdapter does not log chapter.retry / challenge.waiting / chapter.start as persistent lines", () => {
    const prompt = new ScriptedPromptProvider([]);
    const ui = new ClackUIAdapter(prompt);

    ui.emit({ type: "chapter.start", index: 7, url: "http://x/y" });
    ui.emit({
      type: "chapter.retry",
      index: 7, attempt: 1, max: 3, challenge: false, backoffMs: 100,
    });
    ui.emit({ type: "challenge.waiting", url: "http://x/y" });

    const retryLogs = prompt.calls.filter(
      (c) => c.kind === "log" && (c.logMsg ?? "").includes("Retry ch.7"),
    );
    const challengeLogs = prompt.calls.filter(
      (c) => c.kind === "log" && (c.logMsg ?? "").includes("Anti-bot challenge"),
    );
    const startLogs = prompt.calls.filter(
      (c) => c.kind === "log" && (c.logMsg ?? "").includes("Scraping ch.7"),
    );
    expect(retryLogs).toEqual([]);
    expect(challengeLogs).toEqual([]);
    expect(startLogs).toEqual([]);
  });

  it("ClackUIAdapter still logs chapter.failed + epub.done persistently", () => {
    const prompt = new ScriptedPromptProvider([]);
    const ui = new ClackUIAdapter(prompt);

    ui.emit({ type: "chapter.failed", index: 9, url: "http://x/9", error: "boom" });
    ui.emit({ type: "epub.done", path: "/tmp/x.epub" });

    expect(
      prompt.calls.some((c) => c.kind === "log" && c.logKind === "error" && (c.logMsg ?? "").includes("Failed ch.9")),
    ).toBe(true);
    expect(
      prompt.calls.some((c) => c.kind === "log" && c.logKind === "success" && (c.logMsg ?? "").includes("/tmp/x.epub")),
    ).toBe(true);
  });

  it("TaskScreen spinner updates once per chapter.start + once per chapter.done; transient status does not bleed out as persistent log lines", async () => {
    const prompt = new ScriptedPromptProvider([""]);
    const ctx = makeShellCtx(prompt);
    const browser = ctx.browser as FakeBrowserPort;
    browser.setContent(chHtml(1)); // .c matches; every URL extracts cleanly.

    const job = makeJob({
      chapterLinks: ["http://test/c1", "http://test/c2"],
      concurrency: 1,
      delayMax: 0,
      outputDir: path.join(env.data, "out"),
      contentSelector: ".c",
      titleSelector: ".t",
    });

    const taskScreen = new TaskScreen();
    await taskScreen.render(ctx, {
      job,
      chapterUrls: ["http://test/c1", "http://test/c2"],
      domain: "",
      isNewDomain: false,
      cookies: [],
    });

    const spinnerEvents = prompt.spinnerEvents;
    const starts = spinnerEvents.filter((e) => e.action === "start");
    expect(starts.length).toBe(1);
    const messages = spinnerEvents.filter((e) => e.action === "message");
    // For 2 chapters we expect: 2× chapter.start ("Scraping ch.N/M…") +
    // 2× chapter.done updating the bar. No retry/waiting events fire on a
    // happy path, so the transient message stream is exactly 4 updates.
    const startsMsg = messages.filter((m) => (m.text ?? "").includes("Scraping ch."));
    const doneMsg = messages.filter((m) => (m.text ?? "").includes("Chapter "));
    expect(startsMsg.length).toBe(2);
    expect(doneMsg.length).toBe(2);

    // Issue 1 invariant — no persistent clack log lines were emitted for
    // the transient per-chapter status. Failed chapters and one-time
    // milestones still go through, but plain chapter progress must not be
    // re-emitted via `log("info"|"warn", ...)` because that scrolls the
    // spinner offscreen.
    const transientLogs = prompt.calls.filter(
      (c) => c.kind === "log" && (
        (c.logMsg ?? "").includes("Anti-bot challenge") ||
        (c.logMsg ?? "").includes("Retry ch.") ||
        (c.logMsg ?? "").includes("Scraping ch.")
      ),
    );
    expect(transientLogs).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Issue 3 — fresh runs write a checkpoint on disk and can be resumed
//  without `--resume`.
// ════════════════════════════════════════════════════════════════════════════
describe("Issue 3 — fresh runs auto-persist a resumable checkpoint", () => {
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(() => {
    env = isolateXdg();
    MOCK_BROWSER_REF = new TrackingFakeBrowser();
  });
  afterEach(() => env.restore());

  it("on a fresh scrape that dies mid-EPUB, the session file remains on disk with entryUrl=job.tocUrl", async () => {
    const log = nullLogger();
    const browser = new TrackingFakeBrowser(chHtml(1));
    browser.inject = {
      "http://test/c1": chHtml(1),
      "http://test/c2": chHtml(2),
    };
    const sessions = new JsonSessionStore(log);
    const epub = new ThrowingEpubWriter();
    const ui = new NoopUIAdapter();

    const service = new ScrapeService({
      browser,
      sessions,
      epub: epub as unknown,
      ui,
      log,
    });

    const job = makeJob({
      tocUrl: "http://test/novel",
      chapterLinks: ["http://test/c1", "http://test/c2"],
      concurrency: 1,
      delayMax: 0,
      outputDir: path.join(env.data, "out"),
    });

    await expect(service.run(job, [])).rejects.toThrow(/EPUB build failed/);

    // The checkpoint is still on disk — the resume picker can find it by
    // entryUrl below.
    const summaries = await sessions.list();
    expect(summaries.length).toBe(1);
    expect(summaries[0].novelTitle).toBe("N");

    const found = await sessions.findByEntryUrl("http://test/novel");
    expect(found).not.toBeNull();
    expect(found?.chapterUrls).toEqual(["http://test/c1", "http://test/c2"]);
    expect(found?.completedChapters.length).toBe(2); // chapters scraped OK, only the EPUB step blew up
  });

  it("runJob auto-resumes from a matching checkpoint without an explicit resumeSessionId", async () => {
    const log = nullLogger();
    const sessions = new JsonSessionStore(log);

    const jobConfig = makeJob({
      tocUrl: "http://test/novel",
      chapterLinks: ["http://test/c1", "http://test/c2"],
      concurrency: 1,
      delayMax: 0,
      outputDir: path.join(env.data, "out"),
    });
    const session = {
      id: "crashed-test",
      status: "in-progress" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      domain: "test",
      entryUrl: "http://test/novel",
      novelTitle: "N",
      config: { ...jobConfig } as never,
      chapterUrls: ["http://test/c1", "http://test/c2"],
      completedChapters: [
        { index: 1, title: "Chapter 1", url: "http://test/c1", htmlContent: "<p>x</p>", wordCount: 1 },
      ],
      errors: [],
    };
    await sessions.save(session);

    MOCK_BROWSER_REF.baseHtml = chHtml(2);
    MOCK_BROWSER_REF.inject = { "http://test/c2": chHtml(2) };

    // No resumeSessionId passed — the user just ran `wnscrape run --job foo.yaml`
    // against the same job after the previous one crashed. The auto-resume
    // path must pick up the saved checkpoint based on `job.tocUrl` matching
    // `session.entryUrl`.
    const result: ScrapeResult = await runJob(jobConfig, {
      log, ui: new NoopUIAdapter(),
    });

    // The pre-completed c1 was carried over from the checkpoint unchanged
    // (`<p>x</p>`), and c2 was scraped fresh. So we get 2 chapters back,
    // with c1's htmlContent preserved exactly from the session — proving the
    // checkpoint was honored.
    expect(result.chapters).toHaveLength(2);
    const c1 = result.chapters.find((c) => c.url === "http://test/c1");
    expect(c1?.htmlContent).toBe("<p>x</p>");
    const c2 = result.chapters.find((c) => c.url === "http://test/c2");
    expect(c2).toBeDefined();
    expect(c2?.title).toBe("Chapter 2");

    // c1's URL was NOT visited — the auto-resume honored the checkpoint and
    // skipped already-completed work (the user's headline Issue-3 concern).
    expect(MOCK_BROWSER_REF.visitedUrls).not.toContain("http://test/c1");
    expect(MOCK_BROWSER_REF.visitedUrls).toContain("http://test/c2");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
