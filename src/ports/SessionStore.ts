// ─────────────────────────────────────────────────────────────────────────────
//  SessionStore — persistent checkpoint storage for resumable scrapes.
//  One JSON file per session, read/written by the store-json adapter.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScrapeSession, SessionSummary } from "../core/domain/Session.js";

export interface SessionStore {
  save(s: ScrapeSession): Promise<void>;
  load(id: string): Promise<ScrapeSession | null>;
  list(): Promise<SessionSummary[]>;
  findByEntryUrl(url: string): Promise<ScrapeSession | null>;
  delete(id: string): Promise<boolean>;
}