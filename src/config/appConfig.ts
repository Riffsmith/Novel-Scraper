// ─────────────────────────────────────────────────────────────────────────────
//  Global application config
//
//  File location (priority):
//    $XDG_CONFIG_HOME/webnovel-scraper/config.json   (Linux standard)
//    ~/Library/Application Support/webnovel-scraper/config.json  (macOS)
//    %APPDATA%\webnovel-scraper\config.json           (Windows)
//    ~/.config/webnovel-scraper/config.json           (Linux fallback)
//
//  Every field has a hardcoded default — the file is always optional.
//  Unknown keys in the file are silently ignored (forward-compat).
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import type { AppConfig, WaitUntil, LogLevel } from '../types.js';
import logger from '../logger/index.js';

// ── Resolve config directory ──────────────────────────────────────────────────
function resolveConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'webnovel-scraper');

  const home = os.homedir();
  switch (process.platform) {
    case 'win32' : return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'webnovel-scraper');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'webnovel-scraper');
    default      : return path.join(home, '.config', 'webnovel-scraper');
  }
}

export const CONFIG_DIR  = resolveConfigDir();
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Hardcoded defaults — every key documented ─────────────────────────────────
export const DEFAULT_CONFIG: AppConfig = {
  // Where finished EPUBs are written when the user doesn't override.
  defaultOutputDir    : './output',

  // How many browser pages run in parallel during chapter scraping (1–5).
  // Higher = faster but more likely to trigger rate-limiting / CAPTCHAs.
  defaultConcurrency  : 2,

  // Random jitter range injected between every HTTP request (milliseconds).
  // Wider range = more human-like behaviour.
  defaultDelayMin     : 1200,
  defaultDelayMax     : 3500,

  // Run Chromium in headless mode. Set false to watch the browser while
  // debugging a stubborn site.
  headless            : true,

  // Which Playwright navigation event to wait for before extracting content.
  //   'domcontentloaded' → fastest, works for most static/SSR sites
  //   'load'             → waits for all sub-resources (images, fonts …)
  //   'networkidle'      → waits until no network activity for 500 ms;
  //                        use for heavy SPA / React sites
  waitUntil           : 'domcontentloaded',

  // Milliseconds before a page.goto() is considered failed.
  navigationTimeoutMs : 30_000,

  // How many times a failed chapter is retried before being dropped.
  maxRetries          : 3,

  // Pre-filled defaults shown in the novel metadata prompts.
  defaultLanguage     : 'en',
  defaultAuthor       : 'Unknown',
  defaultPublisher    : 'WebNovel Scraper',

  // Winston log level written to the console transport.
  logLevel            : 'info',

  // After scraping a domain for the first time, ask whether to save the
  // extraction settings as a reusable site profile.
  askSaveProfile      : true,
};

// ── Ensure the config directory and file exist ────────────────────────────────
function ensureFile(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    logger.info(`Created default config at ${CONFIG_FILE}`);
  }
}

// ── Read — merges file values on top of defaults (missing keys → defaults) ────
export function readConfig(): AppConfig {
  ensureFile();
  try {
    const raw  = fs.readFileSync(CONFIG_FILE, 'utf8');
    const disk = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...disk };
  } catch (e) {
    logger.warn(`Failed to parse config file — using defaults: ${(e as Error).message}`);
    return { ...DEFAULT_CONFIG };
  }
}

// ── Write — deep-merges with current file to preserve unknown keys ────────────
export function writeConfig(updates: Partial<AppConfig>): void {
  ensureFile();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* first write */ }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  logger.info('Config saved', { file: CONFIG_FILE });
}

// ── Reset to defaults ──────────────────────────────────────────────────────────
export function resetConfig(): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  logger.info('Config reset to defaults');
}
