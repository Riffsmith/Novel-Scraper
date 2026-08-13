// ─────────────────────────────────────────────────────────────────────────────
//  ScrapeEvent — tagged union of every event the ScrapeService emits through
//  UIAdapter so the TUI/CLI subscriber can render progress, not the engine.
// ─────────────────────────────────────────────────────────────────────────────

export type ScrapeEvent =
  | { type: "discovery.started"; url: string }
  | { type: "discovery.progress"; found: number; pages: number }
  | { type: "discovery.done"; urls: string[] }
  | { type: "chapter.start"; index: number; url: string }
  | { type: "chapter.done"; index: number; title: string; words: number }
  | {
      type: "chapter.retry";
      index: number;
      attempt: number;
      max: number;
      challenge: boolean;
      backoffMs: number;
    }
  | { type: "chapter.failed"; index: number; url: string; error: string }
  | { type: "challenge.waiting"; url: string }
  | { type: "checkpoint.saved"; sessionId: string; done: number }
  | { type: "epub.started" }
  | { type: "epub.done"; path: string };