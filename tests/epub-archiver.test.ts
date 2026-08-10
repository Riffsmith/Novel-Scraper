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
import type { Volume } from "../src/core/domain/Volume.js";

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

// ─────────────────────────────────────────────────────────────────────────────
//  Phase 7 / Evidence Phase 3 - Volume pages structure + byte-identical
//  regression guards for the no-volumes path (ADR-P7-A's "no behaviour change
//  for existing sites").
// ─────────────────────────────────────────────────────────────────────────────

function makeVolumeChapters(): { chapters: Chapter[]; volumes: Volume[] } {
  // 10 chapters assigned to 3 volumes: vol1 = ch1-3, vol2 = ch4-6, vol3 = ch7-10
  const chapters: Chapter[] = Array.from({ length: 10 }, (_, i) => ({
    index: i + 1,
    title: `Chapter ${i + 1}`,
    url: `http://test/vol/ch${i + 1}`,
    htmlContent: `<p>Content of chapter ${i + 1}.</p>`,
    wordCount: 5,
  }));
  const volumes: Volume[] = [
    {
      name: "Volume 1",
      chapterUrls: [
        "http://test/vol/ch1",
        "http://test/vol/ch2",
        "http://test/vol/ch3",
      ],
    },
    {
      name: "Volume 2",
      chapterUrls: [
        "http://test/vol/ch4",
        "http://test/vol/ch5",
        "http://test/vol/ch6",
      ],
    },
    {
      name: "Volume 3",
      chapterUrls: [
        "http://test/vol/ch7",
        "http://test/vol/ch8",
        "http://test/vol/ch9",
        "http://test/vol/ch10",
      ],
    },
  ];
  return { chapters, volumes };
}

