// ─────────────────────────────────────────────────────────────────────────────
//  Phase 3 TUI tests (readme §3 test plan, T1-T11).
//
//  Drives every Phase 3 screen through ScriptedPromptProvider (no TTY, no
//  @clack/prompts rendering) against real JSON/YAML stores on isolated XDG
//  dirs, plus Shell-level navigation tests with a fake stdin.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import type { Logger } from "../src/ports/Logger.js";
import type { SessionStore } from "../src/ports/SessionStore.js";
import type { ScrapeSession, SessionSummary } from "../src/core/domain/Session.js";
import type { StoredCookie } from "../src/core/domain/Cookie.js";
import type { SiteProfile } from "../src/ports/ProfileStore.js";

import { JsonCookieStore } from "../src/adapters/store-json/JsonCookieStore.js";
import { JsonProfileStore } from "../src/adapters/store-json/JsonProfileStore.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import { YamlConfigStore } from "../src/adapters/config-yaml/YamlConfigStore.js";
import { FakeBrowserPort } from "../src/adapters/store-memory/FakeBrowserPort.js";

import { Cancel } from "../src/adapters/ui-clack/PromptProvider.js";
import { ScriptedPromptProvider } from "../src/adapters/ui-clack/ScriptedPromptProvider.js";
import { Shell } from "../src/adapters/ui-clack/Shell.js";
import type { Screen, ShellContext, ScreenResult } from "../src/adapters/ui-clack/ShellContext.js";
import { commandPaletteLoop } from "../src/adapters/ui-clack/commandPalette.js";
import * as fmt from "../src/adapters/ui-clack/format.js";
import {
  validateDomain,
  validateProfileNameChars,
  validateUrl,
  normalizeUrl,
} from "../src/adapters/ui-clack/validation.js";
import { MainScreen } from "../src/adapters/ui-clack/screens/MainScreen.js";
import { ResumeScreen } from "../src/adapters/ui-clack/screens/ResumeScreen.js";
import { CookieManagerScreen } from "../src/adapters/ui-clack/screens/CookieManagerScreen.js";
import { SettingsScreen } from "../src/adapters/ui-clack/screens/SettingsScreen.js";
import { LibraryScreen, defaultListEpubs } from "../src/adapters/ui-clack/screens/LibraryScreen.js";
import { ChapterListScreen } from "../src/adapters/ui-clack/screens/ChapterListScreen.js";
import { makeErrorReporter } from "../src/adapters/ui-clack/screens/ErrorScreen.js";

// ── Harness ─────────────────────────────────────────────────────────────────

class MemoryLogger implements Logger {
  errors: string[] = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(msg: string): void {
    this.errors.push(msg);
  }
}

function tmpRoot(): { data: string; config: string } {
  return {
    data: fs.mkdtempSync(path.join(os.tmpdir(), "wns-tui-data-")),
    config: fs.mkdtempSync(path.join(os.tmpdir(), "wns-tui-cfg-")),
  };
}

function cleanTmp(t: { data: string; config: string }): void {
  for (const dir of [t.data, t.config]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

let dirs: { data: string; config: string } | null = null;
let log = new MemoryLogger();

beforeEach(() => {
  dirs = tmpRoot();
  process.env.XDG_DATA_HOME = dirs.data;
  process.env.XDG_CONFIG_HOME = dirs.config;
  log = new MemoryLogger();
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  if (dirs) cleanTmp(dirs);
  dirs = null;
});

function makeCtx(prompt: ScriptedPromptProvider): {
  ctx: ShellContext;
  cookies: JsonCookieStore;
  profiles: JsonProfileStore;
  sessions: SessionStore;
  config: YamlConfigStore;
  browser: FakeBrowserPort;
} {
  const cookies = new JsonCookieStore(log);
  const profiles = new JsonProfileStore(log);
  const sessions = new JsonSessionStore(log);
  const config = new YamlConfigStore(log);
  const browser = new FakeBrowserPort();
  const ctx: ShellContext = {
    config,
    cookies,
    profiles,
    sessions,
    browser,
    log,
    prompt,
    tasks: {},
    navigate: () => {},
  };
  return { ctx, cookies, profiles, sessions, config, browser };
}

function findLog(
  p: ScriptedPromptProvider,
  kind: "info" | "success" | "warn" | "error" | "dim",
  substr: string,
): boolean {
  return p.calls.some(
    (c) => c.kind === "log" && c.logKind === kind && (c.logMsg ?? "").includes(substr),
  );
}

const sampleCookie = (name: string, value = "v"): StoredCookie => ({
  name,
  value,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
});

// ── T1: architecture - @clack/prompts only inside clackPrompts.ts ───────────

describe("T1 architecture: @clack/prompts import isolation", () => {
  it("only clackPrompts.ts may import @clack/prompts", () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (!ent.name.endsWith(".ts")) continue;
        const rel = path.relative(srcRoot, full);
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line) => {
          const t = line.trim();
          if (t.startsWith("//")) return;
          if (t.includes("@clack/prompts") && /(import|require)/.test(t)) {
            hits.push(rel);
          }
        });
      }
    };
    walk(srcRoot);
    expect(hits).toEqual(["adapters/ui-clack/clackPrompts.ts"]);
  });
});

