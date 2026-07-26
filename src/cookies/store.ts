// ─────────────────────────────────────────────────────────────────────────────
//  Cookie store — persistent per-domain, named cookie profiles
//
//  Storage location (priority order):
//    1. $XDG_DATA_HOME/webnovel-scraper/cookies.json   (Linux XDG standard)
//    2. ~/Library/Application Support/webnovel-scraper/cookies.json  (macOS)
//    3. %APPDATA%\webnovel-scraper\cookies.json         (Windows)
//    4. ~/.local/share/webnovel-scraper/cookies.json    (Linux fallback)
//
//  File schema (current):
//    Record<hostname, Record<profileName, CookieProfile>>
//    e.g. { "novelupdates.com": { "default": { cookies: [...], createdAt, updatedAt } } }
//
//  Legacy schema (pre-profiles), auto-migrated on first read:
//    Record<hostname, StoredCookie[]>
//
//  The domain key is the bare hostname (no port, no protocol). Profiles are
//  scoped strictly per-domain — a profile named "main" on wtr-lab.com is
//  unrelated to a profile named "main" on novelfire.net.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import os from "os";
import type { Cookie } from "playwright";
import logger from "../logger/index.js";

// ── Resolve data directory ────────────────────────────────────────────────────
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

export const DATA_DIR = resolveDataDir();
export const COOKIE_FILE = path.join(DATA_DIR, "cookies.json");

// ── StoredCookie: Playwright's Cookie minus the domain (stored as the key) ───
// Individual cookie shape is UNCHANGED from the pre-profiles format.
export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expires: number; // unix seconds; -1 = session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

// ── One named profile's full cookie jar plus light metadata ──────────────────
export interface CookieProfile {
  cookies: StoredCookie[];
  label?: string; // free-text, e.g. "Alt account via VPN"
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastUsedAt?: string; // ISO 8601 — set only when actually loaded for a scrape
}

// profileName -> CookieProfile
export type DomainProfiles = Record<string, CookieProfile>;

// domain -> profiles
export type CookieStore = Record<string, DomainProfiles>;

// Lightweight summary for TUI pickers
export interface ProfileSummary {
  name: string;
  label?: string;
  cookieCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

// ── Ensure the data directory and file exist ─────────────────────────────────
function ensureFile(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COOKIE_FILE)) {
    fs.writeFileSync(COOKIE_FILE, "{}", "utf8");
  }
}

