// ─────────────────────────────────────────────────────────────────────────────
//  T8 — EPUB structural regression: byte-compare structure against expected.
//  Verifies mimetype stored-first, OPF, nav, NCX, fonts, synopsis, chapters.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

import { ArchiverEpubWriter } from "../src/adapters/epub-archiver/ArchiverEpubWriter.js";
import type { Chapter } from "../src/core/domain/Chapter.js";
import type { NovelMetadata } from "../src/core/domain/NovelMetadata.js";

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeChapters(n: number): Chapter[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    title: `Chapter ${i + 1}`,
    url: `http://test/ch${i + 1}`,
    htmlContent: `<p>Content of chapter ${i + 1}.</p>`,
    wordCount: 5,
  }));
}

const meta: NovelMetadata = {
  title: "Test Novel",
  author: "Test Author",
  language: "en",
  coverSource: "none",
  publisher: "Test Publisher",
};

interface Infolist {
  filename: string;
  compress_type: number; // 0=stored, 8=deflated
}

function zipListing(epubPath: string): Infolist[] {
  const py = `
import zipfile, json
with zipfile.ZipFile(${JSON.stringify(epubPath)}, "r") as z:
    print(json.dumps([
        {"filename": i.filename, "compress_type": i.compress_type}
        for i in z.infolist()
    ]))
`;
  const out = execFileSync("python3", ["-c", py], { encoding: "utf8" });
  return JSON.parse(out) as Infolist[];
}

function zipRead(epubPath: string, name: string): string {
  const py = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(epubPath)}, "r") as z:
    print(z.read(${JSON.stringify(name)}).decode("utf-8"))
`;
  return execFileSync("python3", ["-c", py], { encoding: "utf8" });
}

describe("ArchiverEpubWriter — EPUB 3 structure (T8)", () => {
  it("places mimetype first and stores it uncompressed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { path: epubPath } = await writer.write(makeChapters(5), meta, dir, "test.epub");

      expect(fs.existsSync(epubPath)).toBe(true);

      const entries = zipListing(epubPath);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].filename).toBe("mimetype");
      expect(entries[0].compress_type).toBe(0); // 0 = ZIP_STORED
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes OPF, nav, NCX, stylesheet, synopsis, chapter files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { path: epubPath } = await writer.write(makeChapters(3), meta, dir, "test.epub");

      const names = zipListing(epubPath).map((e) => e.filename);
      const required = [
        "mimetype",
        "META-INF/container.xml",
        "OEBPS/content.opf",
        "OEBPS/nav.xhtml",
        "OEBPS/toc.ncx",
        "OEBPS/styles/style.css",
        "OEBPS/synopsis.xhtml",
        "OEBPS/chapters/chapter-1.xhtml",
        "OEBPS/chapters/chapter-2.xhtml",
        "OEBPS/chapters/chapter-3.xhtml",
      ];
      for (const p of required) {
        expect(names).toContain(p);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits cover.xhtml when no cover", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { path: epubPath } = await writer.write(makeChapters(2), meta, dir, "test.epub");

      const names = zipListing(epubPath).map((e) => e.filename);
      expect(names).not.toContain("OEBPS/cover.xhtml");
      expect(names).not.toContain("OEBPS/images/cover.jpg");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chapter order in OPF follows chapter.index input order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      // Pre-sorted (queue ensures this in ScrapeService)
      const chapters = [
        { index: 1, title: "Chapter 1", url: "u1", htmlContent: "<p>1</p>", wordCount: 1 },
        { index: 3, title: "Chapter 3", url: "u3", htmlContent: "<p>3</p>", wordCount: 1 },
        { index: 5, title: "Chapter 5", url: "u5", htmlContent: "<p>5</p>", wordCount: 1 },
      ];
      const { path: epubPath } = await writer.write(chapters, meta, dir, "test.epub");
      const contentOpf = zipRead(epubPath, "OEBPS/content.opf");
      const idx1 = contentOpf.indexOf("chapter-1.xhtml");
      const idx3 = contentOpf.indexOf("chapter-3.xhtml");
      const idx5 = contentOpf.indexOf("chapter-5.xhtml");
      expect(idx1).toBeLessThan(idx3);
      expect(idx3).toBeLessThan(idx5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});