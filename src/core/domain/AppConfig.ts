// ─────────────────────────────────────────────────────────────────────────────
//  AppConfig - global application config domain type and defaults.
//
//  Ported VERBATIM from v1:
//    interface AppConfig … src/types.ts:12-56
//    const   DEFAULT_CONFIG … src/config/appConfig.ts:48-103
//
//  The v2 adapter (adapters/config-yaml/YamlConfigStore.ts) reads/writes
//  YAML, but the domain shape and defaults stay here in core. yaml↔json
//  mapping preserves v1's deep-merge-and-unknown-key semantics (ADR-004).
// ─────────────────────────────────────────────────────────────────────────────

export type WaitUntil = "domcontentloaded" | "networkidle" | "load";
export type LogLevel = "error" | "warn" | "info" | "debug";

export interface AppConfig {
  // ── Output ────────────────────────────────────────────────────────────
  defaultOutputDir: string;

  // ── Performance ───────────────────────────────────────────────────────
  defaultConcurrency: number;
  defaultDelayMin: number;
  defaultDelayMax: number;

  // ── Browser ───────────────────────────────────────────────────────────
  headless: boolean;
  waitUntil: WaitUntil;
  navigationTimeoutMs: number;

  // ── Stealth (CloakBrowser) ─────────────────────────────────────────────
  humanize: boolean;
  humanPreset: "default" | "careful";
  fingerprintSeed: number | null;

  // ── Scraping ──────────────────────────────────────────────────────────
  maxRetries: number;

  // ── Metadata defaults ─────────────────────────────────────────────────
  defaultLanguage: string;
  defaultAuthor: string;
  defaultPublisher: string;

  // ── Logging ───────────────────────────────────────────────────────────
  logLevel: LogLevel;

  // ── UX ────────────────────────────────────────────────────────────────
  askSaveProfile: boolean;
}

// ── Hardcoded defaults - every key documented (verbatim from v1) ───────────
export const DEFAULT_CONFIG: AppConfig = {
  // Where finished EPUBs are written when the user doesn't override.
  defaultOutputDir: "./output",

  // How many browser pages run in parallel during chapter scraping (1-5).
  // Higher = faster but more likely to trigger rate-limiting / CAPTCHAs.
  defaultConcurrency: 2,

  // Random jitter range injected between every HTTP request (milliseconds).
  // Wider range = more human-like behaviour.
  defaultDelayMin: 1200,
  defaultDelayMax: 3500,

  // Run Chromium in headless mode. Set false to watch the browser while
  // debugging a stubborn site.
  headless: true,

  // Which Playwright navigation event to wait for before extracting content.
  //   'domcontentloaded' -> fastest, works for most static/SSR sites
  //   'load'             -> waits for all sub-resources (images, fonts ...)
  //   'networkidle'      -> waits until no network activity for 500 ms;
  //                         use for heavy SPA / React sites
  waitUntil: "domcontentloaded",

  // Milliseconds before a page.goto() is considered failed.
  navigationTimeoutMs: 30_000,

  // ── CloakBrowser stealth options ──────────────────────────────────────
  // Simulate human mouse/keyboard/scroll behavior via Bezier curves and
  // per-character timing.  Recommended for sites with reCAPTCHA v3 or
  // behavioral analysis (DataDome, PerimeterX).  Slows scraping ~20-40%.
  humanize: false,

  // 'default' = normal speed.  'careful' = slower, with idle micro-movements.
  humanPreset: "default",

  // null  = fresh random fingerprint per launch (good for one-off scrapes).
  // number = fixed seed, same device identity every run (good for revisiting
  //          the same site repeatedly - looks like a returning user to reCAPTCHA).
  fingerprintSeed: null,

  // How many times a failed chapter is retried before being dropped.
  maxRetries: 3,

  // Pre-filled defaults shown in the novel metadata prompts.
  defaultLanguage: "en",
  defaultAuthor: "Unknown",
  defaultPublisher: "WebNovel Scraper",

  // Winston log level written to the console transport.
  logLevel: "info",

  // After scraping a domain for the first time, ask whether to save the
  // extraction settings as a reusable site profile.
  askSaveProfile: true,
};

// Stepped schema version for the YAML file. Phase 2 stamps v2; future
// additive schema bumps follow the migration-chain contract (05 §9).
export const APP_CONFIG_SCHEMA_VERSION = 2;
