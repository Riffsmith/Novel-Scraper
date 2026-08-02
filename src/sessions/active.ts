// ─────────────────────────────────────────────────────────────────────────────
//  Tracks the checkpoint-save function for whichever scrape session is
//  currently in flight, so a SIGINT/SIGTERM/uncaught exception (or a
//  Ctrl+Q/Ctrl+C pressed mid-prompt — see tui/keys.ts) can persist one last
//  checkpoint before the process exits, no matter which of those was the
//  actual trigger.
//
//  Mirrors the module-level singleton pattern already used for the browser
//  instance in scraper/browser.ts (`_browser`) — a plain in-memory
//  registration, not a queue or anything fancier, because only one scrape
//  is ever running at a time in this app.
// ─────────────────────────────────────────────────────────────────────────────

let activeSave: (() => void) | null = null;

export function registerActiveSession(save: () => void): void {
  activeSave = save;
}

export function clearActiveSession(): void {
  activeSave = null;
}

// Best-effort — checkpoint persistence must never be the reason a shutdown
// hangs or throws.
export function flushActiveSession(): void {
  try {
    activeSave?.();
  } catch {
    /* ignore — we're already on our way out */
  }
}
