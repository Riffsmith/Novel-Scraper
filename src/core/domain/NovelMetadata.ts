// ─────────────────────────────────────────────────────────────────────────────
//  NovelMetadata — EPUB-level metadata for a scrape job.
//  Ported VERBATIM from src/types.ts:95-104 (v1).
// ─────────────────────────────────────────────────────────────────────────────

export type CoverSource = "url" | "file" | "none";

export interface NovelMetadata {
  title: string;
  author: string;
  language: string; // ISO 639-1 e.g. "en"
  synopsis?: string;
  publisher?: string;
  coverSource: CoverSource;
  coverUrl?: string; // used when coverSource === 'url'
  coverPath?: string; // used when coverSource === 'file'
}