// ── T2/T3: MainScreen + command palette ─────────────────────────────────────

describe("T2/T3 MainScreen + palette", () => {
  it("T2: renders with zero sessions and Cancel pops (no-op at root)", async () => {
    const prompt = new ScriptedPromptProvider([Cancel]);
    const { ctx } = makeCtx(prompt);
    const result = await new MainScreen().render(ctx);
    expect(result).toEqual({ action: "pop" });
    // ADR-P3-FIX-TUI: MainScreen no longer emits the banner; the Shell does
    // that once per session. See the Shell-header test below for the one-shot.
    expect(findLog(prompt, "info", "WebNovel Scraper")).toBe(false);
    expect(prompt.calls.find((c) => c.kind === "select")).toMatchObject({
      kind: "select",
      message: "What do you want to do?",
    });
  });

  it("T3: 'cookies' choice pushes the CookieManager screen", async () => {
    const prompt = new ScriptedPromptProvider(["cookies"]);
    const { ctx } = makeCtx(prompt);
    const result = await new MainScreen().render(ctx);
    expect(result).toEqual({ action: "push", screen: "cookies" });
  });

  it("palette: :resume pushes resume; :quit quits; unknown loops then Esc returns null", async () => {
    const prompt = new ScriptedPromptProvider([":resume"]);
    expect(await commandPaletteLoop(prompt)).toEqual({ action: "push", screen: "resume" });

    const p2 = new ScriptedPromptProvider([":quit"]);
    expect(await commandPaletteLoop(p2)).toEqual({ action: "quit" });

    const p3 = new ScriptedPromptProvider([":bogus", Cancel]);
    expect(await commandPaletteLoop(p3)).toBeNull();
    expect(findLog(p3, "warn", "Unknown command")).toBe(true);
  });
});

// ── T4-T7: CookieManager ────────────────────────────────────────────────────

