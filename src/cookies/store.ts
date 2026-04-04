// ─────────────────────────────────────────────────────────────────────────────
//  Cookie store — persistent per-domain cookie management
//
//  Storage location (priority order):
//    1. $XDG_DATA_HOME/webnovel-scraper/cookies.json   (Linux XDG standard)
//    2. ~/Library/Application Support/webnovel-scraper/cookies.json  (macOS)
//    3. %APPDATA%\webnovel-scraper\cookies.json         (Windows)
//    4. ~/.local/share/webnovel-scraper/cookies.json    (Linux fallback)
//
//  File schema:
//    Record<hostname, PlaywrightCookie[]>
//    e.g. { "novelupdates.com": [ {name,value,path,...}, … ] }
//
//  The domain key is the bare hostname (no port, no protocol).
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import type { Cookie } from 'playwright';
import logger from '../logger/index.js';

// ── Resolve data directory ────────────────────────────────────────────────────
function resolveDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'webnovel-scraper');

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
        'webnovel-scraper',
      );
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'webnovel-scraper');
    default:
      return path.join(home, '.local', 'share', 'webnovel-scraper');
  }
}

export const DATA_DIR    = resolveDataDir();
export const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json');

// ── StoredCookie: Playwright's Cookie minus the domain (stored as the key) ───
// We add the domain back when loading, so Playwright gets fully-formed cookies.
export interface StoredCookie {
  name     : string;
  value    : string;
  path     : string;
  expires  : number;     // unix seconds; -1 = session cookie
  httpOnly : boolean;
  secure   : boolean;
  sameSite : 'Strict' | 'Lax' | 'None';
}

export type CookieStore = Record<string, StoredCookie[]>;

// ── Ensure the data directory and file exist ─────────────────────────────────
function ensureFile(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COOKIE_FILE)) {
    fs.writeFileSync(COOKIE_FILE, '{}', 'utf8');
  }
}

// ── Read the full store ───────────────────────────────────────────────────────
export function readStore(): CookieStore {
  ensureFile();
  try {
    const raw = fs.readFileSync(COOKIE_FILE, 'utf8');
    return JSON.parse(raw) as CookieStore;
  } catch (e) {
    logger.warn(`Failed to parse cookie store — starting fresh: ${(e as Error).message}`);
    return {};
  }
}

// ── Write the full store ──────────────────────────────────────────────────────
function writeStore(store: CookieStore): void {
  ensureFile();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ── List stored domains ───────────────────────────────────────────────────────
export function listDomains(): string[] {
  const store = readStore();
  return Object.keys(store).sort();
}

// ── Load cookies for a domain (returns Playwright-ready Cookie objects) ───────
// Playwright's addCookies requires EITHER `url` OR `domain`+`path` — providing
// both causes a validation error.  We use the domain form so the cookies apply
// to all paths and subdomains automatically.
// expires: -1 means "session cookie" in our store but Playwright expects the
// field to be omitted (or a positive unix timestamp) — we strip it here.
export function loadCookiesForDomain(domain: string): Cookie[] {
  const store    = readStore();
  const hostname = normaliseDomain(domain);

  // Also try matching against subdomains in the store.
  // e.g. entry URL is "www.webnovel.com" → normalises to "webnovel.com" → matches.
  const stored   = store[hostname];
  if (!stored || stored.length === 0) return [];

  return stored.map(c => {
    const cookie: Cookie = {
      name    : c.name,
      value   : c.value,
      domain  : `.${hostname}`,   // leading dot → valid for all subdomains
      path    : c.path,
      httpOnly: c.httpOnly,
      secure  : c.secure,
      sameSite: c.sameSite,
    };
    // Only set expires when it's a real timestamp; omit for session cookies.
    if (c.expires !== -1) cookie.expires = c.expires;
    return cookie;
  });
}

// ── Save cookies for a domain ─────────────────────────────────────────────────
export function saveCookiesForDomain(domain: string, cookies: StoredCookie[]): void {
  const store    = readStore();
  const hostname = normaliseDomain(domain);
  store[hostname] = cookies;
  writeStore(store);
  logger.info(`Saved ${cookies.length} cookie(s) for ${hostname}`);
}

// ── Append / upsert individual cookies for a domain ──────────────────────────
export function upsertCookies(domain: string, incoming: StoredCookie[]): void {
  const store    = readStore();
  const hostname = normaliseDomain(domain);
  const existing = store[hostname] ?? [];

  for (const ic of incoming) {
    const idx = existing.findIndex(c => c.name === ic.name);
    if (idx >= 0) existing[idx] = ic;
    else          existing.push(ic);
  }

  store[hostname] = existing;
  writeStore(store);
}

// ── Delete a specific cookie by name from a domain ───────────────────────────
export function deleteCookie(domain: string, name: string): boolean {
  const store    = readStore();
  const hostname = normaliseDomain(domain);
  const before   = (store[hostname] ?? []).length;
  store[hostname] = (store[hostname] ?? []).filter(c => c.name !== name);
  const deleted  = before > store[hostname].length;
  if (deleted) writeStore(store);
  return deleted;
}

// ── Delete all cookies for a domain ──────────────────────────────────────────
export function deleteDomain(domain: string): boolean {
  const store    = readStore();
  const hostname = normaliseDomain(domain);
  if (!(hostname in store)) return false;
  delete store[hostname];
  writeStore(store);
  logger.info(`Deleted all cookies for ${hostname}`);
  return true;
}

// ── Parse a raw "Cookie:" header string into StoredCookie entries ─────────────
// Input:  "session=abc123; theme=dark; _ga=GA1.2.xxx"
// Output: array of StoredCookie with sensible defaults
export function parseCookieHeader(raw: string, domain: string): StoredCookie[] {
  const hostname = normaliseDomain(domain);
  return raw
    .split(';')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const eqIdx = pair.indexOf('=');
      const name  = eqIdx >= 0 ? pair.slice(0, eqIdx).trim() : pair.trim();
      const value = eqIdx >= 0 ? pair.slice(eqIdx + 1).trim() : '';
      return {
        name,
        value,
        path    : '/',
        expires : -1,     // session cookie
        httpOnly: false,
        secure  : false,
        sameSite: 'Lax' as const,
      };
    })
    .filter(c => c.name.length > 0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normaliseDomain(raw: string): string {
  // Strip protocol, www., trailing slashes, port
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i,        '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
    .trim();
}
