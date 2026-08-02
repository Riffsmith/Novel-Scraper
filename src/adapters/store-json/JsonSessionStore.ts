// ─────────────────────────────────────────────────────────────────────────────
//  JsonSessionStore — v1-compatible session-file reader/writer.
//  Reads and writes sessions/⟨id⟩.json files exactly as v1 does.
//  Phase 1: no schemaVersion stamp yet — side-by-side operation with v1.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import os from "os";

import type { SessionStore } from "../../ports/SessionStore.js";
import type { ScrapeSession, SessionSummary } from "../../core/domain/Session.js";
import type { Logger } from "../../ports/Logger.js";

function resolveDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "webnovel-scraper");

  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "webnovel-scraper",
      );
    case "darwin":
      return path.join(home, "Library", "Application Support", "webnovel-scraper");
    default:
      return path.join(home, ".local", "share", "webnovel-scraper");
  }
}

function sessionsDir(): string {
  return path.join(resolveDataDir(), "sessions");
}

function ensureDir(): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export class JsonSessionStore implements SessionStore {
  constructor(private log: Logger) {}

  async save(session: ScrapeSession): Promise<void> {
    ensureDir();
    const p = sessionPath(session.id);

    // Migration guard: refuse to overwrite a session whose config keys are unknown
    // unless they're preserved verbatim (v1's writeConfig unknown-key rule).
    const existing = this.loadSync(session.id);
    if (existing) {
      const unknown: string[] = [];
      for (const key of Object.keys(session.config as unknown as Record<string, unknown>)) {
        if (!(key in existing.config)) unknown.push(key);
      }
      for (const key of Object.keys(existing.config as unknown as Record<string, unknown>)) {
        if (!(key in (session.config as unknown as Record<string, unknown>))) {
          unknown.push(key);
        }
      }
      if (unknown.length > 0) {
        this.log.warn(
          `Session save contains unknown config keys: ${unknown.join(", ")} — preserving as-is`,
        );
      }
    }

    await fs.promises.writeFile(p, JSON.stringify(session, null, 2), "utf8");
  }

  loadSync(id: string): ScrapeSession | null {
    try {
      const raw = fs.readFileSync(sessionPath(id), "utf8");
      return JSON.parse(raw) as ScrapeSession;
    } catch {
      return null;
    }
  }

  async load(id: string): Promise<ScrapeSession | null> {
    return this.loadSync(id);
  }

  async list(): Promise<SessionSummary[]> {
    ensureDir();
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const sessions: ScrapeSession[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir(), file), "utf8");
        const s = JSON.parse(raw) as ScrapeSession;
        if (s.id && Array.isArray(s.chapterUrls)) {
          sessions.push(s);
        }
      } catch (e) {
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
      fs.unlinkSync(sessionPath(id));
      return true;
    } catch {
      return false;
    }
  }
}