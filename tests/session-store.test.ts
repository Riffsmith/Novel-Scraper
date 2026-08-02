// ─────────────────────────────────────────────────────────────────────────────
//  T7 (subset) — JsonSessionStore round-trip and v1 compatibility.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";
import type { ScrapeSession } from "../src/core/domain/Session.js";

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe("JsonSessionStore — round-trip", () => {
  let dataDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-store-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes and reads a session by id", async () => {
    const store = new JsonSessionStore(nullLogger() as any);
    const session: ScrapeSession = {
      id: "test-1",
      status: "in-progress",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      domain: "test.example",
      entryUrl: "http://test.example/toc",
      novelTitle: "Test Novel",
      config: {
        method: "toc",
        tocUrl: "http://test.example/toc",
        contentSelector: ".c",
        separateTitle: false,
        excludeSelectors: [],
        metadata: { title: "Test Novel", author: "Author", language: "en", coverSource: "none" },
        outputDir: "./output",
        outputFilename: "test",
        concurrency: 1,
        delayMin: 100,
        delayMax: 300,
        headless: true,
      },
      chapterUrls: ["http://test.example/c1", "http://test.example/c2"],
      completedChapters: [],
      errors: [],
    };

    await store.save(session);
    const loaded = await store.load("test-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-1");
    expect(loaded!.chapterUrls).toHaveLength(2);
  });

  it("list returns a summary per session sorted by updatedAt desc", async () => {
    const store = new JsonSessionStore(nullLogger() as any);
    const mkSession = (id: string, updatedAt: string, completed: number): ScrapeSession => ({
      id,
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
      domain: "test.example",
      entryUrl: `http://test.example/${id}`,
      novelTitle: `Novel ${id}`,
      config: {
        method: "toc",
        tocUrl: "http://test.example/toc",
        contentSelector: ".c",
        separateTitle: false,
        excludeSelectors: [],
        metadata: { title: "x", author: "y", language: "en", coverSource: "none" },
        outputDir: "./output",
        outputFilename: "x",
        concurrency: 1,
        delayMin: 1,
        delayMax: 2,
        headless: true,
      },
      chapterUrls: ["u1", "u2", "u3"],
      completedChapters: Array.from({ length: completed }, (_, i) => ({
        index: i + 1,
        title: `c${i + 1}`,
        url: `u${i + 1}`,
        htmlContent: "<p>x</p>",
        wordCount: 1,
      })),
      errors: [],
    });

    await store.save(mkSession("a", "2026-01-01T00:00:00.000Z", 1));
    await store.save(mkSession("b", "2026-02-01T00:00:00.000Z", 2));
    await store.save(mkSession("c", "2026-01-15T00:00:00.000Z", 3));

    const summaries = await store.list();
    expect(summaries.map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(summaries.find((s) => s.id === "b")!.completedCount).toBe(2);
    expect(summaries.find((s) => s.id === "c")!.completedCount).toBe(3);
  });

  it("findByEntryUrl matches on exact entryUrl", async () => {
    const store = new JsonSessionStore(nullLogger() as any);
    const session: ScrapeSession = {
      id: "urlmatch",
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      domain: "example.com",
      entryUrl: "http://example.com/specific-toc",
      novelTitle: "X",
      config: {
        method: "toc",
        tocUrl: "http://example.com/specific-toc",
        contentSelector: ".c",
        separateTitle: false,
        excludeSelectors: [],
        metadata: { title: "X", author: "Y", language: "en", coverSource: "none" },
        outputDir: "./output",
        outputFilename: "x",
        concurrency: 1,
        delayMin: 1,
        delayMax: 2,
        headless: true,
      },
      chapterUrls: [],
      completedChapters: [],
      errors: [],
    };

    await store.save(session);
    const found = await store.findByEntryUrl("http://example.com/specific-toc");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("urlmatch");

    const notFound = await store.findByEntryUrl("http://example.com/other");
    expect(notFound).toBeNull();
  });

  it("delete removes the session file", async () => {
    const store = new JsonSessionStore(nullLogger() as any);
    const session: ScrapeSession = {
      id: "del-me",
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      domain: "x",
      entryUrl: "http://x/x",
      novelTitle: "X",
      config: {
        method: "toc",
        tocUrl: "http://x/x",
        contentSelector: ".c",
        separateTitle: false,
        excludeSelectors: [],
        metadata: { title: "X", author: "Y", language: "en", coverSource: "none" },
        outputDir: "./output",
        outputFilename: "x",
        concurrency: 1,
        delayMin: 1,
        delayMax: 2,
        headless: true,
      },
      chapterUrls: [],
      completedChapters: [],
      errors: [],
    };

    await store.save(session);
    expect(await store.load("del-me")).not.toBeNull();
    const ok = await store.delete("del-me");
    expect(ok).toBe(true);
    expect(await store.load("del-me")).toBeNull();
  });

  it("skips unreadable session files in list()", async () => {
    const store = new JsonSessionStore(nullLogger() as any);
    const sessionsDir = path.join(dataDir, "webnovel-scraper", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "bad.json"), "{not valid json");
    fs.writeFileSync(
      path.join(sessionsDir, "good.json"),
      JSON.stringify({
        id: "good",
        status: "in-progress",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        domain: "g",
        entryUrl: "http://g/g",
        novelTitle: "G",
        config: {
          method: "toc",
          tocUrl: "http://g/g",
          contentSelector: ".c",
          separateTitle: false,
          excludeSelectors: [],
          metadata: { title: "G", author: "Y", language: "en", coverSource: "none" },
          outputDir: "./output",
          outputFilename: "g",
          concurrency: 1,
          delayMin: 1,
          delayMax: 2,
          headless: true,
        },
        chapterUrls: ["u1"],
        completedChapters: [],
        errors: [],
      }),
    );

    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe("good");
  });
});