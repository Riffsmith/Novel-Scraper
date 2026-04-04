// ─────────────────────────────────────────────────────────────────────────────
//  Site-profile store
//
//  File: $XDG_DATA_HOME/webnovel-scraper/site-profiles.json
//  Schema: Record<hostname, SiteProfile>
//
//  A site profile captures everything that stays the same across novels on the
//  same site:
//    • scraping method (TOC vs sequential)
//    • content selector, title selector, exclusion selectors
//    • next-button locators (sequential method)
//    • per-site performance overrides (concurrency, delays)
//    • optional human-readable label and notes
//
//  Novel-specific data (title, author, first/last URL, cover) is intentionally
//  NOT stored — those are always entered fresh for each scrape.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import type { SiteProfile } from '../types.js';
import logger from '../logger/index.js';

// ── Resolve data directory (same root as cookie store) ───────────────────────
function resolveDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'webnovel-scraper');

  const home = os.homedir();
  switch (process.platform) {
    case 'win32' : return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'webnovel-scraper');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'webnovel-scraper');
    default      : return path.join(home, '.local', 'share', 'webnovel-scraper');
  }
}

export const PROFILES_DIR  = resolveDataDir();
export const PROFILES_FILE = path.join(PROFILES_DIR, 'site-profiles.json');

type ProfileStore = Record<string, SiteProfile>;

// ── Ensure file exists ────────────────────────────────────────────────────────
function ensureFile(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_FILE)) {
    fs.writeFileSync(PROFILES_FILE, '{}', 'utf8');
  }
}

// ── Read full store ───────────────────────────────────────────────────────────
export function readProfiles(): ProfileStore {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')) as ProfileStore;
  } catch (e) {
    logger.warn(`Failed to parse site-profiles — starting fresh: ${(e as Error).message}`);
    return {};
  }
}

// ── Write full store ──────────────────────────────────────────────────────────
function writeProfiles(store: ProfileStore): void {
  ensureFile();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ── Normalise domain key (same rules as cookie store) ────────────────────────
export function normaliseDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i,        '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
    .trim();
}

// ── Check whether a profile exists for a domain ───────────────────────────────
export function hasProfile(domain: string): boolean {
  return normaliseDomain(domain) in readProfiles();
}

// ── Load a profile (null if not found) ────────────────────────────────────────
export function loadProfile(domain: string): SiteProfile | null {
  const store = readProfiles();
  return store[normaliseDomain(domain)] ?? null;
}

// ── Save / upsert a profile ───────────────────────────────────────────────────
export function saveProfile(profile: SiteProfile): void {
  const store = readProfiles();
  const key   = normaliseDomain(profile.domain);
  const now   = new Date().toISOString();

  store[key] = {
    ...profile,
    domain   : key,
    savedAt  : store[key]?.savedAt ?? now,
    updatedAt: now,
  };

  writeProfiles(store);
  logger.info(`Site profile saved for ${key}`, { file: PROFILES_FILE });
}

// ── Delete a profile ──────────────────────────────────────────────────────────
export function deleteProfile(domain: string): boolean {
  const store = readProfiles();
  const key   = normaliseDomain(domain);
  if (!(key in store)) return false;
  delete store[key];
  writeProfiles(store);
  logger.info(`Site profile deleted for ${key}`);
  return true;
}

// ── List all stored domains ───────────────────────────────────────────────────
export function listProfileDomains(): string[] {
  return Object.keys(readProfiles()).sort();
}
