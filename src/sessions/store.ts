// ─────────────────────────────────────────────────────────────────────────────
//  Resumable-scrape session store
//
//  Directory: $XDG_DATA_HOME/webnovel-scraper/sessions/
//  One file per session: sessions/<id>.json  (see ScrapeSession in types.ts)
//
//  Mirrors the resolveDataDir()/ensureFile() pattern already used by
//  cookies/store.ts and config/siteProfiles.ts, rather than factoring it out
//  into a shared helper — same reasoning as those two files not sharing one
//  either: keeping each store self-contained means a change to one can never
//  have an unreviewed side effect on the others.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import os from "os";
import type { ScrapeSession, SessionSummary } from "../types.js";
import logger from "../logger/index.js";

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
      return path.join(
        home,
        "Library",
        "Application Support",
        "webnovel-scraper",
      );
    default:
      return path.join(home, ".local", "share", "webnovel-scraper");
  }
}

export const SESSIONS_DIR = path.join(resolveDataDir(), "sessions");

function ensureDir(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

// ── Write (create or overwrite) a session checkpoint ──────────────────────
export function saveSession(session: ScrapeSession): void {
  ensureDir();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

// ── Load a single session by id (null if missing/corrupt) ─────────────────
export function loadSession(id: string): ScrapeSession | null {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(id), "utf8")) as ScrapeSession;
  } catch {
    return null;
  }
}

// ── Delete a session (called once its EPUB has actually been built) ───────
export function deleteSession(id: string): boolean {
  try {
    fs.unlinkSync(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}

// ── List every session on disk, skipping any file that fails to parse ─────
// (a half-written file from a crash mid-save is possible in principle;
// better to quietly drop it from the list than to crash the whole picker)
export function listSessions(): ScrapeSession[] {
  ensureDir();
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const sessions: ScrapeSession[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8");
      sessions.push(JSON.parse(raw) as ScrapeSession);
    } catch (e) {
      logger.warn(`Skipping unreadable session file "${file}": ${(e as Error).message}`);
    }
  }
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function listSessionSummaries(): SessionSummary[] {
  return listSessions().map((s) => ({
    id: s.id,
    novelTitle: s.novelTitle,
    domain: s.domain,
    totalChapters: s.chapterUrls.length,
    completedCount: s.completedChapters.length,
    updatedAt: s.updatedAt,
  }));
}

// ── Match key for "resume this?" — exact entryUrl equality ────────────────
export function findResumableSessionByUrl(entryUrl: string): ScrapeSession | null {
  const trimmed = entryUrl.trim();
  return listSessions().find((s) => s.entryUrl === trimmed) ?? null;
}
