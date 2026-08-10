// ─────────────────────────────────────────────────────────────────────────────
//  EpubWriter — produces a standards-compliant EPUB 3 archive.
//  The core engine calls this once when the queue finishes.
// ─────────────────────────────────────────────────────────────────────────────

import type { Chapter } from "../core/domain/Chapter.js";
import type { NovelMetadata } from "../core/domain/NovelMetadata.js";
import type { Volume } from "../core/domain/Volume.js";

export interface EpubWriter {
  write(
    chapters: Chapter[],
    meta: NovelMetadata,
    destDir: string,
    filename: string,
    volumes?: Volume[],
  ): Promise<{ path: string }>;
}