// ─────────────────────────────────────────────────────────────────────────────
//  ArchiverEpubWriter — EpubWriter using archiver (moved from src/epub/builder.ts).
//  Three deliberate changes:
//    1. No ora spinner import — progress goes through UIAdapter.
//    2. Import Chapter/NovelMetadata from core/domain instead of src/types.ts.
//    3. Wrapped as EpubWriter port implementation.
// ─────────────────────────────────────────────────────────────────────────────

import archiver from "archiver";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";

import type { Chapter } from "../../core/domain/Chapter.js";
import type { NovelMetadata } from "../../core/domain/NovelMetadata.js";

import * as T from "./templates.js";
import { foglihtenFontBuffer } from "./assets.js";
import type { Logger } from "../../ports/Logger.js";
import type { EpubWriter } from "../../ports/EpubWriter.js";

let got: (typeof import("got"))["got"] | null = null;
async function lazyGot() {
  if (!got) {
    const mod = await import("got");
    got = mod.got;
  }
  return got!;
}

const FONT_SOURCES: Record<string, () => Buffer> = {
  "FoglihtenNo07_Subset_Deep.ttf": foglihtenFontBuffer,
};

export class ArchiverEpubWriter implements EpubWriter {
  constructor(private log: Logger) {}

  async write(
    chapters: Chapter[],
    meta: NovelMetadata,
    outputDir: string,
    filename: string,
  ): Promise<{ path: string }> {
    fs.mkdirSync(outputDir, { recursive: true });

    const outFilename = filename.endsWith(".epub") ? filename : `${filename}.epub`;
    const outputPath = path.resolve(outputDir, outFilename);
    const bookId = `urn:uuid:${uuid()}`;

    let coverBuf: Buffer | null = null;

    if (meta.coverSource === "url" && meta.coverUrl) {
      try {
        const g = await lazyGot();
        const response = await g(meta.coverUrl, {
          responseType: "buffer",
          timeout: { request: 20_000 },
        });
        coverBuf = Buffer.from(response.body as Buffer);
        this.log.info("Cover downloaded", {
          url: meta.coverUrl,
          bytes: coverBuf.byteLength,
        });
      } catch (e) {
        this.log.warn(
          `Cover download failed: ${(e as Error).message} – proceeding without cover`,
        );
      }
    } else if (meta.coverSource === "file" && meta.coverPath) {
      try {
        coverBuf = fs.readFileSync(meta.coverPath);
        this.log.info("Cover loaded from file", {
          path: meta.coverPath,
          bytes: coverBuf.byteLength,
        });
      } catch (e) {
        this.log.warn(
          `Cover file read failed: ${(e as Error).message} – proceeding without cover`,
        );
      }
    }

    const hasCover = coverBuf !== null;
    const writeStream = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(writeStream);

    archive.append(T.MIMETYPE, {
      name: "mimetype",
      store: true,
    } as Parameters<typeof archive.append>[1]);

    archive.append(T.containerXml(), { name: "META-INF/container.xml" });
    archive.append(T.contentOpf(meta, chapters, hasCover, bookId), {
      name: "OEBPS/content.opf",
    });
    archive.append(T.navXhtml(meta, chapters, hasCover), {
      name: "OEBPS/nav.xhtml",
    });
    archive.append(T.tocNcx(meta, chapters, bookId, hasCover), {
      name: "OEBPS/toc.ncx",
    });
    archive.append(T.stylesheet(), { name: "OEBPS/styles/style.css" });

    for (const font of T.EMBEDDED_FONTS) {
      const getBuf = FONT_SOURCES[font.filename];
      if (!getBuf) {
        this.log.warn(`No font source registered for "${font.filename}" — skipping embed`);
        continue;
      }
      archive.append(getBuf(), { name: `OEBPS/fonts/${font.filename}` });
    }

    archive.append(T.synopsisXhtml(meta), { name: "OEBPS/synopsis.xhtml" });

    if (hasCover && coverBuf) {
      archive.append(coverBuf, { name: "OEBPS/images/cover.jpg" });
      archive.append(T.coverXhtml(meta), { name: "OEBPS/cover.xhtml" });
    }

    for (const ch of chapters) {
      archive.append(T.chapterXhtml(ch, meta), {
        name: `OEBPS/chapters/chapter-${ch.index}.xhtml`,
      });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on("close", resolve);
      writeStream.on("error", reject);
      archive.on("error", reject);
      archive.finalize();
    });

    const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
    this.log.info("EPUB built", {
      path: outputPath,
      sizeKb,
      chapters: chapters.length,
      hasCover,
    });

    return { path: outputPath };
  }
}