// ─────────────────────────────────────────────────────────────────────────────
//  UIAdapter — event sink for scrape progress.
//  Core services never import chalk/ora/cli-progress; they emit typed events.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScrapeEvent } from "../core/services/events.js";

export interface UIAdapter {
  emit(e: ScrapeEvent): void;
  onProgress?(cb: (done: number, total: number) => void): void;
}

export type { ScrapeEvent };