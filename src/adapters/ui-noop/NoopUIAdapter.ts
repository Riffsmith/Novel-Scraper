// ─────────────────────────────────────────────────────────────────────────────
//  NoopUIAdapter — default event sink that swallows all events.
//  CLI --json later wraps this (Phase 5), recording events for JSON output.
// ─────────────────────────────────────────────────────────────────────────────

import type { UIAdapter, ScrapeEvent } from "../../ports/UIAdapter.js";

export class NoopUIAdapter implements UIAdapter {
  emit(_e: ScrapeEvent): void {}
  onProgress?(_cb: (done: number, total: number) => void): void {}
}