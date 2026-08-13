// ─────────────────────────────────────────────────────────────────────────────
//  ClackUIAdapter - ports/UIAdapter impl routing ScrapeEvents to the log
//  region (a one-line status above the shell's header strip, per
//  03-tui-design §3 / readme §2.7). Phase 3 emits no scrape events (no
//  scraping flow is reachable - ADR-P3-E), but the adapter is the seam
//  Phase 4's TaskScreen extends; it also gives the cookie-capture spinner
//  a clack-friendly home without bringing a scrape dependency in.
// ─────────────────────────────────────────────────────────────────────────────

import type { PromptProvider } from "./PromptProvider.js";
import type { UIAdapter, ScrapeEvent } from "../../ports/UIAdapter.js";

export class ClackUIAdapter implements UIAdapter {
  private progressCb: ((done: number, total: number) => void) | undefined;
  private eventCb: ((e: ScrapeEvent) => void) | undefined;

  constructor(private prompt: PromptProvider) {}

  /**
   * Optional per-event observer, honored in addition to the typed log lines
   * below. Phase 4's TaskScreen uses this to drive live task progress + the
   * per-event ack line below so the engine never talks to the shell directly.
   */
  onEvent(cb: (e: ScrapeEvent) => void): void {
    this.eventCb = cb;
  }

  emit(e: ScrapeEvent): void {
    // Forward to any live observer (TaskScreen's progress-bar wiring) BEFORE
    // the per-event log line so progress counts are coherent with the line.
    // Routine, high-frequency events (chapter.start, chapter.done,
    // chapter.retry, challenge.waiting, discovery.progress, checkpoint.saved)
    // are intentionally NOT logged as persistent clack lines here — they
    // drive the TaskScreen spinner in-place via `onEvent` instead of
    // scrolling the terminal. Only warnings, errors, and one-time
    // milestones are logged persistently; this keeps the scrape progress bar
    // fixed and the noise during the per-chapter wait/retry backoffs down to
    // a single "current chapter is being scraped" line that updates in place.
    if (this.eventCb) this.eventCb(e);
    switch (e.type) {
      case "discovery.started":
        this.prompt.log("info", `Discovery started: ${e.url}`);
        break;
      case "discovery.progress":
        break;
      case "discovery.done":
        this.prompt.log("success", `Discovered ${e.urls.length} chapter URLs`);
        break;
      case "chapter.start":
        // Transient status — drives the TaskScreen spinner, not a log line.
        break;
      case "chapter.done":
        if (this.progressCb) this.progressCb(e.index, -1);
        break;
      case "chapter.retry":
        // Transient status — drives the TaskScreen spinner, not a log line.
        break;
      case "chapter.failed":
        this.prompt.log("error", `Failed ch.${e.index}: ${e.url} - ${e.error}`);
        break;
      case "challenge.waiting":
        // Transient status — drives the TaskScreen spinner, not a log line.
        break;
      case "checkpoint.saved":
        break;
      case "epub.started":
        this.prompt.log("info", "EPUB packaging started");
        break;
      case "epub.done":
        this.prompt.log("success", `EPUB done: ${e.path}`);
        break;
    }
  }

  onProgress(cb: (done: number, total: number) => void): void {
    this.progressCb = cb;
  }
}
