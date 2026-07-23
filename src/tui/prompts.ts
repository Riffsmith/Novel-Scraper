import chalk      from 'chalk';
import * as disp  from './display.js';
import type {
  ScraperConfig, NovelMetadata, CoverSource,
  NextLocator, AppConfig, SiteProfile,
} from '../types.js';
import type { AutoScrapeResult, SiteAdapter } from '../sites/types.js';
import { formatLocator } from '../scraper/selectors.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require('enquirer');

async function prompt<T extends Record<string, unknown>>(
  questions: object | object[],
): Promise<T> {
  return _prompt(questions) as Promise<T>;
}

// ── Validators ───────────────────────────────────────────────────────────────
function validateUrl(val: string): boolean | string {
  try   { new URL(val.trim()); return true; }
  catch { return 'Please enter a valid URL (include https://)'; }
}

function validateNonEmpty(label: string) {
  return (val: string) => val.trim().length > 0 || `${label} cannot be empty`;
}

function validateRegex(val: string): boolean | string {
  try   { new RegExp(val.trim()); return true; }
  catch { return 'Invalid regex pattern — check syntax'; }
}

const SELECTOR_HINT = 'CSS: .class  #id  |  XPath: //div[@class="x"]  |  xpath=//h1';

// ═══════════════════════════════════════════════════════════════════════════
//  promptLocator — unified locator entry (css | xpath | regex)
//  prefill: optionally pre-select a locator kind and value from a profile
// ═══════════════════════════════════════════════════════════════════════════
async function promptLocator(
  label  : string,
  prefill?: NextLocator,
): Promise<NextLocator> {
  const { kind } = await prompt<{ kind: string }>({
    type   : 'select',
    name   : 'kind',
    message: `${label} — locator type:`,
    choices: [
      { name: 'css',   message: `${chalk.cyan('CSS selector')}      e.g. .btn-next  a[rel="next"]  #nextchap` },
      { name: 'xpath', message: `${chalk.magenta('XPath expression')}  e.g. //a[contains(@class,"next")]` },
      { name: 'regex', message: `${chalk.yellow('Regex text match')}   e.g. >>  Next Chapter  下一章` },
    ],
    initial: prefill?.kind ?? 'css',
  });

  if (kind === 'css') {
    const { value } = await prompt<{ value: string }>({
      type    : 'input',
      name    : 'value',
      message : 'CSS selector:',
      hint    : 'e.g.  .next-chapter  |  a[rel="next"]  |  #btn-next',
      initial : prefill?.kind === 'css' ? prefill.value : '',
      validate: validateNonEmpty('Selector'),
    });
    return { kind: 'css', value: value.trim() };

  } else if (kind === 'xpath') {
    const { value } = await prompt<{ value: string }>({
      type    : 'input',
      name    : 'value',
      message : 'XPath expression:',
      hint    : 'e.g.  //a[contains(@class,"next")]  |  //p/a[last()]',
      initial : prefill?.kind === 'xpath' ? prefill.value : '',
      validate: validateNonEmpty('XPath expression'),
    });
    return { kind: 'xpath', value: value.trim().replace(/^xpath=/i, '') };

  } else {
    disp.dim('Matched against the visible text AND title attribute of every <a href> on the page.');
    const { value } = await prompt<{ value: string }>({
      type    : 'input',
      name    : 'value',
      message : 'Regex pattern (no / delimiters):',
      hint    : 'e.g.  >>  |  Next\\s*Chapter  |  下一章',
      initial : prefill?.kind === 'regex' ? prefill.value : '',
      validate: validateRegex,
    });
    const { flags } = await prompt<{ flags: string }>({
      type    : 'input',
      name    : 'flags',
      message : 'Regex flags:',
      initial : prefill?.flags ?? 'i',
      hint    : 'i = case-insensitive  u = unicode',
      validate: (v: string) => {
        try { new RegExp('', v.trim()); return true; }
        catch { return 'Invalid regex flags'; }
      },
    });
    return { kind: 'regex', value: value.trim(), flags: flags.trim() || 'i' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  gatherConfig — manual setup wizard (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
export async function gatherConfig(
  appCfg : AppConfig,
  profile: SiteProfile | null,
): Promise<ScraperConfig> {
  disp.banner();

  // ── Announce profile hit ─────────────────────────────────────────────────
  if (profile) {
    disp.section('🗂   Site Profile Loaded');
    disp.success(`Found a saved profile for ${chalk.cyan(profile.domain)}`);
    disp.dim    (`Label: ${profile.label ?? '(no label)'}`);
    disp.dim    (`Content selector pre-filled — you can change any value below.`);
    console.log('');
  }

  // ── 1. Scraping method ───────────────────────────────────────────────────
  disp.section('🔧  Scraping Method');

  const { method } = await prompt<{ method: string }>({
    type   : 'select',
    name   : 'method',
    message: 'How do you want to supply chapter URLs?',
    choices: [
      { name: 'toc',        message: '📋  Table of Contents URL  (auto-discover links from a TOC page)' },
      { name: 'sequential', message: '🔗  First + Last Chapter   (navigate via a "Next" button)' },
    ],
    initial: profile?.method ?? 'toc',
  });

  const cfg: Partial<ScraperConfig> = {
    method          : method as 'toc' | 'sequential',
    excludeSelectors: [],
    chapterLinks    : [],
  };

  // ── 2. Source URLs ────────────────────────────────────────────────────────
  disp.section('🌐  Source Configuration');

  if (method === 'toc') {
    const r = await prompt<{ tocUrl: string }>({
      type    : 'input',
      name    : 'tocUrl',
      message : 'Table of Contents URL:',
      validate: validateUrl,
    });
    cfg.tocUrl = r.tocUrl.trim();

  } else {
    const r1 = await prompt<{ firstChapterUrl: string }>({
      type    : 'input',
      name    : 'firstChapterUrl',
      message : 'URL of the FIRST chapter:',
      validate: validateUrl,
    });
    const r2 = await prompt<{ lastChapterUrl: string }>({
      type    : 'input',
      name    : 'lastChapterUrl',
      message : 'URL of the LAST chapter:',
      validate: validateUrl,
    });

    // ── Next-button locators ───────────────────────────────────────────────
    disp.section('🔍  Next-Chapter Locator');
    const profileLocators = profile?.nextButtonLocators ?? [];

    // If profile has locators, show them and ask whether to use or override
    let locators: NextLocator[];
    if (profileLocators.length > 0) {
      disp.info('Profile has saved locators:');
      profileLocators.forEach((l, i) => {
        const tag = i === 0 ? chalk.cyan('primary') : chalk.yellow(`fallback ${i}`);
        console.log(`    [${tag}]  ${chalk.white(formatLocator(l))}`);
      });
      console.log('');

      const { useProfile } = await prompt<{ useProfile: boolean }>({
        type   : 'confirm',
        name   : 'useProfile',
        message: 'Use these saved locators?',
        initial: true,
      });

      if (useProfile) {
        locators = profileLocators;
      } else {
        const primary = await promptLocator('Primary locator', profileLocators[0]);
        locators = [primary];
        locators = await appendFallbacks(locators);
      }
    } else {
      disp.dim('Three modes: CSS selector, XPath expression, or Regex text match.');
      console.log('');
      const primary = await promptLocator('Primary locator');
      locators = [primary];
      locators = await appendFallbacks(locators);
    }

    cfg.firstChapterUrl   = r1.firstChapterUrl.trim();
    cfg.lastChapterUrl    = r2.lastChapterUrl.trim();
    cfg.nextButtonLocators = locators;
  }

  // ── 3. Content extraction ─────────────────────────────────────────────────
  disp.section('🎯  Content Extraction');
  disp.dim(SELECTOR_HINT);
  console.log('');

  const { contentSelector } = await prompt<{ contentSelector: string }>({
    type    : 'input',
    name    : 'contentSelector',
    message : 'Chapter content container:',
    hint    : 'CSS or XPath  e.g.  .chapter-content  |  //div[@id="chapter-body"]',
    initial : profile?.contentSelector ?? '',
    validate: validateNonEmpty('Content selector'),
  });
  cfg.contentSelector = contentSelector.trim();

  const { separateTitle } = await prompt<{ separateTitle: boolean }>({
    type   : 'confirm',
    name   : 'separateTitle',
    message: 'Extract chapter title from a separate element?',
    initial: profile?.separateTitle ?? true,
  });
  cfg.separateTitle = separateTitle;

  if (separateTitle) {
    const r = await prompt<{ titleSelector: string }>({
      type    : 'input',
      name    : 'titleSelector',
      message : 'Chapter title element:',
      hint    : 'CSS or XPath  e.g.  .chapter-title  |  //h1[@class="title"]',
      initial : profile?.titleSelector ?? '',
      validate: validateNonEmpty('Title selector'),
    });
    cfg.titleSelector = r.titleSelector.trim();
  }

  // ── 4. Exclusions ─────────────────────────────────────────────────────────
  disp.section('🚫  Exclusions (optional)');

  const profileExcludes = profile?.excludeSelectors ?? [];

  const { hasExclusions } = await prompt<{ hasExclusions: boolean }>({
    type   : 'confirm',
    name   : 'hasExclusions',
    message: 'Exclude any elements from scraped content?',
    initial: profileExcludes.length > 0,
  });

  if (hasExclusions) {
    disp.dim('CSS and XPath accepted. Comma-separated.');
    const r = await prompt<{ exclusionList: string }>({
      type   : 'input',
      name   : 'exclusionList',
      message: 'Selectors to exclude:',
      initial: profileExcludes.join(', '),
    });
    cfg.excludeSelectors = r.exclusionList.split(',').map(s => s.trim()).filter(Boolean);
  }

  // ── 5. Novel metadata ─────────────────────────────────────────────────────
  disp.section('📋  Novel Metadata');

  const meta: Partial<NovelMetadata> = {};

  const rm1 = await prompt<{ title: string }>({
    type    : 'input',
    name    : 'title',
    message : 'Novel title:',
    validate: validateNonEmpty('Title'),
  });
  meta.title = rm1.title.trim();

  const rm2 = await prompt<{ author: string }>({
    type   : 'input',
    name   : 'author',
    message: 'Author name:',
    initial: appCfg.defaultAuthor,
  });
  meta.author = rm2.author.trim() || appCfg.defaultAuthor;

  const rm3 = await prompt<{ language: string }>({
    type   : 'input',
    name   : 'language',
    message: 'Language code (ISO 639-1):',
    initial: appCfg.defaultLanguage,
  });
  meta.language = rm3.language.trim() || appCfg.defaultLanguage;

  const rm4 = await prompt<{ publisher: string }>({
    type   : 'input',
    name   : 'publisher',
    message: 'Publisher / source (optional):',
    initial: appCfg.defaultPublisher,
  });
  meta.publisher = rm4.publisher.trim() || appCfg.defaultPublisher;

  const { hasSynopsis } = await prompt<{ hasSynopsis: boolean }>({
    type   : 'confirm',
    name   : 'hasSynopsis',
    message: 'Add a synopsis / description?',
    initial: false,
  });
  if (hasSynopsis) {
    const rs = await prompt<{ synopsis: string }>({
      type   : 'input',
      name   : 'synopsis',
      message: 'Synopsis:',
    });
    meta.synopsis = rs.synopsis.trim();
  }

  const { coverSource } = await prompt<{ coverSource: string }>({
    type   : 'select',
    name   : 'coverSource',
    message: 'Cover image:',
    choices: [
      { name: 'none', message: '❌  No cover' },
      { name: 'url',  message: '🔗  Download from a URL' },
      { name: 'file', message: '📁  Local file path' },
    ],
  });
  meta.coverSource = coverSource as CoverSource;

  if (coverSource === 'url') {
    const rc = await prompt<{ coverUrl: string }>({
      type: 'input', name: 'coverUrl', message: 'Cover image URL:', validate: validateUrl,
    });
    meta.coverUrl = rc.coverUrl.trim();
  } else if (coverSource === 'file') {
    const rc = await prompt<{ coverPath: string }>({
      type: 'input', name: 'coverPath', message: 'Path to cover image file:', validate: validateNonEmpty('Path'),
    });
    meta.coverPath = rc.coverPath.trim();
  }

  // ── 6. Output ─────────────────────────────────────────────────────────────
  disp.section('📁  Output Settings');

  const ro1 = await prompt<{ outputDir: string }>({
    type   : 'input',
    name   : 'outputDir',
    message: 'Output directory:',
    initial: appCfg.defaultOutputDir,
  });

  const defaultFilename = meta.title!
    .replace(/[^a-z0-9\s]/gi, '').trim()
    .replace(/\s+/g, '_').toLowerCase() + '.epub';

  const ro2 = await prompt<{ outputFilename: string }>({
    type   : 'input',
    name   : 'outputFilename',
    message: 'Output filename (.epub):',
    initial: defaultFilename,
  });

  // ── 7. Performance ────────────────────────────────────────────────────────
  disp.section('⚡  Performance & Stealth');

  // Site profile can override global defaults
  const defConcurrency = profile?.concurrency  ?? appCfg.defaultConcurrency;
  const defDelayMin    = profile?.delayMin     ?? appCfg.defaultDelayMin;
  const defDelayMax    = profile?.delayMax     ?? appCfg.defaultDelayMax;

  const rp1 = await prompt<{ concurrency: string }>({
    type   : 'input',
    name   : 'concurrency',
    message: 'Concurrent browser pages (1–5):',
    initial: String(defConcurrency),
    validate: (v: string) => {
      const n = parseInt(v, 10);
      return (!isNaN(n) && n >= 1 && n <= 5) || 'Must be between 1 and 5';
    },
  });

  const rp2 = await prompt<{ delayRange: string }>({
    type   : 'input',
    name   : 'delayRange',
    message: 'Delay range between requests in ms (min-max):',
    initial: `${defDelayMin}-${defDelayMax}`,
    validate: (v: string) => {
      const [a, b] = v.split('-').map(Number);
      return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || 'Format: min-max';
    },
  });

  const [delayMin, delayMax] = rp2.delayRange.split('-').map(Number);

  // ── 8. Confirmation ───────────────────────────────────────────────────────
  disp.section('✅  Confirm');
  console.log('');
  disp.info(`Novel   : ${chalk.cyan(meta.title!)}`);
  disp.info(`Method  : ${chalk.cyan(method)}`);
  if (method === 'sequential' && cfg.nextButtonLocators?.length) {
    cfg.nextButtonLocators.forEach((l, i) => {
      const tag = i === 0 ? chalk.cyan('primary ') : chalk.yellow(`fallback ${i}`);
      disp.info(`Next [${tag}]: ${chalk.white(formatLocator(l))}`);
    });
  }
  if (profile) disp.info(`Profile : ${chalk.cyan(profile.domain)} ${chalk.dim('(pre-filled)')}`);
  disp.info(`Threads : ${chalk.cyan(rp1.concurrency)}`);
  disp.info(`Delay   : ${chalk.cyan(rp2.delayRange)} ms`);
  disp.info(`Output  : ${chalk.cyan(ro1.outputDir + '/' + ro2.outputFilename)}`);
  console.log('');

  const { confirmed } = await prompt<{ confirmed: boolean }>({
    type   : 'confirm',
    name   : 'confirmed',
    message: 'Start scraping with these settings?',
    initial: true,
  });

  if (!confirmed) {
    console.log(chalk.yellow('\n  Aborted by user.\n'));
    process.exit(0);
  }

  return {
    method            : method as 'toc' | 'sequential',
    tocUrl            : cfg.tocUrl,
    chapterLinks      : cfg.chapterLinks,
    firstChapterUrl   : cfg.firstChapterUrl,
    lastChapterUrl    : cfg.lastChapterUrl,
    nextButtonLocators: cfg.nextButtonLocators,
    contentSelector   : cfg.contentSelector!,
    separateTitle     : cfg.separateTitle!,
    titleSelector     : cfg.titleSelector,
    excludeSelectors  : cfg.excludeSelectors!,
    metadata          : meta as NovelMetadata,
    outputDir         : ro1.outputDir.trim(),
    outputFilename    : ro2.outputFilename.trim(),
    concurrency       : parseInt(rp1.concurrency, 10),
    delayMin,
    delayMax,
    headless          : appCfg.headless,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  gatherAutoConfig — review/edit screen for an AUTO scrape.
//
//  Chapter URLs and novel metadata were already fetched by a SiteAdapter;
//  this wizard skips the scraping-method/URL-entry sections of gatherConfig
//  and instead lets the user review & tweak: extraction selectors (pre-
//  filled from adapter defaults), metadata (pre-filled from the scrape),
//  output, and performance — before confirming the run.
// ═══════════════════════════════════════════════════════════════════════════
export async function gatherAutoConfig(
  appCfg : AppConfig,
  profile: SiteProfile | null,
  adapter: SiteAdapter,
  auto   : AutoScrapeResult,
): Promise<ScraperConfig> {
  disp.banner();

  disp.section('🤖  Auto-Scrape Review');
  disp.success(`Site        : ${adapter.label}`);
  disp.info   (`Novel       : ${chalk.cyan(auto.metadata.title)}`);
  disp.info   (`Author      : ${chalk.cyan(auto.metadata.author)}`);
  disp.info   (`Chapters    : ${chalk.cyan(String(auto.chapterLinks.length))}`);
  if (auto.metadata.coverUrl) disp.info(`Cover       : ${chalk.dim(auto.metadata.coverUrl)}`);
  console.log('');
  disp.dim('Everything below is pre-filled from the site — review and edit as needed.');
  console.log('');

  if (profile) {
    disp.section('🗂   Site Profile Loaded');
    disp.success(`Found a saved profile for ${chalk.cyan(profile.domain)}`);
    disp.dim    (`Label: ${profile.label ?? '(no label)'}`);
    console.log('');
  }

  // ── 1. Content extraction ────────────────────────────────────────────────
  disp.section('🎯  Content Extraction');
  disp.dim(SELECTOR_HINT);
  disp.dim('Pre-filled with the site adapter default — verify against a real chapter page before a big run.');
  console.log('');

  const { contentSelector } = await prompt<{ contentSelector: string }>({
    type    : 'input',
    name    : 'contentSelector',
    message : 'Chapter content container:',
    hint    : 'CSS or XPath  e.g.  .chapter-content  |  //div[@id="chapter-body"]',
    initial : profile?.contentSelector ?? adapter.defaultContentSelector,
    validate: validateNonEmpty('Content selector'),
  });

  const { separateTitle } = await prompt<{ separateTitle: boolean }>({
    type   : 'confirm',
    name   : 'separateTitle',
    message: 'Extract chapter title from a separate element?',
    initial: profile?.separateTitle ?? adapter.defaultSeparateTitle,
  });

  let titleSelector: string | undefined;
  if (separateTitle) {
    const r = await prompt<{ titleSelector: string }>({
      type    : 'input',
      name    : 'titleSelector',
      message : 'Chapter title element:',
      hint    : 'CSS or XPath  e.g.  .chapter-title  |  //h1[@class="title"]',
      initial : profile?.titleSelector ?? adapter.defaultTitleSelector ?? '',
      validate: validateNonEmpty('Title selector'),
    });
    titleSelector = r.titleSelector.trim();
  }

  // ── 2. Exclusions ─────────────────────────────────────────────────────────
  disp.section('🚫  Exclusions (optional)');

  const profileExcludes = profile?.excludeSelectors ?? adapter.defaultExcludeSelectors;

  const { hasExclusions } = await prompt<{ hasExclusions: boolean }>({
    type   : 'confirm',
    name   : 'hasExclusions',
    message: 'Exclude any elements from scraped content?',
    initial: profileExcludes.length > 0,
  });

  let excludeSelectors: string[] = [];
  if (hasExclusions) {
    disp.dim('CSS and XPath accepted. Comma-separated.');
    const r = await prompt<{ exclusionList: string }>({
      type   : 'input',
      name   : 'exclusionList',
      message: 'Selectors to exclude:',
      initial: profileExcludes.join(', '),
    });
    excludeSelectors = r.exclusionList.split(',').map(s => s.trim()).filter(Boolean);
  }

  // ── 3. Novel metadata (pre-filled, editable) ────────────────────────────
  disp.section('📋  Novel Metadata');

  const meta: Partial<NovelMetadata> = {};

  const rm1 = await prompt<{ title: string }>({
    type    : 'input',
    name    : 'title',
    message : 'Novel title:',
    initial : auto.metadata.title,
    validate: validateNonEmpty('Title'),
  });
  meta.title = rm1.title.trim();

  const rm2 = await prompt<{ author: string }>({
    type   : 'input',
    name   : 'author',
    message: 'Author name:',
    initial: auto.metadata.author || appCfg.defaultAuthor,
  });
  meta.author = rm2.author.trim() || appCfg.defaultAuthor;

  const rm3 = await prompt<{ language: string }>({
    type   : 'input',
    name   : 'language',
    message: 'Language code (ISO 639-1):',
    initial: appCfg.defaultLanguage,
  });
  meta.language = rm3.language.trim() || appCfg.defaultLanguage;

  const rm4 = await prompt<{ publisher: string }>({
    type   : 'input',
    name   : 'publisher',
    message: 'Publisher / source (optional):',
    initial: appCfg.defaultPublisher,
  });
  meta.publisher = rm4.publisher.trim() || appCfg.defaultPublisher;

  const { hasSynopsis } = await prompt<{ hasSynopsis: boolean }>({
    type   : 'confirm',
    name   : 'hasSynopsis',
    message: 'Include the auto-fetched synopsis / description?',
    initial: auto.metadata.description.length > 0,
  });
  if (hasSynopsis) {
    const rs = await prompt<{ synopsis: string }>({
      type   : 'input',
      name   : 'synopsis',
      message: 'Synopsis:',
      initial: auto.metadata.description,
    });
    meta.synopsis = rs.synopsis.trim();
  }

  const { coverSource } = await prompt<{ coverSource: string }>({
    type   : 'select',
    name   : 'coverSource',
    message: 'Cover image:',
    choices: [
      { name: 'none', message: '❌  No cover' },
      { name: 'url',  message: '🔗  Download from a URL' },
      { name: 'file', message: '📁  Local file path' },
    ],
    initial: auto.metadata.coverUrl ? 'url' : 'none',
  });
  meta.coverSource = coverSource as CoverSource;

  if (coverSource === 'url') {
    const rc = await prompt<{ coverUrl: string }>({
      type    : 'input',
      name    : 'coverUrl',
      message : 'Cover image URL:',
      initial : auto.metadata.coverUrl ?? '',
      validate: validateUrl,
    });
    meta.coverUrl = rc.coverUrl.trim();
  } else if (coverSource === 'file') {
    const rc = await prompt<{ coverPath: string }>({
      type: 'input', name: 'coverPath', message: 'Path to cover image file:', validate: validateNonEmpty('Path'),
    });
    meta.coverPath = rc.coverPath.trim();
  }

  // ── 4. Output ─────────────────────────────────────────────────────────────
  disp.section('📁  Output Settings');

  const ro1 = await prompt<{ outputDir: string }>({
    type   : 'input',
    name   : 'outputDir',
    message: 'Output directory:',
    initial: appCfg.defaultOutputDir,
  });

  const defaultFilename = meta.title!
    .replace(/[^a-z0-9\s]/gi, '').trim()
    .replace(/\s+/g, '_').toLowerCase() + '.epub';

  const ro2 = await prompt<{ outputFilename: string }>({
    type   : 'input',
    name   : 'outputFilename',
    message: 'Output filename (.epub):',
    initial: defaultFilename,
  });

  // ── 5. Performance ────────────────────────────────────────────────────────
  disp.section('⚡  Performance & Stealth');

  const defConcurrency = profile?.concurrency ?? appCfg.defaultConcurrency;
  const defDelayMin    = profile?.delayMin    ?? appCfg.defaultDelayMin;
  const defDelayMax    = profile?.delayMax    ?? appCfg.defaultDelayMax;

  const rp1 = await prompt<{ concurrency: string }>({
    type   : 'input',
    name   : 'concurrency',
    message: 'Concurrent browser pages (1–5):',
    initial: String(defConcurrency),
    validate: (v: string) => {
      const n = parseInt(v, 10);
      return (!isNaN(n) && n >= 1 && n <= 5) || 'Must be between 1 and 5';
    },
  });

  const rp2 = await prompt<{ delayRange: string }>({
    type   : 'input',
    name   : 'delayRange',
    message: 'Delay range between requests in ms (min-max):',
    initial: `${defDelayMin}-${defDelayMax}`,
    validate: (v: string) => {
      const [a, b] = v.split('-').map(Number);
      return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || 'Format: min-max';
    },
  });

  const [delayMin, delayMax] = rp2.delayRange.split('-').map(Number);

  // ── 6. Confirmation ───────────────────────────────────────────────────────
  disp.section('✅  Confirm');
  console.log('');
  disp.info(`Novel      : ${chalk.cyan(meta.title!)}`);
  disp.info(`Author     : ${chalk.cyan(meta.author!)}`);
  disp.info(`Chapters   : ${chalk.cyan(String(auto.chapterLinks.length))}`);
  disp.info(`Content sel: ${chalk.cyan(contentSelector)}`);
  if (profile) disp.info(`Profile    : ${chalk.cyan(profile.domain)} ${chalk.dim('(pre-filled)')}`);
  disp.info(`Threads    : ${chalk.cyan(rp1.concurrency)}`);
  disp.info(`Delay      : ${chalk.cyan(rp2.delayRange)} ms`);
  disp.info(`Output     : ${chalk.cyan(ro1.outputDir + '/' + ro2.outputFilename)}`);
  console.log('');

  const { confirmed } = await prompt<{ confirmed: boolean }>({
    type   : 'confirm',
    name   : 'confirmed',
    message: 'Start scraping with these settings?',
    initial: true,
  });

  if (!confirmed) {
    console.log(chalk.yellow('\n  Aborted by user.\n'));
    process.exit(0);
  }

  return {
    method            : 'toc',
    tocUrl            : adapter.getTocUrl(auto.novelUrl),
    chapterLinks      : auto.chapterLinks,
    contentSelector,
    separateTitle,
    titleSelector,
    excludeSelectors,
    metadata          : meta as NovelMetadata,
    outputDir         : ro1.outputDir.trim(),
    outputFilename    : ro2.outputFilename.trim(),
    concurrency       : parseInt(rp1.concurrency, 10),
    delayMin,
    delayMax,
    headless          : appCfg.headless,
  };
}

// ── Shared fallback-loop helper ───────────────────────────────────────────────
async function appendFallbacks(locators: NextLocator[]): Promise<NextLocator[]> {
  const { wantFallbacks } = await prompt<{ wantFallbacks: boolean }>({
    type   : 'confirm',
    name   : 'wantFallbacks',
    message: 'Add fallback locators? (only needed when layout changes mid-novel)',
    initial: false,
  });
  if (!wantFallbacks) return locators;

  let idx = 1;
  while (true) {
    const { addAnother } = await prompt<{ addAnother: boolean }>({
      type   : 'confirm',
      name   : 'addAnother',
      message: `Add fallback #${idx}?`,
      initial: true,
    });
    if (!addAnother) break;

    const fb = await promptLocator(`Fallback #${idx}`);
    locators.push(fb);
    idx++;

    console.log('');
    disp.info(chalk.bold('Locator priority order:'));
    locators.forEach((l, i) => {
      const tag = i === 0 ? chalk.cyan.bold('  primary') : chalk.yellow(`fallback ${i}`);
      console.log(`    ${chalk.dim(`${i + 1}.`)} [${tag}]  ${chalk.white(formatLocator(l))}`);
    });
    console.log('');
  }
  return locators;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chapter link editor  (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
export async function editChapterLinks(links: string[]): Promise<string[]> {
  disp.section('📋  Chapter List Review');
  disp.info(`Found ${chalk.cyan(String(links.length))} chapters`);
  disp.printChapterList(links);
  console.log('');

  let current = [...links];

  while (true) {
    const { action } = await prompt<{ action: string }>({
      type   : 'select',
      name   : 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'proceed',  message: `✅  Proceed with all ${current.length} chapters` },
        { name: 'remove',   message: '🗑   Remove chapters by index / range' },
        { name: 'add',      message: '➕  Add chapter URLs' },
        { name: 'reverse',  message: '🔃  Reverse order (first ↔ last)' },
        { name: 'view',     message: '👁   View the full chapter list' },
      ],
    });

    if (action === 'proceed') break;

    if (action === 'reverse') {
      current.reverse();
      disp.success(`Order reversed — now starts at: ${chalk.dim(current[0])}`);
      disp.printChapterList(current);

    } else if (action === 'view') {
      disp.printChapterList(current, current.length);

    } else if (action === 'remove') {
      disp.info('Enter indices or ranges to remove, separated by commas.');
      disp.dim ('Examples:  5  |  10-20  |  5, 10-20, 99');
      const { rangeStr } = await prompt<{ rangeStr: string }>({
        type: 'input', name: 'rangeStr', message: 'Indices / ranges to remove:',
      });
      const toRemove = parseRanges(rangeStr, current.length);
      const before   = current.length;
      current = current.filter((_, i) => !toRemove.has(i + 1));
      disp.success(`Removed ${before - current.length} chapter(s). ${current.length} remaining.`);

    } else if (action === 'add') {
      const { rawUrls } = await prompt<{ rawUrls: string }>({
        type: 'input', name: 'rawUrls', message: 'Enter URLs to add (comma or newline separated):',
      });
      const added = rawUrls.split(/[\n,]+/).map(u => u.trim())
        .filter(u => { try { new URL(u); return true; } catch { return false; } });
      current.push(...added);
      disp.success(`Added ${added.length} URL(s). ${current.length} total.`);
    }
  }

  return current;
}

function parseRanges(input: string, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of input.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = Math.max(1, a); i <= Math.min(max, b); i++) result.add(i);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= max) result.add(n);
    }
  }
  return result;
}
