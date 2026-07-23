import type { Page } from 'playwright';
import type { WaitUntil } from '../types.js';

// ── Metadata scraped automatically from a novel's landing page ────────────
export interface AutoNovelMetadata {
  title:       string;
  author:      string;
  description: string;
  coverUrl?:   string;
}

// ── Full result of an auto-scrape probe (metadata + chapter URLs) ─────────
export interface AutoScrapeResult {
  siteId:       string;
  novelUrl:     string;
  metadata:     AutoNovelMetadata;
  chapterLinks: string[];
}

// ─────────────────────────────────────────────────────────────────────────
//  SiteAdapter — one of these per supported site. Add new sites by
//  implementing this interface and registering it in sites/index.ts.
// ─────────────────────────────────────────────────────────────────────────
export interface SiteAdapter {
  id:    string;   // stable machine key, e.g. 'wtr-lab'
  label: string;   // human-friendly name shown in the TUI

  /** Does this adapter know how to handle the given entry URL? */
  matches(url: string): boolean;

  /** Build the table-of-contents URL for a given novel URL. */
  getTocUrl(novelUrl: string): string;

  /** Scrape novel-level metadata (title, author, description, cover). */
  scrapeMetadata(page: Page, novelUrl: string): Promise<AutoNovelMetadata>;

  /** Scrape every chapter URL, returned in correct reading order. */
  scrapeChapterLinks(
    page: Page,
    novelUrl: string,
    opts: { waitUntil: WaitUntil; navTimeoutMs: number },
  ): Promise<string[]>;

  // ── Defaults pre-filled into the auto-scrape review screen ─────────────
  // (the user can always override these before the scrape starts)
  defaultContentSelector:  string;
  defaultTitleSelector?:   string;
  defaultSeparateTitle:    boolean;
  defaultExcludeSelectors: string[];
}