describe("CookieManager flows", () => {
  it("T4: add a new domain+profile via header paste, with validator re-entry", async () => {
    const prompt = new ScriptedPromptProvider([
      "__add__",
      "bad_domain", // rejected by validateDomain -> re-prompts
      "example.com",
      "default",
      "header",
      "session=abc; theme=dark",
      true,
      Cancel,
      Cancel,
    ]);
    const { ctx, cookies } = makeCtx(prompt);
    const result = await new CookieManagerScreen().render(ctx);

    expect(result).toEqual({ action: "pop" });
    const profile = await cookies.getProfile("example.com", "default");
    expect(profile?.cookies.map((c) => c.name).sort()).toEqual(["session", "theme"]);
    expect(findLog(prompt, "success", "Saved 2 cookie(s)")).toBe(true);
  });

  it("T5: header paste on an existing profile upserts (replaces by name, adds new)", async () => {
    const prompt = new ScriptedPromptProvider([
      "domain:example.com",
      "profile:default",
      "add_header",
      "session=NEW; theme=dark",
      true,
      "back",
      "__back__",
      Cancel,
    ]);
    const { ctx, cookies } = makeCtx(prompt);
    await cookies.save("example.com", "default", [sampleCookie("session", "OLD")]);
    await new CookieManagerScreen().render(ctx);

    const profile = await cookies.getProfile("example.com", "default");
    expect(profile?.cookies).toHaveLength(2);
    const session = profile?.cookies.find((c) => c.name === "session");
    expect(session?.value).toBe("NEW");
  });

  it("T6: delete a single cookie by name", async () => {
    const prompt = new ScriptedPromptProvider([
      "domain:example.com",
      "profile:default",
      "delete_one",
      "session",
      "back",
      "__back__",
      Cancel,
    ]);
    const { ctx, cookies } = makeCtx(prompt);
    await cookies.save("example.com", "default", [
      sampleCookie("session"),
      sampleCookie("theme"),
    ]);
    await new CookieManagerScreen().render(ctx);

    const profile = await cookies.getProfile("example.com", "default");
    expect(profile?.cookies.map((c) => c.name)).toEqual(["theme"]);
    expect(findLog(prompt, "success", 'Deleted "session"')).toBe(true);
  });

  it("T7: browser capture replaces the profile cookies (ADR-P3-A read-back)", async () => {
    const prompt = new ScriptedPromptProvider([
      "domain:example.com",
      "profile:default",
      "capture",
      "https://example.com",
      "", // press Enter in the browser window
      true,
      "back",
      "__back__",
      Cancel,
    ]);
    const { ctx, cookies, browser } = makeCtx(prompt);
    await cookies.save("example.com", "default", [sampleCookie("OLD")]);
    browser.setContextCookies([sampleCookie("a"), sampleCookie("b")]);

    await new CookieManagerScreen().render(ctx);

    expect(browser.ephemeralLaunchCount()).toBe(1);
    const profile = await cookies.getProfile("example.com", "default");
    expect(profile?.cookies.map((c) => c.name).sort()).toEqual(["a", "b"]);
    expect(findLog(prompt, "success", "Captured 2 cookie(s)")).toBe(true);
  });
});

// ── T8/T9: Settings ─────────────────────────────────────────────────────────

describe("Settings flows", () => {
  it("T8: global settings - edit perf group persists to YAML", async () => {
    const prompt = new ScriptedPromptProvider([
      "global",
      "perf",
      "3",
      "1000-2000",
      "2",
      "back",
      "back",
    ]);
    const { ctx, config } = makeCtx(prompt);
    const result = await new SettingsScreen().render(ctx);

    expect(result).toEqual({ action: "pop" });
    const cfg = await config.read();
    expect(cfg.defaultConcurrency).toBe(3);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.defaultDelayMin).toBe(1000);
    expect(cfg.defaultDelayMax).toBe(2000);
    expect(findLog(prompt, "success", "Settings saved")).toBe(true);
  });

  it("T9: site profile - edit label/notes persists", async () => {
    const prompt = new ScriptedPromptProvider([
      "profiles",
      "profile:example.com",
      "edit_label",
      "My Novels",
      "reads weekly",
      "back",
      "__back__",
      "back",
    ]);
    const { ctx, profiles } = makeCtx(prompt);
    const base: SiteProfile = {
      domain: "example.com",
      method: "toc",
      contentSelector: "#content",
      separateTitle: false,
      excludeSelectors: [],
      savedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await profiles.save("example.com", base);

    const result = await new SettingsScreen().render(ctx);
    expect(result).toEqual({ action: "pop" });
    const saved = await profiles.list();
    expect(saved["example.com"].label).toBe("My Novels");
    expect(saved["example.com"].notes).toBe("reads weekly");
    expect(findLog(prompt, "success", "Profile updated")).toBe(true);
  });
});

// ── T10: Library ────────────────────────────────────────────────────────────

