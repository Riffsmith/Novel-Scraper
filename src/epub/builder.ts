import archiver     from 'archiver';
import fs           from 'fs';
import path         from 'path';
import { v4 as uuid } from 'uuid';
import type { Chapter, NovelMetadata } from '../types.js';
import * as T       from './templates.js';
import logger       from '../logger/index.js';
import { spinner }  from '../tui/display.js';

// got v14 is ESM only
let got: (typeof import('got'))['got'] | null = null;
async function lazyGot() {
  if (!got) {
    const mod = await import('got');
    got = mod.got;
  }
  return got!;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Build a standards-compliant EPUB 3 file.
//
//  Structure:
//    mimetype                          (uncompressed, EPUB spec §3.3)
//    META-INF/container.xml
//    OEBPS/content.opf                 (package document)
//    OEBPS/nav.xhtml                   (EPUB 3 navigation)
//    OEBPS/toc.ncx                     (EPUB 2 backward compat)
//    OEBPS/styles/style.css
//    OEBPS/title.xhtml
//    OEBPS/cover.xhtml                 (if cover present)
//    OEBPS/images/cover.jpg            (if cover present)
//    OEBPS/chapters/chapter-N.xhtml   (one per chapter)
// ═══════════════════════════════════════════════════════════════════════════
export async function buildEpub(
  chapters   : Chapter[],
  meta       : NovelMetadata,
  outputDir  : string,
  filename   : string,
): Promise<string> {
  const spin = spinner('Assembling EPUB…');

  // ── Ensure output directory ─────────────────────────────────────────────
  fs.mkdirSync(outputDir, { recursive: true });

  const outFilename = filename.endsWith('.epub') ? filename : `${filename}.epub`;
  const outputPath  = path.resolve(outputDir, outFilename);
  const bookId      = `urn:uuid:${uuid()}`;

  // ── Cover resolution ────────────────────────────────────────────────────
  let coverBuf: Buffer | null = null;

  if (meta.coverSource === 'url' && meta.coverUrl) {
    spin.text = 'Downloading cover image…';
    try {
      const g        = await lazyGot();
      const response = await g(meta.coverUrl, { responseType: 'buffer', timeout: { request: 20_000 } });
      coverBuf       = Buffer.from(response.body as Buffer);
      logger.info('Cover downloaded', { url: meta.coverUrl, bytes: coverBuf.byteLength });
    } catch (e) {
      logger.warn(`Cover download failed: ${(e as Error).message} – proceeding without cover`);
    }

  } else if (meta.coverSource === 'file' && meta.coverPath) {
    try {
      coverBuf = fs.readFileSync(meta.coverPath);
      logger.info('Cover loaded from file', { path: meta.coverPath, bytes: coverBuf.byteLength });
    } catch (e) {
      logger.warn(`Cover file read failed: ${(e as Error).message} – proceeding without cover`);
    }
  }

  const hasCover = coverBuf !== null;

  // ── Open archive ────────────────────────────────────────────────────────
  spin.text = `Packaging ${chapters.length} chapter(s)…`;

  const writeStream = fs.createWriteStream(outputPath);
  const archive     = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(writeStream);

  // EPUB spec §3.3: mimetype MUST be first entry and SHOULD be uncompressed.
  // archiver's `store: true` option disables compression for this entry.
  archive.append(T.MIMETYPE, { name: 'mimetype', store: true } as Parameters<typeof archive.append>[1]);

  // META-INF
  archive.append(T.containerXml(), { name: 'META-INF/container.xml' });

  // Package document
  archive.append(T.contentOpf(meta, chapters, hasCover, bookId), { name: 'OEBPS/content.opf' });

  // Navigation
  archive.append(T.navXhtml(meta, chapters),           { name: 'OEBPS/nav.xhtml' });
  archive.append(T.tocNcx(meta, chapters, bookId),     { name: 'OEBPS/toc.ncx' });

  // Stylesheet
  archive.append(T.stylesheet(),                        { name: 'OEBPS/styles/style.css' });

  // Title page
  archive.append(T.titleXhtml(meta),                   { name: 'OEBPS/title.xhtml' });

  // Cover
  if (hasCover && coverBuf) {
    archive.append(coverBuf,                             { name: 'OEBPS/images/cover.jpg' });
    archive.append(T.coverXhtml(meta),                  { name: 'OEBPS/cover.xhtml' });
  }

  // Chapters
  for (const ch of chapters) {
    archive.append(T.chapterXhtml(ch, meta), {
      name: `OEBPS/chapters/chapter-${ch.index}.xhtml`,
    });
  }

  // ── Finalise ─────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    writeStream.on('close', resolve);
    writeStream.on('error', reject);
    archive.on('error', reject);
    archive.finalize();
  });

  const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
  spin.succeed(`EPUB ready — ${outputPath}  (${sizeKb.toLocaleString()} KB)`);
  logger.info('EPUB built', { path: outputPath, sizeKb, chapters: chapters.length, hasCover });

  return outputPath;
}
