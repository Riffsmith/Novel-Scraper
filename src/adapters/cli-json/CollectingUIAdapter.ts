// ─────────────────────────────────────────────────────────────────────────────
//  CollectingUIAdapter - records ScrapeEvent[] for `wnscrape run --json`.
//
//  Phase 5 §2.3: this is a UIAdapter that records every emitted ScrapeEvent
//  into an array so the JSON envelope can include chapter count, errors,
//  durations, and the EPUB output path. No core change - thin adapter that
//  implements UIAdapter. The `NoopUIAdapter` stays the default for the
//  human-readable path.
// ─────────────────────────────────────────────────────────────────────────────

import type { UIAdapter, ScrapeEvent } from "../../ports/UIAdapter.js";

export class CollectingUIAdapter implements UIAdapter {
  readonly events: ScrapeEvent[] = [];

  emit(e: ScrapeEvent): void {
    this.events.push(e);
  }

  onProgress?(_cb: (done: number, total: number) => void): void {
    // not used by the engine today; collect-only adapter
  }
}
