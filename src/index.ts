#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  WebNovel Scraper  —  main entry point
// ─────────────────────────────────────────────────────────────────────────────

import chalk from 'chalk';
import type { Browser, Cookie } from 'playwright';
import logger from './logger/index.js';
import * as disp from './tui/display.js';
import { gatherConfig, gatherAutoConfig, editChapterLinks } from './tui/prompts.js';
import { manageCookies } from './tui/cookieManager.js';
import { manageSettings, promptSaveProfile } from './tui/configManager.js';
import { getBrowser, closeBrowser, createStealthContext, createPage } from './scraper/browser.js';
import { scrapeTOC } from './scraper/toc.js';
import { collectLinksSequentially } from './scraper/sequential.js';
import { runScrapeQueue } from './queue/index.js';
import { buildEpub } from './epub/builder.js';
import { loadCookiesForDomain, COOKIE_FILE } from './cookies/store.js';
import { readConfig } from './config/appConfig.js';
import { loadProfile, hasProfile, normaliseDomain } from './config/siteProfiles.js';
import { SITE_ADAPTERS, findSiteAdapter } from './sites/index.js';
import type { AutoScrapeResult } from './sites/types.js';
import type { AppConfig, ScraperConfig, SiteProfile } from './types.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require('enquirer');
async function prompt<T extends Record<string, unknown>>(q: object): Promise<T> {
  return _prompt(q) as Promise<T>;
}

// ── Error / notice reporting that survives the next screen's console.clear() ──
// disp.err()/disp.warn() alone get wiped almost instantly, because whatever
// runs next calls mainMenu() → disp.banner() → console.clear(). These helpers
// log to file AND block on an explicit keypress before continuing, so a
// failure can never disappear before you've read it again.
async function reportError(context: string, e: unknown): Promise<void> {
  const err = e as Error;
  logger.error(context, { error: err.message, stack: err.stack });

  console.log('');
  disp.err(`${context}: ${err.message}`);
  if (err.stack) disp.dim(err.stack.split('\n').slice(1, 5).join('\n'));
  console.log('');

  await prompt<{ ack: string }>({
    type   : 'input',
    name   : 'ack',
    message: chalk.dim('Press Enter to return to the main menu…'),
  }).catch(() => {});
}

async function reportNotice(lines: string[]): Promise<void> {
  console.log('');
  lines.forEach(l => disp.warn(l));
  console.log('');
  await prompt<{ ack: string }>({
    type   : 'input',
    name   : 'ack',
    message: chalk.dim('Press Enter to continue…'),
  }).catch(() => {});
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT',  () => gracefulExit('SIGINT'));
process.on('unhandledRejection', (reason) => {
  const err = reason as NodeJS.ErrnoException;
  if (err?.code === 'ERR_USE_AFTER_CLOSE') {
    // Known enquirer + newer-Node readline race: a stray keystroke fired
    // after a prompt's readline interface had already closed. Harmless —
    // just means one keypress got dropped. Log it quietly and move on
    // instead of letting it derail the current screen.
    logger.debug('Ignored benign ERR_USE_AFTER_CLOSE from enquirer readline race');
    return;
  }
  logger.error('Unhandled rejection', { error: err });
});
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('uncaughtException', (e: Error) => {
  logger.error('Uncaught exception', { error: e });
  gracefulExit('uncaughtException');
});

let shuttingDown = false;
async function gracefulExit(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.yellow(`\n\n  [${reason}] Shutting down gracefully…`));
  await closeBrowser().catch(() => {});
  process.exit(0);
}

function hostnameFrom(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ''); }
  catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Top-level menu