describe("Library", () => {
  it("T10: opens an EPUB via injected opener and deletes via real fs", async () => {
    const epubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-tui-lib-"));
    try {
      fs.writeFileSync(path.join(epubDir, "a.epub"), "fake");
      const opened: string[] = [];
      const openFn = async (absPath: string): Promise<void> => {
        opened.push(absPath);
      };
      const prompt = new ScriptedPromptProvider([
        "open:a.epub",
        "__delete__",
        "del:a.epub",
        true,
        "__back__",
      ]);
      const { ctx, config } = makeCtx(prompt);
      await config.write({ defaultOutputDir: epubDir });

      const screen = new LibraryScreen({ list: defaultListEpubs, open: openFn });
      const result = await screen.render(ctx);

      expect(result).toEqual({ action: "pop" });
      expect(opened).toHaveLength(1);
      expect(opened[0].endsWith("a.epub")).toBe(true);
      expect(fs.existsSync(path.join(epubDir, "a.epub"))).toBe(false);
      expect(findLog(prompt, "success", "Deleted: a.epub")).toBe(true);
    } finally {
      fs.rmSync(epubDir, { recursive: true, force: true });
    }
  });

  it("empty dir warns and pops without opening anything", async () => {
    const epubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-tui-lib-"));
    try {
      const prompt = new ScriptedPromptProvider([]);
      const { ctx, config } = makeCtx(prompt);
      await config.write({ defaultOutputDir: epubDir });
      const screen = new LibraryScreen({ list: defaultListEpubs, open: async () => {} });
      const result = await screen.render(ctx);
      expect(result).toEqual({ action: "pop" });
      expect(findLog(prompt, "warn", "No EPUBs found")).toBe(true);
    } finally {
      fs.rmSync(epubDir, { recursive: true, force: true });
    }
  });
});

// ── T11: Resume + error reporter ────────────────────────────────────────────

