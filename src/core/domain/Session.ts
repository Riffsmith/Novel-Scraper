// ─────────────────────────────────────────────────────────────────────────────
//  ScrapeSession — resumable checkpoint for an in-progress scrape.
//  Ported VERBATIM from src/types.ts:186-213 (v1) so v1 session files remain
//  readable by v2.
//
//  Design note (Phase 1): `config` references ScraperConfig which lives in
//  JobConfig.ts. The two are co-imported in the app root; no circular deps.
// ─────────────────────────────────────────────────────────────────────────────

import type { Chapter } from "./Chapter.js";
import type { ScraperConfig } from "./JobConfig.js";

export type SessionStatus = "in-progress";

export interface ScrapeSession {
  id: string;
  status: SessionStatus;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp

  domain: string;
  entryUrl: string; // exactly what user typed — the match key for "resume this?"
  novelTitle: string;

  config: ScraperConfig;
  chapterUrls: string[]; // full ordered list, 0-based == Chapter.index - 1

  completedChapters: import("./Chapter.js").Chapter[]; // full chapters, not just indices
  errors: import("./JobConfig.js").ScrapeError[]; // retryable failures
}

// Lightweight listing shape for the "resume a scrape" picker
export interface SessionSummary {
  id: string;
  novelTitle: string;
  domain: string;
  totalChapters: number;
  completedCount: number;
  updatedAt: string;
}