// ═══════════════════════════════════════════════════════════════════════════
async function mainMenu(): Promise<void> {
  disp.banner();

  const { action } = await prompt<{ action: string }>({
    type   : 'select',
    name   : 'action',
    message: 'What would you like to do?',
    choices: [
      { name: 'scrape',   message: '📖  Start a new scrape → EPUB' },
      { name: 'cookies',  message: '🍪  Manage saved cookies' },
      { name: 'settings', message: '⚙   Settings & site profiles' },
      { name: 'quit',     message: chalk.dim('✖   Quit') },
    ],
  });

  if (action === 'quit')     { console.log(chalk.dim('\n  Goodbye!\n')); process.exit(0); }
  if (action === 'cookies')  { await manageCookies();  return mainMenu(); }
  if (action === 'settings') { await manageSettings(); return mainMenu(); }

  // ── Scrape sub-menu: auto vs manual ────────────────────────────────────
  disp.section('📖  New Scrape');
  const { mode } = await prompt<{ mode: string }>({
    type   : 'select',
    name   : 'mode',
    message: 'How do you want to set this scrape up?',
    choices: [
      { name: 'auto',   message: '🤖  Auto     — paste a novel URL; metadata & chapters are fetched for you' },
      { name: 'manual', message: '🛠   Manual   — configure everything yourself' },
    ],
  });

  if (mode === 'auto') return startAutoScrape();
  return startScrape();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared tail — run the queue, build the EPUB, print summary, offer to
//  save a site profile. Used by both the manual and auto scrape flows.
// ═══════════════════════════════════════════════════════════════════════════
async function scrapeAndPackage(
  browser     : Browser,
  chapterUrls : string[],
  config      : ScraperConfig,
  cookies     : Cookie[],
  appCfg      : AppConfig,
  domain      : string,
  isNewDomain : boolean,
  startMs     : number,
): Promise<void> {
  disp.section('⚡  Scraping Chapters');
  const { chapters, errors } = await runScrapeQueue(
    browser, chapterUrls, config, cookies.length ? cookies : undefined, appCfg,
  );

  if (chapters.length === 0) {
    disp.err('No chapters scraped successfully.');
    disp.dim(`Check content selector: "${config.contentSelector}"`);
    process.exit(1);
  }
  if (errors.length > 0) {
    disp.warn(`${errors.length} chapter(s) failed:`);
    errors.forEach(e => disp.dim(`  ${e.url}  →  ${e.error}`));
  }

  disp.section('📦  Building EPUB');
  const outputPath = await buildEpub(
    chapters, config.metadata, config.outputDir, config.outputFilename,
  );

  const totalWords = chapters.reduce((s, ch) => s + ch.wordCount, 0);
  disp.summary({
    title   : config.metadata.title,
    chapters: chapters.length,
    words   : totalWords,
    timeMs  : Date.now() - startMs,
    output  : outputPath,
    errors  : errors.length,
  });

  if (domain && isNewDomain && appCfg.askSaveProfile) {
    const partial: Omit<SiteProfile, 'domain' | 'label' | 'notes' | 'savedAt' | 'updatedAt'> = {
      method            : config.method,
      contentSelector   : config.contentSelector,
      separateTitle     : config.separateTitle,
      titleSelector     : config.titleSelector,
      excludeSelectors  : config.excludeSelectors,
      nextButtonLocators: config.nextButtonLocators,
      concurrency       : config.concurrency !== appCfg.defaultConcurrency ? config.concurrency : undefined,
      delayMin          : config.delayMin    !== appCfg.defaultDelayMin    ? config.delayMin    : undefined,
      delayMax          : config.delayMax    !== appCfg.defaultDelayMax    ? config.delayMax    : undefined,
    };
    await promptSaveProfile(domain, partial);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Manual scrape flow
// ═══════════════════════════════════════════════════════════════════════════
async function startScrape(): Promise<void> {
  // ── 0. Load global config ─────────────────────────────────────────────
  const appCfg = readConfig();
  logger.level = appCfg.logLevel;

  // ── 1. Ask for the entry URL upfront so we can look up the profile ────
  disp.section('🌐  Entry URL');
  disp.dim('Enter the URL you plan to scrape (TOC page or first chapter URL).');
  disp.dim('This is used to look up any saved site profile for that domain.');
  console.log('');

  const { entryUrl } = await prompt<{ entryUrl: string }>({
    type    : 'input',
    name    : 'entryUrl',
    message : 'Entry URL:',
    validate: (v: string) => {
      try { new URL(v.trim()); return true; }
      catch { return 'Please enter a valid URL (include https://)'; }
    },
  });

  const domain  = hostnameFrom(entryUrl.trim());
  const profile = domain ? loadProfile(domain) : null;
  const isNewDomain = domain ? !hasProfile(domain) : false;

  if (profile) {
    logger.info(`Site profile matched for ${domain}`);
  }

  // ── 2. Gather full configuration (with pre-fills from profile) ─────────
  let config;
  try {
    config = await gatherConfig(appCfg, profile);
    if (config.method === 'toc' && !config.tocUrl) {
      config.tocUrl = entryUrl.trim();
    } else if (config.method === 'sequential' && !config.firstChapterUrl) {
      config.firstChapterUrl = entryUrl.trim();
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg  = (e as Error).message ?? '';
    if (code === 'ERR_USE_AFTER_CLOSE' || msg.includes('cancelled') || msg.includes('canceled')) {
      console.log(chalk.yellow('\n  Cancelled — goodbye!\n'));
      process.exit(0);
    }
    throw e;
  }

  logger.info('Configuration confirmed', {
    method: config.method, title: config.metadata.title, domain,
  });

  const startMs = Date.now();

  // ── 3. Auto-load cookies for the domain ───────────────────────────────
  let cookies: Cookie[] = [];
  if (domain) {
    cookies = loadCookiesForDomain(domain);
    if (cookies.length > 0) {
      disp.success(`Loaded ${chalk.cyan(String(cookies.length))} cookie(s) for ${chalk.cyan(domain)}`);
      logger.info(`Auto-loaded ${cookies.length} cookie(s)`, { domain, source: COOKIE_FILE });
    } else {
      disp.dim(`No stored cookies for ${domain}`);
    }
  }

  // ── 4. Launch browser ─────────────────────────────────────────────────
  const browser = await getBrowser({
    headless        : appCfg.headless,
    humanize        : appCfg.humanize,
    humanPreset     : appCfg.humanPreset,
    fingerprintSeed : appCfg.fingerprintSeed,
    timezone        : 'America/New_York',
    locale          : appCfg.defaultLanguage === 'en' ? 'en-US' : appCfg.defaultLanguage,
  });

  try {
    // ── 5. URL collection ────────────────────────────────────────────────
    let chapterUrls: string[] = [];

    if (config.method === 'toc') {
      disp.section('📋  Step 1 / 3 — Table of Contents');
      chapterUrls = await scrapeTOC(
        browser,
        config.tocUrl!,
        cookies.length ? cookies : undefined,
        appCfg.waitUntil,
        appCfg.navigationTimeoutMs,
      );
      if (chapterUrls.length === 0) {
        disp.err('No chapter links found on the TOC page.');
        disp.dim('Tip: check the URL, or add session cookies via Cookie Manager.');
        process.exit(1);
      }
    } else {
      disp.section('🔗  Step 1 / 3 — Sequential URL Collection');
      chapterUrls = await collectLinksSequentially(
        browser,
        config.firstChapterUrl!,
        config.lastChapterUrl!,
        config.nextButtonLocators!,
        config.delayMin,
        config.delayMax,
        cookies.length ? cookies : undefined,
        appCfg.waitUntil,
        appCfg.navigationTimeoutMs,
      );
      if (chapterUrls.length === 0) {
        disp.err('No URLs collected. Check your chapter URLs and next-button locator.');
        process.exit(1);
      }
    }

    // ── 6. Chapter list review ────────────────────────────────────────────
    chapterUrls = await editChapterLinks(chapterUrls);
    if (chapterUrls.length === 0) {
      disp.warn('No chapters left — nothing to scrape.');
      process.exit(0);
    }
    disp.success(`${chalk.cyan(String(chapterUrls.length))} chapters confirmed — starting scrape`);

    // ── 7. Scrape + package ────────────────────────────────────────────────
    await scrapeAndPackage(browser, chapterUrls, config, cookies, appCfg, domain, isNewDomain, startMs);

  } finally {
    await closeBrowser();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Auto scrape flow — driven by a SiteAdapter
// ═══════════════════════════════════════════════════════════════════════════
async function startAutoScrape(): Promise<void> {
  const appCfg = readConfig();
  logger.level = appCfg.logLevel;

  disp.section('🤖  Auto Scrape — Novel URL');
  disp.dim('Paste the URL of the novel’s main page (not the chapter list).');
  disp.dim(`Supported sites: ${SITE_ADAPTERS.map(a => a.label).join(', ')}`);
  console.log('');

  const { novelUrl } = await prompt<{ novelUrl: string }>({
    type    : 'input',
    name    : 'novelUrl',
    message : 'Novel URL:',
    validate: (v: string) => {
      try { new URL(v.trim()); return true; }
      catch { return 'Please enter a valid URL (include https://)'; }
    },
  });

  const trimmedUrl = novelUrl.trim();
  const adapter     = findSiteAdapter(trimmedUrl);

  if (!adapter) {
    disp.err('This site isn’t supported for auto-scraping yet.');
    disp.dim(`Currently supported: ${SITE_ADAPTERS.map(a => a.label).join(', ')}`);
    const { fallback } = await prompt<{ fallback: boolean }>({
      type   : 'confirm',
      name   : 'fallback',
      message: 'Switch to manual setup instead?',
      initial: true,
    });
    return fallback ? startScrape() : mainMenu();
  }

  const domain      = hostnameFrom(trimmedUrl);
  const profile     = domain ? loadProfile(domain) : null;
  const isNewDomain = domain ? !hasProfile(domain) : false;
  const cookies: Cookie[] = domain ? loadCookiesForDomain(domain) : [];

  if (cookies.length > 0) {
    disp.success(`Loaded ${chalk.cyan(String(cookies.length))} cookie(s) for ${chalk.cyan(domain)}`);
  }

  const browser = await getBrowser({
    headless        : appCfg.headless,
    humanize        : appCfg.humanize,
    humanPreset     : appCfg.humanPreset,
    fingerprintSeed : appCfg.fingerprintSeed,
    timezone        : 'America/New_York',
    locale          : appCfg.defaultLanguage === 'en' ? 'en-US' : appCfg.defaultLanguage,
  });

  let auto: AutoScrapeResult;

  try {
    const context = await createStealthContext(browser, cookies.length ? cookies : undefined);
    const page    = await createPage(context);

    const spin1 = disp.spinner(`Fetching novel metadata from ${adapter.label}…`);
    let metadata;
    try {
      metadata = await adapter.scrapeMetadata(page, trimmedUrl);
      spin1.succeed(`Metadata fetched: "${metadata.title}" by ${metadata.author}`);
      } catch (e) {
      spin1.fail('Metadata fetch failed');
      await context.close();
      throw e;
    }

    const spin2 = disp.spinner('Collecting chapter links (walking through every TOC batch — can take a bit)…');
    let chapterLinks: string[];
    try {
      chapterLinks = await adapter.scrapeChapterLinks(page, trimmedUrl, {
        waitUntil   : appCfg.waitUntil,
        navTimeoutMs: appCfg.navigationTimeoutMs,
      });
      spin2.succeed(`Collected ${chapterLinks.length} chapter link(s)`);
    } catch (e) {
      spin2.fail(`Chapter link collection failed`);
      await context.close();
      throw e;
    }

    await context.close();
    auto = { siteId: adapter.id, novelUrl: trimmedUrl, metadata, chapterLinks };
  } catch (e) {
    await reportError('Auto-scrape failed', e);
    await closeBrowser();
    return mainMenu();
  }

  if (auto.chapterLinks.length === 0) {
    await reportNotice(['No chapter links were found — the page structure may have changed.']);
    await closeBrowser();
    return mainMenu();
  }

  // ── Review + edit the harvested chapter list ───────────────────────────
  disp.section('📋  Review — Chapter List');
  auto.chapterLinks = await editChapterLinks(auto.chapterLinks);
  if (auto.chapterLinks.length === 0) {
    await reportNotice(['No chapters left — nothing to scrape.']);
    await closeBrowser();
    return mainMenu();
  }

  // ── Review + edit metadata / selectors / output / performance ──────────
  let config: ScraperConfig;
  try {
    config = await gatherAutoConfig(appCfg, profile, adapter, auto);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg  = (e as Error).message ?? '';
    if (code === 'ERR_USE_AFTER_CLOSE' || msg.includes('cancelled') || msg.includes('canceled')) {
      console.log(chalk.yellow('\n  Cancelled — goodbye!\n'));
      await closeBrowser();
      process.exit(0);
    }
    await closeBrowser();
    throw e;
  }

  logger.info('Auto-scrape configuration confirmed', {
    site: adapter.id, title: config.metadata.title, domain,
  });

  const startMs = Date.now();

  try {
    await scrapeAndPackage(browser, auto.chapterLinks, config, cookies, appCfg, domain, isNewDomain, startMs);
  } finally {
    await closeBrowser();
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
mainMenu().catch(async (e) => {
  logger.error('Fatal error', { error: e });
  disp.err(`Fatal: ${(e as Error).message}`);
  disp.dim('See logs/error.log for full details.');
  await closeBrowser().catch(() => {});
  process.exit(1);
});
