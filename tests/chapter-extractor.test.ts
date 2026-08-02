// ─────────────────────────────────────────────────────────────────────────────
//  T2 — ChapterExtractor sanitisation + ruby preservation + hidden removal.
//  Uses FakeBrowserPort with fixture HTML.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ChapterExtractor } from "../src/core/services/ChapterExtractor.js";
import { FakeBrowserPort, FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const htmlBasic = fs.readFileSync(
  path.join(__dirname, "fixtures", "chapter-basic.html"),
  "utf8",
);

function testLogger() {
  const messages: string[] = [];
  return {
    messages,
    log: {
      debug: (msg: string) => messages.push(`[debug] ${msg}`),
      info: () => {},
      warn: (msg: string) => messages.push(`[warn] ${msg}`),
      error: (msg: string) => messages.push(`[error] ${msg}`),
    },
  };
}

describe("ChapterExtractor — basic chapter", () => {
  it("extracts title from separate selector", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [".ad", ".nav", ".comments"],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).not.toBeNull();
    expect(chapter!.title).toBe("Chapter 1: The Beginning");
    expect(chapter!.index).toBe(1);
    expect(chapter!.htmlContent).toContain("Once upon a time");
    expect(chapter!.wordCount).toBeGreaterThan(0);
  });

  it("removes hidden and aria-hidden nodes", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter!.htmlContent).not.toContain("aria-hidden");
    expect(chapter!.htmlContent).not.toContain("This should also be gone");
    expect(chapter!.htmlContent).not.toContain("This too is hidden");
  });

  it("preserves <ruby> tags (CJK support)", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter!.htmlContent).toContain("<ruby>");
    expect(chapter!.htmlContent).toContain("<rt>");
  });

  it("collapses empty <p> tags", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      titleSelector: "h1.chapter-title",
      separateTitle: true,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter!.htmlContent).not.toMatch(/<p[^>]*>\s*<\/p>/);
  });

  it("caps <br> runs at 2", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      separateTitle: false,
      excludeSelectors: [".ad", ".nav", ".comments"],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    // Should have at most 2 <br/> in a row
    expect(chapter!.htmlContent).not.toMatch(/<br\/><br\/><br\/>/);
  });

  it("falls back to page <title> when selector misses", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(htmlBasic);

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".chapter-body",
      separateTitle: false, // no titleSelector used
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter!.title).toBe("Chapter 1: The Beginning");
  });

  it("returns null when content selector matches nothing", async () => {
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage("<body><p>stuff</p></body>");

    const chapter = await extractor.extract(page, "http://test/ch1", 1, {
      contentSelector: ".does-not-exist",
      separateTitle: false,
      excludeSelectors: [],
      delayMin: 0,
      delayMax: 0,
      waitUntil: "domcontentloaded",
      navTimeoutMs: 30_000,
    });

    expect(chapter).toBeNull();
  });
});

describe("ChapterExtractor — challenge detection", () => {
  it("detects CF challenge via DOM marker", async () => {
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "chapter-challenge.html"),
      "utf8",
    );
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(html);

    const result = await extractor.detectChallenge(page);
    expect(result.matched).toBe(true);
  });

  it("detects challenge via title regex", async () => {
    const html = `<html><head><title>Just a moment...</title></head><body><p>Checking...</p></body></html>`;
    const { log } = testLogger();
    const extractor = new ChapterExtractor(log);
    const page = new FakePage(html);

    const result = await extractor.detectChallenge(page);
    expect(result.matched).toBe(true);
  });
});