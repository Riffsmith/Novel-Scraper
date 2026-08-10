// ─────────────────────────────────────────────────────────────────────────────
//  JsonSessionStore - v1-compatible session-file reader/writer (Phase 2).
//
//  Phase 1 version: plain writeFileSync, no schemaVersion stamp.
//  Phase 2 changes (phase-2 §1.4 fixes):
//    - ATOMIC WRITES via write-tmp-then-rename (atomicWrite.ts). v1 acknowledged
//      a half-written JSON file from a crash mid-save is possible and silently
//      dropped it - Phase 2 prevents the truncation rather than tolerating it.
//    - SCHEMAVERSION STAMP on next write. Reader treats absent as implicit v1
//      and never rewrites on read alone (migration-guide §5).
//    - shared path resolution now sourced from paths.ts (one duplication-delete,
//      phase-2 §1.1) instead of the verbatim v1 copy.
//
//  Preserved v1 behaviors:
//    - "Skip unreadable file" tolerance for `list()` (sessions/store.ts:79-100).
//    - Unknown config keys on save round-trip verbatim with a logged warning
//      (phase-1 D6 deviation - keeps side-by-side with v1 intact).
//    - Session file deleted only after EPUB build (asserted in Phase 1 tests).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

import type { SessionStore } from "../../ports/SessionStore.js";
import type { ScrapeSession, SessionSummary } from "../../core/domain/Session.js";
import type { Logger } from "../../ports/Logger.js";

import {
  sessionsDirPath,
} from "./paths.js";
import { atomicWrite } from "./atomicWrite.js";
import { runMigrations, sessionsMigrations } from "./migrations/index.js";
import { SESSION_STORE_SCHEMA_VERSION } from "../../adapters/schemas/session.js";

export class JsonSessionStore implements SessionStore {
  constructor(private log: Logger) {}

  async save(session: ScrapeSession): Promise<void> {
    // Migration-guard: warn when the session's config carries unknown keys.
    // Phase 1 D6 documented warn-but-preserve; we keep the same behavior
    // rather than refuse (v1's actual tolerance).
    const existing = this.loadSync(session.id);
    if (existing) {
      const unknown: string[] = [];
      const savedKeys = Object.keys(session.config as unknown as Record<string, unknown>);
      const oldKeys = Object.keys(existing.config as unknown as Record<string, unknown>);
      for (const key of savedKeys) if (!(key in existing.config)) unknown.push(key);
      for (const key of oldKeys)
        if (!(key in (session.config as unknown as Record<string, unknown>))) unknown.push(key);
      if (unknown.length > 0) {
        this.log.warn(
          `Session save contains unknown config keys: ${unknown.join(", ")} - preserving as-is`,
        );
      }
    }

    // Stamp schemaVersion on write (migration-guide §5 - stamped on next
    // write, not on read, so Phase 1 artifacts upgrade with zero risk
    // window). The constant is sourced from the session schema module so
    // the stamp always matches the migration chain's target version
    // (currently 3 - Phase 7 Scaffold bumped it for the additive `volumes`
    // field).
    const stamped: ScrapeSession & { schemaVersion?: number } = {
      ...session,
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    };

    await atomicWrite(this.sessionPath(session.id), JSON.stringify(stamped, null, 2));
  }

  loadSync(id: string): ScrapeSession | null {
    try {
      const raw = fs.readFileSync(this.sessionPath(id), "utf8");
      const parsed = JSON.parse(raw);
      // Reader tolerance: Phase 1 wrote v1-shape files without schemaVersion.
      // The migration chain walks absent -> v2 in-memory; the file is left
      // untouched on plain read.
      const { data } = runMigrations(parsed, sessionsMigrations, SESSION_STORE_SCHEMA_VERSION);
      return data as ScrapeSession;
    } catch {
      return null;
    }
  }

  async load(id: string): Promise<ScrapeSession | null> {
    return this.loadSync(id);
  }

  async list(): Promise<SessionSummary[]> {
    const dir = sessionsDirPath();
    let files: string[];
    try {
      fs.mkdirSync(dir, { recursive: true });
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const sessions: ScrapeSession[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const parsed = JSON.parse(raw);
        const { data } = runMigrations(parsed, sessionsMigrations, SESSION_STORE_SCHEMA_VERSION);
        const s = data as ScrapeSession;
        if (s.id && Array.isArray(s.chapterUrls)) {
          sessions.push(s);
        }
      } catch (e) {
        // v1's listSessions() quietly dropped unreadable files; Phase 2 keeps
        // that same tolerance (atomic write makes the bad-files case rarer).
        this.log.warn(`Skipping unreadable session file "${file}": ${(e as Error).message}`);
      }
    }

    return sessions
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((s) => ({
        id: s.id,
        novelTitle: s.novelTitle,
        domain: s.domain,
        totalChapters: s.chapterUrls.length,
        completedCount: s.completedChapters.length,
        updatedAt: s.updatedAt,
      }));
  }

  async findByEntryUrl(url: string): Promise<ScrapeSession | null> {
    const trimmed = url.trim();
    const summaries = await this.list();
    for (const summary of summaries) {
      const session = await this.load(summary.id);
      if (session?.entryUrl?.trim() === trimmed) return session;
    }
    return null;
  }

  async delete(id: string): Promise<boolean> {
    try {
      fs.unlinkSync(this.sessionPath(id));
      return true;
    } catch {
      return false;
    }
  }

  private sessionPath(id: string): string {
    return path.join(sessionsDirPath(), `${id}.json`);
  }
}