// ── Read the full store, migrating the legacy flat-array format in place ─────
// Discriminator is Array.isArray(): the legacy schema's per-domain value was
// always an array; the current schema's is never an array. Airtight — the two
// shapes can never be confused. Migration is additive-only (wrap, never drop)
// and runs exactly once per installation: if anything was migrated, the whole
// store is written back immediately so subsequent reads skip this path.
export function readStore(): CookieStore {
  ensureFile();
  try {
    const raw = fs.readFileSync(COOKIE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    let migrated = false;
    const store: CookieStore = {};
    const now = new Date().toISOString();

    for (const [domain, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[domain] = {
          default: {
            cookies: value as StoredCookie[],
            createdAt: now,
            updatedAt: now,
          },
        };
        migrated = true;
      } else {
        store[domain] = value as DomainProfiles;
      }
    }

    if (migrated) {
      logger.info("Migrated legacy cookie store to named-profile format", {
        file: COOKIE_FILE,
      });
      writeStore(store);
    }
    return store;
  } catch (e) {
    logger.warn(
      `Failed to parse cookie store — starting fresh: ${(e as Error).message}`,
    );
    return {};
  }
}

// ── Write the full store ──────────────────────────────────────────────────────
function writeStore(store: CookieStore): void {
  ensureFile();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ── List stored domains ───────────────────────────────────────────────────────
export function listDomains(): string[] {
  const store = readStore();
  return Object.keys(store).sort();
}

// ── List profile names for a domain, most-recently-used first ────────────────
export function listProfiles(domain: string): string[] {
  const store = readStore();
  const profiles = store[normaliseDomain(domain)] ?? {};
  return Object.keys(profiles).sort((a, b) => {
    const ta = profiles[a].lastUsedAt ?? profiles[a].updatedAt;
    const tb = profiles[b].lastUsedAt ?? profiles[b].updatedAt;
    return ta !== tb ? (ta > tb ? -1 : 1) : a.localeCompare(b);
  });
}

// ── Load a single profile record (null if missing) ────────────────────────────
export function getProfile(
  domain: string,
  profileName: string,
): CookieProfile | null {
  const store = readStore();
  return store[normaliseDomain(domain)]?.[profileName] ?? null;
}

// ── Lightweight summary — powers TUI pickers without exposing raw cookies ────
export function describeProfile(
  domain: string,
  profileName: string,
): ProfileSummary | null {
  const p = getProfile(domain, profileName);
  if (!p) return null;
  return {
    name: profileName,
    label: p.label,
    cookieCount: p.cookies.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastUsedAt: p.lastUsedAt,
  };
}

// ── Load cookies for a profile (returns Playwright-ready Cookie objects) ─────
// Playwright's addCookies requires EITHER `url` OR `domain`+`path` — providing
// both causes a validation error. We use the domain form so the cookies apply
// to all paths and subdomains automatically.
// expires: -1 means "session cookie" in our store but Playwright expects the
// field to be omitted (or a positive unix timestamp) — we strip it here.
export function loadCookiesForProfile(
  domain: string,
  profileName: string,
): Cookie[] {
  const profile = getProfile(domain, profileName);
  if (!profile || profile.cookies.length === 0) return [];

  const hostname = normaliseDomain(domain);
  return profile.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: `.${hostname}`, // leading dot → valid for all subdomains
    path: c.path,
    expires: c.expires, // -1 is Playwright's own session-cookie sentinel — always safe to pass through
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

// ── Save (overwrite) a profile's full cookie set ──────────────────────────────
// Used by browser-login capture — a fresh login is authoritative, so this
// replaces rather than merges. `createdAt` and `lastUsedAt` are preserved
// across an overwrite of an existing profile. `label` here means "keep the
// existing label if none is passed" — this is the right default for capture
// (which never has a label to offer), but NOT what you want for an explicit
// relabel/clear operation. Use setProfileLabel() for that instead.
export function saveProfileCookies(
  domain: string,
  profileName: string,
  cookies: StoredCookie[],
  label?: string,
): void {
  const store = readStore();
  const hostname = normaliseDomain(domain);
  const now = new Date().toISOString();
  const existing = store[hostname]?.[profileName];

  store[hostname] = store[hostname] ?? {};
  store[hostname][profileName] = {
    cookies,
    label: label ?? existing?.label,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };

  writeStore(store);
  logger.info(
    `Saved ${cookies.length} cookie(s) to profile "${profileName}" for ${hostname}`,
  );
}

// ── Append / upsert individual cookies into a profile ─────────────────────────
// Merge-by-name — same behavior manual entry has always had, now scoped to a
// named profile instead of a bare domain.
export function upsertProfileCookies(
  domain: string,
  profileName: string,
  incoming: StoredCookie[],
): void {
  const store = readStore();
  const hostname = normaliseDomain(domain);
  const now = new Date().toISOString();
  const existing = store[hostname]?.[profileName];
  const merged = existing ? [...existing.cookies] : [];

  for (const ic of incoming) {
    const idx = merged.findIndex((c) => c.name === ic.name);
    if (idx >= 0) merged[idx] = ic;
    else merged.push(ic);
  }

  store[hostname] = store[hostname] ?? {};
  store[hostname][profileName] = {
    cookies: merged,
    label: existing?.label,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };

  writeStore(store);
}

// ── Delete a specific cookie by name from a profile ───────────────────────────
export function deleteProfileCookie(
  domain: string,
  profileName: string,
  cookieName: string,
): boolean {
  const store = readStore();
  const profile = store[normaliseDomain(domain)]?.[profileName];
  if (!profile) return false;

  const before = profile.cookies.length;
  profile.cookies = profile.cookies.filter((c) => c.name !== cookieName);
  const deleted = profile.cookies.length < before;
  if (deleted) {
    profile.updatedAt = new Date().toISOString();
    writeStore(store);
  }
  return deleted;
}

// ── Delete a single profile ───────────────────────────────────────────────────
// If it was the domain's last remaining profile, the domain key is removed
// too — a domain with zero profiles is indistinguishable from one that was
// never added, which keeps listDomains() clean.
export function deleteProfile(domain: string, profileName: string): boolean {
  const store = readStore();
  const hostname = normaliseDomain(domain);
  if (!store[hostname]?.[profileName]) return false;

  delete store[hostname][profileName];
  if (Object.keys(store[hostname]).length === 0) delete store[hostname];

  writeStore(store);
  logger.info(`Deleted cookie profile "${profileName}" for ${hostname}`);
  return true;
}

// ── Delete every profile for a domain ─────────────────────────────────────────
export function deleteDomain(domain: string): boolean {
  const store = readStore();
  const hostname = normaliseDomain(domain);
  if (!(hostname in store)) return false;
  delete store[hostname];
  writeStore(store);
  logger.info(`Deleted all cookie profiles for ${hostname}`);
  return true;
}

// ── Rename a profile's key, leaving its cookies and label untouched ──────────
// Fails safely (returns false) if the source doesn't exist or the target name
// is already taken — never silently clobbers another profile.
export function renameProfile(
  domain: string,
  oldName: string,
  newName: string,
): boolean {
  const store = readStore();
  const profiles = store[normaliseDomain(domain)];
  if (!profiles?.[oldName] || profiles[newName]) return false;

  profiles[newName] = profiles[oldName];
  delete profiles[oldName];
  writeStore(store);
  return true;
}

// ── Set (or clear) a profile's label without touching cookies or renaming ────
// Distinct from saveProfileCookies's `label` param: this ALWAYS applies what's
// passed, including `undefined` to explicitly clear an existing label. Use
// this for any UI flow whose whole purpose is editing the label — using
// saveProfileCookies for that would silently no-op a "clear the label" intent,
// since it treats a missing label as "leave the existing one alone."
export function setProfileLabel(
  domain: string,
  profileName: string,
  label: string | undefined,
): boolean {
  const store = readStore();
  const hostname = normaliseDomain(domain);
  const profile = store[hostname]?.[profileName];
  if (!profile) return false;

  profile.label = label;
  profile.updatedAt = new Date().toISOString();
  writeStore(store);
  return true;
}

// ── Bump a profile's lastUsedAt — called when it's actually loaded for a scrape
export function markProfileUsed(domain: string, profileName: string): void {
  const store = readStore();
  const profile = store[normaliseDomain(domain)]?.[profileName];
  if (!profile) return; // defensive — profile may have been deleted mid-session
  profile.lastUsedAt = new Date().toISOString();
  writeStore(store);
}

// ── Parse a raw "Cookie:" header string into StoredCookie entries ─────────────
// Input:  "session=abc123; theme=dark; _ga=GA1.2.xxx"
// Output: array of StoredCookie with sensible defaults
export function parseCookieHeader(raw: string): StoredCookie[] {
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      const name = eqIdx >= 0 ? pair.slice(0, eqIdx).trim() : pair.trim();
      const value = eqIdx >= 0 ? pair.slice(eqIdx + 1).trim() : "";
      return {
        name,
        value,
        path: "/",
        expires: -1, // session cookie
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      };
    })
    .filter((c) => c.name.length > 0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function normaliseDomain(raw: string): string {
  // Strip protocol, www., trailing slashes, port
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase()
    .trim();
}