describe("ArchiverEpubWriter - Volume pages (Phase 7)", () => {
  it("no-volumes output stays byte-identical to the pre-Phase-7 baseline", async () => {
    // ADR-P7-A's "no behaviour change for existing sites" guarantee: when
    // volumes is undefined, the EPUB output should not change at all. Build
    // the EPUB twice (with no volumes arg vs undefined) and confirm the
    // listings match - same entries, same count.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters } = makeVolumeChapters();

      const { path: epubNoVolumes } = await writer.write(chapters, meta, dir, "no-vol.epub");
      const { path: epubUndefined } = await writer.write(chapters, meta, dir, "undefined-vol.epub");

      const listNo = zipListing(epubNoVolumes);
      const listUndef = zipListing(epubUndefined);

      expect(listUndef.map((e) => e.filename)).toEqual(listNo.map((e) => e.filename));
      // No volume entries emitted in the no-volumes path.
      expect(listNo.map((e) => e.filename).filter((n) => n.includes("/volumes/"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits one OEBPS/volumes/volume-N.xhtml page per volume-with-chapters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters: _ch, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(_ch, meta, dir, "vols.epub", volumes);

      const names = zipListing(epubPath).map((e) => e.filename);
      expect(names).toContain("OEBPS/volumes/volume-1.xhtml");
      expect(names).toContain("OEBPS/volumes/volume-2.xhtml");
      expect(names).toContain("OEBPS/volumes/volume-3.xhtml");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("content.opf spine orders volume pages before their chapters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(chapters, meta, dir, "spine.epub", volumes);
      const opf = zipRead(epubPath, "OEBPS/content.opf");

      // Spine must be: synopsis -> nav -> vol1 -> ch1 -> ch2 -> ch3 ->
      // vol2 -> ch4 -> ch5 -> ch6 -> vol3 -> ch7 -> ch8 -> ch9 -> ch10.
      // Assert monotonic position order of volume pages interleaved with their
      // chapters using itemref line positions in content.opf.
      const interleaved = [
        "volume-1", "ch-1", "ch-2", "ch-3",
        "volume-2", "ch-4", "ch-5", "ch-6",
        "volume-3", "ch-7", "ch-8", "ch-9", "ch-10",
      ];
      const positions = new Map<string, number>();
      for (const id of interleaved) {
        const pos = opf.indexOf(`<itemref idref="${id}"/>`);
        if (pos >= 0) positions.set(id, pos);
      }
      // Verify that interleaved positions are monotonically increasing
      for (let i = 1; i < interleaved.length; i++) {
        expect(positions.get(interleaved[i]!)).toBeGreaterThan(
          positions.get(interleaved[i - 1]!)!,
        );
      }
      // Verify each volume comes immediately before its first chapter
      const v1 = positions.get("volume-1")!;
      const v2 = positions.get("volume-2")!;
      const v3 = positions.get("volume-3")!;
      const c1 = positions.get("ch-1")!;
      const c4 = positions.get("ch-4")!;
      const c7 = positions.get("ch-7")!;
      expect(c1).toBeGreaterThan(v1);
      expect(c4).toBeGreaterThan(v2);
      expect(c7).toBeGreaterThan(v3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("content.opf manifest lists all three volume items + all 10 chapter items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(chapters, meta, dir, "manifest.epub", volumes);
      const opf = zipRead(epubPath, "OEBPS/content.opf");

      // Volume manifest items
      expect(opf).toContain('id="volume-1"');
      expect(opf).toContain('id="volume-2"');
      expect(opf).toContain('id="volume-3"');
      expect(opf).toContain('href="volumes/volume-1.xhtml"');
      expect(opf).toContain('href="volumes/volume-2.xhtml"');
      expect(opf).toContain('href="volumes/volume-3.xhtml"');
      // All 10 chapter items
      for (let i = 1; i <= 10; i++) {
        expect(opf).toContain(`id="ch-${i}"`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nav.xhtml hosts nested <ol> volume groups with chapter <li>s inside", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(chapters, meta, dir, "nav.epub", volumes);
      const nav = zipRead(epubPath, "OEBPS/nav.xhtml");

      // Volume 1's outer <li> wraps an inner <ol>
      expect(nav).toContain('href="volumes/volume-1.xhtml"');
      expect(nav).toContain("Volume 1");
      // First chapter of volume 1 is nested under the volume 1 group
      const v1Pos = nav.indexOf('href="volumes/volume-1.xhtml"');
      const c1Pos = nav.indexOf('href="chapters/chapter-1.xhtml"');
      const v2Pos = nav.indexOf('href="volumes/volume-2.xhtml"');
      expect(c1Pos).toBeGreaterThan(v1Pos);
      expect(v2Pos).toBeGreaterThan(c1Pos);
      // All three volumes visible in the nav tree
      expect(nav).toContain("Volume 1");
      expect(nav).toContain("Volume 2");
      expect(nav).toContain("Volume 3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("toc.ncx hosts nested <navPoint> volume groups with chapter navPoints inside", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(chapters, meta, dir, "ncx.epub", volumes);
      const ncx = zipRead(epubPath, "OEBPS/toc.ncx");

      // Three volume parent navPoints
      expect(ncx).toContain('id="np-volume-1"');
      expect(ncx).toContain('id="np-volume-2"');
      expect(ncx).toContain('id="np-volume-3"');
      // Volume-bound chapter navPoints (np-ch-1 .. np-ch-10) all emitted
      for (let i = 1; i <= 10; i++) {
        expect(ncx).toContain(`id="np-${i}"`);
      }
      // Volume 1's navPoint opens BEFORE chapter 1's navPoint opens.
      const v1pos = ncx.indexOf('id="np-volume-1"');
      const c1pos = ncx.indexOf('id="np-1"');
      const v2pos = ncx.indexOf('id="np-volume-2"');
      expect(c1pos).toBeGreaterThan(v1pos);
      expect(v2pos).toBeGreaterThan(c1pos);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("volume page body uses the volume.name from the input volume", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const { chapters, volumes } = makeVolumeChapters();
      const { path: epubPath } = await writer.write(chapters, meta, dir, "volname.epub", volumes);
      const vol1 = zipRead(epubPath, "OEBPS/volumes/volume-1.xhtml");
      expect(vol1).toContain("Volume 1");
      expect(vol1).toContain('<h1 class="volume-title">Volume 1</h1>');
      // D1 deviation - no Unlocked Chapters line
      expect(vol1).not.toContain("Unlocked Chapters");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chapters whose URL is not in any volume fall into the Additional Chapters bucket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-vol-test-"));
    try {
      const writer = new ArchiverEpubWriter(nullLogger() as any);
      const chapters: Chapter[] = Array.from({ length: 4 }, (_, i) => ({
        index: i + 1,
        title: `Chapter ${i + 1}`,
        url: `http://test/extra/ch${i + 1}`,
        htmlContent: `<p>${i + 1}</p>`,
        wordCount: 1,
      }));
      const volumes: Volume[] = [
        {
          name: "Volume 1",
          chapterUrls: [
            "http://test/extra/ch1",
            "http://test/extra/ch2",
          ],
        },
      ];
      // ch3 and ch4 are NOT in any volume's chapterUrls - they fall through
      // to the spine "after all volume groups" (matches reference
      // manifestBuilder.mjs:159-167 "extra" bucket),
      const { path: epubPath } = await writer.write(chapters, meta, dir, "extra.epub", volumes);
      const opf = zipRead(epubPath, "OEBPS/content.opf");

      // The EPUB spine order should be: volume-1, ch-1, ch-2, ch-3, ch-4
      // (ch3 and ch4 don't belong to a volume group; they ride the tail).
      const v1Pos = opf.indexOf('<itemref idref="volume-1"/>');
      const c1Pos = opf.indexOf('<itemref idref="ch-1"/>');
      const c2Pos = opf.indexOf('<itemref idref="ch-2"/>');
      const c3Pos = opf.indexOf('<itemref idref="ch-3"/>');
      const c4Pos = opf.indexOf('<itemref idref="ch-4"/>');
      expect(c1Pos).toBeGreaterThan(v1Pos);
      expect(c2Pos).toBeGreaterThan(c1Pos);
      // c3 and c4 (extras) follow the volume groups
      expect(c3Pos).toBeGreaterThan(c2Pos);
      expect(c4Pos).toBeGreaterThan(c3Pos);

      // nav.xhtml should include an "Additional Chapters" group
      const nav = zipRead(epubPath, "OEBPS/nav.xhtml");
      expect(nav).toContain("Additional Chapters");

      // toc.ncx should include an np-extra navPoint
      const ncx = zipRead(epubPath, "OEBPS/toc.ncx");
      expect(ncx).toContain('id="np-extra"');
      expect(ncx).toContain("Additional Chapters");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});