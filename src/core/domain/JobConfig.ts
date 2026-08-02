// ─────────────────────────────────────────────────────────────────────────────
//  JobConfig — file-loadable scrape-config shape (superset of ScraperConfig).
//
//  Ported from src/types.ts:106-173 with these deliberate additions per §2.1:
//    • jobId?, cookiesFile?, resumeFromSessionId?, output.epub
//  ScrapeError & ScrapeResult are co-located because they travel with a job.
// ─────────────────────────────────────────────────────────────────────────────

import type { Chapter } from "./Chapter.js";
import type { NovelMetadata } from "./NovelMetadata.js";
import type { NextLocator } from "./Locator.js";

export type ScrapeMethod = "toc" | "sequential";

// ── ScraperConfig — assembly-time shape (verbatim from v1 types.ts:107-141)
export interface ScraperConfig {
  method: ScrapeMethod;

  tocUrl?: string;
  chapterLinks?: string[];

  firstChapterUrl?: string;
  lastChapterUrl?: string;
  nextButtonLocators?: NextLocator[];

  contentSelector: string;
  separateTitle: boolean;
  titleSelector?: string;
  excludeSelectors: string[];

  metadata: NovelMetadata;

  outputDir: string;
  outputFilename: string;

  concurrency: number;
  delayMin: number;
  delayMax: number;
  headless: boolean;
}

// ── Superset loaded from a YAML job file ──────────────────────────────────
export interface JobConfig extends ScraperConfig {
  jobId?: string;
  cookiesFile?: string; // path to a v1-format cookie JSON snippet
  resumeFromSessionId?: string; // if set, skip discovery and load chapters from session

  output: {
    epub: boolean;
  };
}

// ── Error record ───────────────────────────────────────────────────────────
export interface ScrapeError {
  url: string;
  error: string;
  retries: number;
}

// ── Overall scrape result ─────────────────────────────────────────────────
export interface ScrapeResult {
  chapters: Chapter[];
  errors: ScrapeError[];
  totalWords: number;
  scrapeMs: number;
}