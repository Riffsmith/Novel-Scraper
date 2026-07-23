// ─────────────────────────────────────────────────────────────────────────────
//  Core domain types for webnovel-scraper
// ─────────────────────────────────────────────────────────────────────────────

export type ScrapeMethod = 'toc' | 'sequential';
export type CoverSource  = 'url' | 'file' | 'none';
export type WaitUntil    = 'domcontentloaded' | 'networkidle' | 'load';
export type LogLevel     = 'error' | 'warn' | 'info' | 'debug';

// ── Global application config  (XDG_CONFIG_HOME/webnovel-scraper/config.json)
// All fields have hardcoded defaults so the file is always optional.
export interface AppConfig {
  // ── Output ────────────────────────────────────────────────────────────
  defaultOutputDir    : string;    // './output'

  // ── Performance ───────────────────────────────────────────────────────
  defaultConcurrency  : number;    // 2
  defaultDelayMin     : number;    // 1200 ms
  defaultDelayMax     : number;    // 3500 ms

  // ── Browser ───────────────────────────────────────────────────────────
  headless            : false;   // true
  // Which navigation event to wait for before extracting content.
  // 'domcontentloaded' = fastest (default). 'networkidle' = safer for
  // JS-heavy sites but slower. 'load' = wait for all resources.
  waitUntil           : WaitUntil; // 'domcontentloaded'
  navigationTimeoutMs : number;    // 30000

  // ── CloakBrowser stealth options ──────────────────────────────────────
  // humanize: replace all mouse/keyboard/scroll actions with human-like
  // Bézier curves and per-character timing.  Slows scraping by ~20–40%
  // but substantially reduces behavioural bot-detection scores.
  humanize            : true;          // false
  humanPreset         : 'default' | 'careful';  // 'default'
  // fingerprintSeed: pin a deterministic browser identity across sessions.
  // null = new random fingerprint on every launch (good for one-off scrapes).
  // A fixed integer = same GPU/canvas/screen values every time (good for
  // revisiting the same site repeatedly — looks like a returning device).
  fingerprintSeed     : number | null;    // null

  // ── Scraping ──────────────────────────────────────────────────────────
  maxRetries          : number;    // 3

  // ── Metadata defaults ─────────────────────────────────────────────────
  defaultLanguage     : string;    // 'en'
  defaultAuthor       : string;    // 'Unknown'
  defaultPublisher    : string;    // 'WebNovel Scraper'

  // ── Logging ───────────────────────────────────────────────────────────
  logLevel            : LogLevel;  // 'info'

  // ── UX ────────────────────────────────────────────────────────────────
  // After a successful scrape of a previously-unseen domain, ask whether
  // to save its extraction settings as a reusable site profile.
  askSaveProfile      : boolean;   // true
}

// ── Per-domain site profile  (XDG_DATA_HOME/webnovel-scraper/site-profiles.json)
// Stores extraction settings that don't change between novels on the same site.
export interface SiteProfile {
  domain            : string;
  label?            : string;      // human-friendly name e.g. "WebNovel.com"
  method            : ScrapeMethod;
  contentSelector   : string;
  separateTitle     : boolean;
  titleSelector?    : string;
  excludeSelectors  : string[];
  // sequential method
  nextButtonLocators?: NextLocator[];
  // per-site performance overrides (undefined = use global AppConfig values)
  concurrency?      : number;
  delayMin?         : number;
  delayMax?         : number;
  notes?            : string;
  savedAt           : string;      // ISO timestamp
  updatedAt         : string;      // ISO timestamp
}

// ── Next-button locator ────────────────────────────────────────────────────
// Replaces the old plain-string selector with a discriminated union so that
// CSS selectors, XPath expressions, and regex text-matching are all first-
// class citizens that the scraper engine handles differently.
export type LocatorKind = 'css' | 'xpath' | 'regex';

export interface NextLocator {
  kind  : LocatorKind;
  // css   → CSS selector string,            e.g. ".btn-next"
  // xpath → XPath expression (no xpath= prefix), e.g. "//a[contains(@class,'next')]"
  // regex → RegExp pattern (no / delimiters),    e.g. ">>"  or  "Next Chapter"
  value : string;
  flags?: string;  // regex only; defaults to 'i' if omitted
}

// ── Novel Metadata ─────────────────────────────────────────────────────────
export interface NovelMetadata {
  title:       string;
  author:      string;
  language:    string;           // ISO 639-1 e.g. "en"
  synopsis?:   string;
  publisher?:  string;
  coverSource: CoverSource;
  coverUrl?:   string;           // used when coverSource === 'url'
  coverPath?:  string;           // used when coverSource === 'file'
}

// ── Scraper configuration (assembled from TUI) ─────────────────────────────
export interface ScraperConfig {
  // method
  method: ScrapeMethod;

  // TOC method
  tocUrl?:       string;
  chapterLinks?: string[];

  // Sequential method
  firstChapterUrl?:    string;
  lastChapterUrl?:     string;
  // Priority-ordered list: index 0 = primary, 1+ = fallbacks.
  // Engine tries each in order per page; first match wins.
  nextButtonLocators?: NextLocator[];

  // Content extraction
  // All selector fields accept: CSS selector, "xpath=..." or "//" XPath, or id/class.
  contentSelector:   string;
  separateTitle:     boolean;
  titleSelector?:    string;
  excludeSelectors:  string[];

  // Metadata
  metadata: NovelMetadata;

  // Output
  outputDir:      string;
  outputFilename: string;

  // Behaviour
  concurrency: number;   // parallel pages (1–5)
  delayMin:    number;   // ms
  delayMax:    number;   // ms
  headless:    boolean;
}

// ── Scraped chapter ─────────────────────────────────────────────────────────
export interface Chapter {
  index:       number;   // 1-based sequential index
  title:       string;
  url:         string;
  htmlContent: string;   // sanitised XHTML-safe HTML
  wordCount:   number;
}

// ── Queue task ──────────────────────────────────────────────────────────────
export interface QueueTask {
  url:        string;
  index:      number;   // 0-based array index
  retries:    number;
  maxRetries: number;
}

// ── Error record ─────────────────────────────────────────────────────────────
export interface ScrapeError {
  url:     string;
  error:   string;
  retries: number;
}

// ── Overall scrape result ───────────────────────────────────────────────────
export interface ScrapeResult {
  chapters:  Chapter[];
  errors:    ScrapeError[];
  totalWords: number;
  scrapeMs:  number;
}
