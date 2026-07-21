#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  WebNovel Scraper  —  main entry point
// ─────────────────────────────────────────────────────────────────────────────

import chalk from 'chalk';
import logger from './logger/index.js';
import * as disp from './tui/display.js';
import { gatherConfig, editChapterLinks } from './tui/prompts.js';
import { manageCookies } from './tui/cookieManager.js';
import { manageSettings, promptSaveProfile } from './tui/configManager.js';
import { getBrowser, closeBrowser } from './scraper/browser.js';
import { scrapeTOC } from './scraper/toc.js';
import { collectLinksSequentially } from './scraper/sequential.js';
import { runScrapeQueue } from './queue/index.js';
import { buildEpub } from './epub/builder.js';
import { loadCookiesForDomain, COOKIE_FILE } from './cookies/store.js';
import { readConfig } from './config/appConfig.js';
import { loadProfile, hasProfile, saveProfile, normaliseDomain } from './config/siteProfiles.js';
import type { Cookie } from 'playwright';
import type { SiteProfile } from './types.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require('enquirer');
async function prompt<T extends Record<string, unknown>>(q: object): Promise<T> {
  return _prompt(q) as Promise<T>;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT',  () => gracefulExit('SIGINT'));
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

  await startScrape();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Scrape flow
// ═══════════════════════════════════════════════════════════════════════════
async function startScrape(): Promise<void> {
  // ── 0. Load global config ─────────────────────────────────────────────
  const appCfg = readConfig();
  // Apply log level from config (allows runtime override without env vars)
  logger.level = appCfg.logLevel;

  // ── 1. Ask for the entry URL upfront so we can look up the profile ────
  //    before launching the full config wizard.
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
    // Backfill the entry URL into whichever field the config wizard uses
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

  // ── 4. Apply waitUntil from appCfg to chapter.ts via env (simple bridge)
  // Sequential + TOC scrapers read waitUntil directly from appCfg below.

  // ── 5. Launch browser ─────────────────────────────────────────────────
  const browser = await getBrowser({
    headless        : appCfg.headless,
    humanize        : appCfg.humanize,
    humanPreset     : appCfg.humanPreset,
    fingerprintSeed : appCfg.fingerprintSeed,
    timezone        : 'America/New_York',
    locale          : appCfg.defaultLanguage === 'en' ? 'en-US' : appCfg.defaultLanguage,
  });

  try {
    // ── 6. URL collection ────────────────────────────────────────────────
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

    // ── 7. Chapter list review ────────────────────────────────────────────
    chapterUrls = await editChapterLinks(chapterUrls);
    if (chapterUrls.length === 0) {
      disp.warn('No chapters left — nothing to scrape.');
      process.exit(0);
    }
    disp.success(`${chalk.cyan(String(chapterUrls.length))} chapters confirmed — starting scrape`);

    // ── 8. Scraping ───────────────────────────────────────────────────────
    disp.section('⚡  Step 2 / 3 — Scraping Chapters');
    const { chapters, errors } = await runScrapeQueue(
      browser,
      chapterUrls,
      config,
      cookies.length ? cookies : undefined,
      appCfg,
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

    // ── 9. EPUB ────────────────────────────────────────────────────────────
    disp.section('📦  Step 3 / 3 — Building EPUB');
    const outputPath = await buildEpub(
      chapters, config.metadata, config.outputDir, config.outputFilename,
    );

    // ── 10. Summary ────────────────────────────────────────────────────────
    const totalWords = chapters.reduce((s, ch) => s + ch.wordCount, 0);
    disp.summary({
      title   : config.metadata.title,
      chapters: chapters.length,
      words   : totalWords,
      timeMs  : Date.now() - startMs,
      output  : outputPath,
      errors  : errors.length,
    });

    // ── 11. Post-scrape: offer to save site profile ────────────────────────
    if (domain && isNewDomain && appCfg.askSaveProfile) {
      const partial: Omit<SiteProfile, 'domain' | 'label' | 'notes' | 'savedAt' | 'updatedAt'> = {
        method           : config.method,
        contentSelector  : config.contentSelector,
        separateTitle    : config.separateTitle,
        titleSelector    : config.titleSelector,
        excludeSelectors : config.excludeSelectors,
        nextButtonLocators: config.nextButtonLocators,
        concurrency      : config.concurrency  !== appCfg.defaultConcurrency ? config.concurrency  : undefined,
        delayMin         : config.delayMin     !== appCfg.defaultDelayMin    ? config.delayMin     : undefined,
        delayMax         : config.delayMax     !== appCfg.defaultDelayMax    ? config.delayMax     : undefined,
      };
      await promptSaveProfile(domain, partial);
    }

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