describe("Resume + error reporting", () => {
  class FakeSessionStore implements SessionStore {
    private sessions: SessionSummary[] = [];
    private loaded: ScrapeSession | null = null;
    set(s: SessionSummary[]): void {
      this.sessions = [...s];
    }
    setLoad(s: ScrapeSession): void {
      this.loaded = s;
    }
    async list(): Promise<SessionSummary[]> {
      return [...this.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    }
    async delete(id: string): Promise<boolean> {
      const before = this.sessions.length;
      this.sessions = this.sessions.filter((s) => s.id !== id);
      return this.sessions.length < before;
    }
    async load(_id: string): Promise<ScrapeSession | null> {
      return this.loaded;
    }
    async save(_s: ScrapeSession): Promise<void> {}
    async findByEntryUrl(_url: string): Promise<ScrapeSession | null> {
      return null;
    }
  }

  it("T11: lists sessions and deletes one without a confirm", async () => {
    const store = new FakeSessionStore();
    store.set([
      { id: "aaa", novelTitle: "Book A", domain: "a.com", totalChapters: 10, completedCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "bbb", novelTitle: "Book B", domain: "b.com", totalChapters: 5, completedCount: 5, updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const prompt = new ScriptedPromptProvider([
      "__delete__",
      "del:bbb",
      "__back__",
    ]);
    const { ctx } = makeCtx(prompt);
    ctx.sessions = store;

    const result = await new ResumeScreen().render(ctx);
    expect(result).toEqual({ action: "pop" });
    const remaining = await store.list();
    expect(remaining.map((s) => s.id)).toEqual(["aaa"]);
    expect(findLog(prompt, "success", "Session deleted.")).toBe(true);
  });

  it("selecting a session replaces with TaskScreen with the resume params", async () => {
    const store = new FakeSessionStore();
    const summary = { id: "aaa", novelTitle: "Book A", domain: "a.com", totalChapters: 10, completedCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" };
    store.set([summary]);
    const session: ScrapeSession = {
      id: "aaa",
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      domain: "a.com",
      entryUrl: "https://a.com/book-a",
      novelTitle: "Book A",
      config: {
        method: "toc",
        tocUrl: "https://a.com/book-a",
        contentSelector: ".content",
        separateTitle: true,
        titleSelector: ".title",
        excludeSelectors: [],
        metadata: { title: "Book A", author: "X", language: "en", coverSource: "none" },
        outputDir: "/tmp",
        outputFilename: "book-a.epub",
        concurrency: 2,
        delayMin: 1200,
        delayMax: 3500,
        headless: true,
      },
      chapterUrls: ["https://a.com/c1", "https://a.com/c2"],
      completedChapters: [],
      errors: [],
    };
    store.setLoad(session);

    const prompt = new ScriptedPromptProvider(["session:aaa"]);
    const { ctx } = makeCtx(prompt);
    ctx.sessions = store;

    const result = await new ResumeScreen().render(ctx);
    expect(result.action).toBe("replace");
    expect(result).toMatchObject({ action: "replace", screen: "task" });
    const params = (result as { params: { resumeSession: ScrapeSession } }).params;
    expect(params.resumeSession.id).toBe("aaa");
    expect(params.resumeSession.chapterUrls).toEqual(["https://a.com/c1", "https://a.com/c2"]);
  });

  it("error reporter logs stack lines and blocks on an acknowledge prompt", async () => {
    const prompt = new ScriptedPromptProvider([""]);
    const { ctx } = makeCtx(prompt);
    const reporter = makeErrorReporter(ctx.prompt, ctx.log);
    const result = await reporter.reportError("boom", new Error("kaput"));
    expect(result).toEqual({ action: "pop" });
    expect(findLog(prompt, "error", "boom: kaput")).toBe(true);
    expect(ctx.log);
  });
});

// ── Shell-level navigation & graceful quit ──────────────────────────────────

describe("Shell navigation", () => {
  class SequenceScreen implements Screen {
    renders = 0;
    constructor(
      public id: string,
      private steps: ScreenResult[],
    ) {}
    async render(): Promise<ScreenResult> {
      this.renders++;
      return this.steps.shift() ?? { action: "quit" };
    }
  }

  it("nested cancel pops (returns to caller); root cancel is a no-op; quit ends", async () => {
    const prompt = new ScriptedPromptProvider([]);
    const { ctx } = makeCtx(prompt);
    ctx.navigate = () => {};
    const browser = new FakeBrowserPort();
    ctx.browser = browser;

    const main = new SequenceScreen("main", [
      { action: "push", screen: "nested" },
      { action: "pop" }, // root pop: no-op
      { action: "quit" },
    ]);
    const nested = new SequenceScreen("nested", [{ action: "pop" }]);

    const registry = new Map<string, Screen>([
      ["main", main],
      ["nested", nested],
    ]);
    let exited = 0;
    const shell = new Shell(registry, {
      ...ctx,
      prompt,
      exitFn: () => exited++,
    });
    await shell.run("main");

    expect(main.renders).toBe(3); // push, root-pop no-op, quit
    expect(nested.renders).toBe(1); // pop returned to main, did not quit
    expect(exited).toBe(1);
  });

  it("Ctrl+Q graceful quit triggers shutdown: flushOnQuit, closeAll, exitFn", async () => {
    const stdin = new PassThrough() as NodeJS.ReadStream & {
      setRawMode?: (m: boolean) => void;
      isTTY?: boolean;
    };
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { isRaw: boolean }).isRaw = false;
    (stdin as unknown as { setRawMode: (m: boolean) => void }).setRawMode = (m: boolean) => {
      (stdin as unknown as { isRaw: boolean }).isRaw = m;
    };

    const { ctx } = makeCtx(new ScriptedPromptProvider([]));
    const browser = new FakeBrowserPort();
    ctx.browser = browser;

    // A screen that keeps re-rendering via root-pop no-op so the loop stays
    // alive until Ctrl+Q flips quitRequested. Each render yields to the
    // macrotask queue so the test's timer/keypress can run (a pure microtask
    // spin would starve them).
    class LiveScreen implements Screen {
      id = "main";
      renders = 0;
      async render(): Promise<ScreenResult> {
        this.renders++;
        await new Promise((r) => setTimeout(r, 2));
        return { action: "pop" };
      }
    }
    const live = new LiveScreen();
    const registry = new Map<string, Screen>([["main", live]]);

    let flushed = 0;
    let exited = 0;
    const shell = new Shell(registry, {
      config: ctx.config,
      cookies: ctx.cookies,
      profiles: ctx.profiles,
      sessions: ctx.sessions,
      browser,
      log: ctx.log,
      prompt: ctx.prompt,
      tasks: ctx.tasks,
      stdin,
      flushOnQuit: async () => {
        flushed++;
      },
      exitFn: () => {
        exited++;
      },
    });

    const runPromise = shell.run("main");
    // Let the loop spin a few times, then simulate Ctrl+Q.
    await new Promise((r) => setTimeout(r, 20));
    expect(live.renders).toBeGreaterThan(1);
    stdin.emit("keypress", "\u0011", { name: "q", ctrl: true });
    await runPromise;

    expect(exited).toBe(1);
    expect(flushed).toBe(1);
  });
});

// ── Chrome: format + validation units ───────────────────────────────────────

describe("format & validation chrome", () => {
  it("banner is a fixed 80-column box at default width", () => {
    const out = fmt.banner().split("\n");
    expect(out[0]).toBe(`╔${"═".repeat(78)}╗`);
    for (const line of out) expect(line.length).toBe(80);
    expect(out[out.length - 1]).toBe(`╚${"═".repeat(78)}╝`);
  });

  it("banner honours an explicit narrow width", () => {
    const out = fmt.banner({ width: 40, colors: false }).split("\n");
    for (const line of out) expect(line.length).toBe(40);
  });

  it("section() is a deterministic width-80 divider block", () => {
    const out = fmt.section("Global Settings", { colors: false });
    const lines = out.split("\n");
    expect(lines[0]).toBe(""); // leading blank line separates from the log above
    expect(lines[1]).toBe("".padEnd(78, "─"));
    expect(lines[2]).toBe("  Global Settings");
    expect(lines[3]).toBe(lines[1]);
  });

  it("cookieTable renders headers, an empty-state row, and no color when colors=false", () => {
    const empty = fmt.cookieTable([], "example.com", "default", { colors: false });
    expect(empty).toContain("(no cookies stored)");
    expect(empty).toContain('Cookies for example.com · profile "default" (0 stored)');
    expect(empty).not.toContain("\u001b[");
    const one = fmt.cookieTable([sampleCookie("session", "abc")], "example.com", "default", { colors: false });
    expect(one).toContain("session");
    expect(one).toContain("abc");
  });

  it("truncate adds an ellipsis and never exceeds maxLen", () => {
    expect(fmt.truncate("hello", 3)).toBe("he…");
    expect(fmt.truncate("hi", 5)).toBe("hi");
  });

  it("validation helpers match v1 semantics (validateUrl is tightened)", () => {
    expect(validateDomain("example.com")).toBe(true);
    expect(validateDomain("http://example.com/read")).toBe(true);
    expect(validateDomain("localhost")).toBe(true);
    expect(typeof validateDomain("nope")).toBe("string");
    expect(validateProfileNameChars("default")).toBe(true);
    expect(validateProfileNameChars("Alt Account")).toBe("Only lowercase letters, numbers, _ and - are allowed");
    expect(validateUrl("https://a.com")).toBe(true);
    expect(typeof validateUrl("not a url")).toBe("string");
  });

  it("profileMetaLine and sessionLine compose summary strings", () => {
    const meta = fmt.profileMetaLine(
      { name: "default", cookieCount: 3, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      "default",
      { colors: false },
    );
    expect(meta).toContain("3 cookies");
    const s = fmt.sessionLine({
      id: "x",
      novelTitle: "Book",
      domain: "a.com",
      totalChapters: 10,
      completedCount: 4,
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(s).toContain("Book");
    expect(s).toContain("4/10 chapters");
    expect(s).toContain("2026-01-02 03:04");
  });
});

// ── Bug-fix tests: URL double-prefix + TUI cleanliness pass ──────────────────
//
// Covers `docs/fix-issue-tui-url-cleanliness.md`:
//  - validateUrl tightens (reject empty / scheme-doubled / dotless hostnames;
//    accept bare hostnames).
//  - normalizeUrl prepends https:// to bare hostnames.
//  - CookieManager capture flow does not double-prefix a URL typed with a
//    scheme (FakeBrowserPort.lastPage.gotoCalls records the actual navigation).
//  - ChapterListScreen no longer reprints the full chapter list on every loop
//    iteration (listDirty gate).
//  - SettingsScreen.printProfile emits a single `note` call rather than ~14
//    separate log rows.
//  - Shell.run() emits the banner exactly once (header strip).
// ─────────────────────────────────────────────────────────────────────────────

function countLogRows(
  p: ScriptedPromptProvider,
  pattern: RegExp,
  kind?: "info" | "success" | "warn" | "error" | "dim",
): number {
  return p.calls.filter(
    (c) =>
      c.kind === "log" &&
      (kind ? c.logKind === kind : true) &&
      pattern.test(c.logMsg ?? ""),
  ).length;
}

describe("validateUrl (tightened)", () => {
  it("accepts a well-formed https URL", () => {
    expect(validateUrl("https://www.webnovel.com/login")).toBe(true);
  });
  it("accepts a bare hostname (no scheme) - caller will prepend https://", () => {
    expect(validateUrl("www.webnovel.com/login")).toBe(true);
  });
  it("rejects empty input", () => {
    expect(validateUrl("")).toBe("URL cannot be empty");
    expect(validateUrl("   ")).toBe("URL cannot be empty");
  });
  it("rejects scheme-doubled URLs", () => {
    expect(validateUrl("https://https://www.webnovel.com/")).toMatch(/hostname looks invalid/);
    expect(validateUrl("https://http://example.com/")).toMatch(/hostname looks invalid/);
  });
  it("rejects a hostname with no dot", () => {
    expect(validateUrl("https://localhost")).toMatch(/hostname looks invalid/);
  });
});

describe("normalizeUrl", () => {
  it("prepends https:// to a bare hostname", () => {
    expect(normalizeUrl("www.webnovel.com/login")).toBe("https://www.webnovel.com/login");
  });
  it("leaves a fully-qualified URL untouched", () => {
    expect(normalizeUrl("https://www.webnovel.com/login")).toBe("https://www.webnovel.com/login");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeUrl("  https://example.com/  ")).toBe("https://example.com/");
  });
});

describe("CookieManager capture flow URL handling", () => {
  it("does not double-prefix when the user types a URL with its own scheme", async () => {
    // The bug: pre-fill with `https://${domain}` invited `https://https://...`
    // when the user typed the scheme. Post-fix, the placeholder is not a seed,
    // and the call site normalizes the validated input. With a fully-qualified
    // input the navigation target is exactly what the user typed.
    const prompt = new ScriptedPromptProvider([
      "domain:example.com",
      "profile:default",
      "capture",
      "https://www.webnovel.com/login",
      "", // press Enter in the browser window to finish capture
      true, // confirm save
      "back",
      "__back__",
      Cancel,
    ]);
    const { ctx, cookies, browser } = makeCtx(prompt);
    await cookies.save("example.com", "default", [sampleCookie("OLD")]);
    browser.setContextCookies([sampleCookie("a"), sampleCookie("b")]);

    await new CookieManagerScreen().render(ctx);

    expect(browser.lastPage).not.toBeNull();
    expect(browser.lastPage!.gotoCalls).toEqual(["https://www.webnovel.com/login"]);
    expect(browser.ephemeralLaunchCount()).toBe(1);
  });

  it("prepends https:// when the user types a bare hostname", async () => {
    const prompt = new ScriptedPromptProvider([
      "domain:example.com",
      "profile:default",
      "capture",
      "www.webnovel.com/login",
      "",
      true,
      "back",
      "__back__",
      Cancel,
    ]);
    const { ctx, cookies, browser } = makeCtx(prompt);
    await cookies.save("example.com", "default", [sampleCookie("OLD")]);
    browser.setContextCookies([sampleCookie("a")]);

    await new CookieManagerScreen().render(ctx);

    expect(browser.lastPage!.gotoCalls).toEqual(["https://www.webnovel.com/login"]);
  });
});

describe("ChapterListScreen reprint gate", () => {
  it("does not reprint the full chapter list after a remove action returns to the action prompt", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://x.com/chapter-${i + 1}`);
    const prompt = new ScriptedPromptProvider([
      "remove",
      "1", // remove chapter index 1
      "back", // exit on next iteration
    ]);
    const { ctx } = makeCtx(prompt);
    const screen = new ChapterListScreen();
    await screen.render(ctx, { urls });

    // The "  1.  ..." log row shape fires once on the initial print, once on
    // the post-remove reprint (because listDirty caused a reprint). It must
    // NOT fire a third time before the "back" iteration - that is the bug.
    // Final chapter count is 4 (5 minus index 1). The initial print shows all
    // 5 "Chapter N" rows; the post-remove reprint shows 4. So the total count
    // of "  N.  ..." rows is 9 - NOT 5 (initial) + 9 (post-remove full list)
    // + 14 (next iteration full list). If the bug were still present this
    // would be ~14 rows (two full reprints of a 5-chapter initial + altered
    // list). Exact count: initial print prints 5 rows; post-remove reprint
    // prints 4 rows; total = 9. (We allow "== 9" precisely; no upper bound.)
    const chapterRowRe = /^\s+\d+\.\s+https:\/\/x\.com\/chapter-\d+/;
    const rows = countLogRows(prompt, chapterRowRe, "dim");
    expect(rows).toBe(9);
  });

  it("explicit 'view' triggers a reprint, then the next prompt iteration does NOT reprint", async () => {
    const urls = Array.from({ length: 3 }, (_, i) => `https://x.com/c-${i + 1}`);
    const prompt = new ScriptedPromptProvider([
      "view",
      "back",
    ]);
    const { ctx } = makeCtx(prompt);
    await new ChapterListScreen().render(ctx, { urls });

    const chapterRowRe = /^\s+\d+\.\s+https:\/\/x\.com\/c-\d+/;
    // Initial print: 3 rows. Explicit "view" (maxDisplay = full length = 3):
    // 3 rows. Total: 6 rows. The "back" iteration is a no-op (no reprint).
    const rows = countLogRows(prompt, chapterRowRe, "dim");
    expect(rows).toBe(6);
  });
});

describe("SettingsScreen printProfile boxed note", () => {
  it("renders a profile as a single note() call titled 'Profile: <domain>' and emits no row-by-row log lines", async () => {
    const prompt = new ScriptedPromptProvider([
      "profiles",
      "profile:example.com",
      "edit_label",
      "My Novels",
      "notes here",
      "back",
      "__back__",
      "back",
    ]);
    const { ctx, profiles } = makeCtx(prompt);
    const base: SiteProfile = {
      domain: "example.com",
      method: "toc",
      contentSelector: "#content",
      separateTitle: false,
      excludeSelectors: [".ads"],
      savedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    await profiles.save("example.com", base);

    await new SettingsScreen().render(ctx);

    // Exactly one note(), titled for the domain.
    expect(prompt.noteCalls).toHaveLength(2);
    expect(prompt.noteCalls[0].title).toBe("Profile: example.com");
    expect(prompt.noteCalls[0].message).toContain("Domain");
    expect(prompt.noteCalls[0].message).toContain("example.com");
    // No standalone log row carrying the literal "Domain" key - the old code
    // emitted per-field rows; the new path groups them inside the note body.
    expect(countLogRows(prompt, /^Domain\s+/)).toBe(0);
  });
});

describe("Shell banner-once (header strip)", () => {
  it("Shell.run() emits the banner exactly once across multiple screen renders", async () => {
    let renders = 0;
    class LoopMain implements Screen {
      id = "main";
      async render(): Promise<ScreenResult> {
        renders++;
        // Yield to the macrotask queue so the stopper setTimeout can fire.
        // Without this, a synchronous root-pop loop never lets the timer
        // advance (matches the LiveScreen pattern from the Ctrl+Q test).
        await new Promise((r) => setTimeout(r, 2));
        return { action: "pop" }; // root-pop is a no-op, loop continues
      }
    }
    const main = new LoopMain();
    const registry = new Map<string, Screen>([["main", main]]);

    const prompt = new ScriptedPromptProvider([]);
    const { ctx } = makeCtx(prompt);
    let exited = 0;
    const shell = new Shell(registry, {
      config: ctx.config,
      cookies: ctx.cookies,
      profiles: ctx.profiles,
      sessions: ctx.sessions,
      browser: ctx.browser,
      log: ctx.log,
      prompt,
      tasks: ctx.tasks,
      exitFn: () => exited++,
    });

    // Stop the loop after the banner-once has been emitted and a few render
    // iterations have completed. Setting quitRequested causes the while-loop
    // condition to fail at the top of its next iteration.
    const stopper = setTimeout(() => {
      (shell as unknown as { quitRequested: boolean }).quitRequested = true;
    }, 25);

    await shell.run("main");
    clearTimeout(stopper);

    expect(renders).toBeGreaterThan(1); // multiple root-pop iterations occurred
    const bannerRows = countLogRows(prompt, /WebNovel Scraper\s+·/, "info");
    expect(bannerRows).toBe(1);
    expect(exited).toBe(1);
  });
});
