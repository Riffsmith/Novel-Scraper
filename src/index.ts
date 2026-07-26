#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  WebNovel Scraper  —  main entry point
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";
import type { Browser, Cookie } from "playwright";
import logger from "./logger/index.js";
import * as disp from "./tui/display.js";
import {
  gatherConfig,
  gatherAutoConfig,
  buildQuickAutoConfig,
  editChapterLinks,
} from "./tui/prompts.js";
import { manageCookies, selectCookieProfileForScrape } from "./tui/cookieManager.js";
import { reportError, reportNotice } from "./tui/errors.js";
import { manageSettings, promptSaveProfile } from "./tui/configManager.js";
import {
  getBrowser,
  closeBrowser,
  closeAllBrowsers,
  createStealthContext,
  createPage,
} from "./scraper/browser.js";
import { scrapeTOC } from "./scraper/toc.js";
import { collectLinksSequentially } from "./scraper/sequential.js";
import { runScrapeQueue } from "./queue/index.js";
import { buildEpub } from "./epub/builder.js";
import { readConfig } from "./config/appConfig.js";
import {
  loadProfile,
  hasProfile,
  normaliseDomain,
} from "./config/siteProfiles.js";
import { SITE_ADAPTERS, findSiteAdapter } from "./sites/index.js";
import type { AutoScrapeResult } from "./sites/types.js";
import type { AppConfig, ScraperConfig, SiteProfile } from "./types.js";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require("enquirer");
async function prompt<T extends Record<string, unknown>>(
  q: object,
): Promise<T> {
  return _prompt(q) as Promise<T>;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("unhandledRejection", (reason) => {
  const err = reason as NodeJS.ErrnoException;
  if (err?.code === "ERR_USE_AFTER_CLOSE") {
    // Known enquirer + newer-Node readline race: a stray keystroke fired
    // after a prompt's readline interface had already closed. Harmless —
    // just means one keypress got dropped. Log it quietly and move on
    // instead of letting it derail the current screen.
    logger.debug(
      "Ignored benign ERR_USE_AFTER_CLOSE from enquirer readline race",
    );
    return;
  }
  logger.error("Unhandled rejection", { error: err });
});
process.on("SIGTERM", () => gracefulExit("SIGTERM"));
process.on("uncaughtException", (e: Error) => {
  logger.error("Uncaught exception", { error: e });
  gracefulExit("uncaughtException");
});

let shuttingDown = false;
async function gracefulExit(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.yellow(`\n\n  [${reason}] Shutting down gracefully…`));
  // closeAllBrowsers() closes the scraping singleton AND any still-open
  // ephemeral (cookie-capture) browser, so Ctrl+C mid-login can't orphan a
  // Chromium process.
  await closeAllBrowsers().catch(() => {});
  process.exit(0);
}

function hostnameFrom(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Top-level menu
// ═══════════════════════════════════════════════════════════════════════════
async function mainMenu(): Promise<void> {
  disp.banner();

  const { action } = await prompt<{ action: string }>({
    type: "select",
    name: "action",
    message: "What would you like to do?",
    choices: [
      { name: "scrape", message: "Start a new scrape and build an EPUB" },
      { name: "cookies", message: "Manage saved cookies" },
      { name: "settings", message: "Settings and site profiles" },
      { name: "quit", message: chalk.dim("Quit") },
    ],
  });

  if (action === "quit") {
    console.log(chalk.dim("\n  Goodbye!\n"));
    process.exit(0);
  }
  if (action === "cookies") {
    await manageCookies();
    return mainMenu();
  }
  if (action === "settings") {
    await manageSettings();
    return mainMenu();
  }

  // ── Scrape sub-menu: auto vs manual ────────────────────────────────────
  disp.section("New Scrape");
  const { mode } = await prompt<{ mode: string }>({
    type: "select",
    name: "mode",
    message: "How do you want to set this scrape up?",
    choices: [
      {
        name: "auto",
        message:
          "Auto — paste a novel URL; on a supported site this usually takes just two confirmations",
      },
      {
        name: "manual",
        message: "Manual — configure every selector and setting yourself",
      },
    ],
  });

  if (mode === "auto") return startAutoScrape();
  return startScrape();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared tail — run the queue, build the EPUB, print summary, offer to
//  save a site profile. Used by both the manual and auto scrape flows.
// ═══════════════════════════════════════════════════════════════════════════
async function scrapeAndPackage(
  browser: Browser,
  chapterUrls: string[],
  config: ScraperConfig,
  cookies: Cookie[],
  appCfg: AppConfig,
  domain: string,
  isNewDomain: boolean,
  startMs: number,
): Promise<void> {
  disp.section("Scraping Chapters");
  const { chapters, errors } = await runScrapeQueue(
    browser,
    chapterUrls,
    config,
    cookies.length ? cookies : undefined,
    appCfg,
  );

  if (chapters.length === 0) {
    disp.err("No chapters were scraped successfully.");
    disp.dim(
      `Double-check the content selector — it did not match anything: "${config.contentSelector}"`,
    );
    process.exit(1);
  }
  if (errors.length > 0) {
    disp.warn(`${errors.length} chapter(s) could not be scraped:`);
    errors.forEach((e) => disp.dim(`  ${e.url}  →  ${e.error}`));
  }

  disp.section("Building EPUB");
  const outputPath = await buildEpub(
    chapters,
    config.metadata,
    config.outputDir,
    config.outputFilename,
  );

  const totalWords = chapters.reduce((s, ch) => s + ch.wordCount, 0);
  disp.summary({
    title: config.metadata.title,
    chapters: chapters.length,
    words: totalWords,
    timeMs: Date.now() - startMs,
    output: outputPath,
    errors: errors.length,
  });

    if (domain && isNewDomain && appCfg.askSaveProfile) {
    const partial: Omit<
      SiteProfile,
      "domain" | "label" | "notes" | "savedAt" | "updatedAt"
    > = {
      method: config.method,
      contentSelector: config.contentSelector,
      separateTitle: config.separateTitle,
      titleSelector: config.titleSelector,
      excludeSelectors: config.excludeSelectors,
      nextButtonLocators: config.nextButtonLocators,
      concurrency:
        config.concurrency !== appCfg.defaultConcurrency
          ? config.concurrency
          : undefined,
      delayMin:
        config.delayMin !== appCfg.defaultDelayMin
          ? config.delayMin
          : undefined,
      delayMax:
        config.delayMax !== appCfg.defaultDelayMax
          ? config.delayMax
          : undefined,
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
  disp.section("Entry URL");
  disp.dim(
    "Enter the URL you plan to scrape — either the table-of-contents page or the first chapter.",
  );
  disp.dim(
    "This URL is used to look up any saved site profile for the domain, so selectors and performance settings can be pre-filled.",
  );
  console.log("");

  const { entryUrl } = await prompt<{ entryUrl: string }>({
    type: "input",
    name: "entryUrl",
    message: "Entry URL:",
    validate: (v: string) => {
      try {
        new URL(v.trim());
        return true;
      } catch {
        return "Please enter a valid URL (include https://)";
      }
    },
  });

  const domain = hostnameFrom(entryUrl.trim());
  const profile = domain ? loadProfile(domain) : null;
  const isNewDomain = domain ? !hasProfile(domain) : false;

  if (profile) {
    logger.info(`Site profile matched for ${domain}`);
  }

  // ── 2. Gather full configuration (with pre-fills from profile) ─────────
  let config;
  try {
    config = await gatherConfig(appCfg, profile);
    if (config.method === "toc" && !config.tocUrl) {
      config.tocUrl = entryUrl.trim();
    } else if (config.method === "sequential" && !config.firstChapterUrl) {
      config.firstChapterUrl = entryUrl.trim();
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = (e as Error).message ?? "";
    if (
      code === "ERR_USE_AFTER_CLOSE" ||
      msg.includes("cancelled") ||
      msg.includes("canceled")
    ) {
      console.log(chalk.yellow("\n  Cancelled — goodbye!\n"));
      process.exit(0);
    }
    throw e;
  }

  logger.info("Configuration confirmed", {
    method: config.method,
    title: config.metadata.title,
    domain,
  });

  const startMs = Date.now();

  // ── 3. Resolve which cookie profile to use for the domain ──────────────
  // Zero profiles → nothing to do, zero prompts. One profile → auto-loaded,
  // zero prompts. Two or more → asks which one (or "none"). All status
  // messaging lives inside selectCookieProfileForScrape.
  let cookies: Cookie[] = [];
  if (domain) {
    const selection = await selectCookieProfileForScrape(domain);
    cookies = selection.cookies;
  }

  // ── 4. Launch browser ─────────────────────────────────────────────────
  const browser = await getBrowser({
    headless: appCfg.headless,
    humanize: appCfg.humanize,
    humanPreset: appCfg.humanPreset,
    fingerprintSeed: appCfg.fingerprintSeed,
    timezone: "America/New_York",
    locale: appCfg.defaultLanguage === "en" ? "en-US" : appCfg.defaultLanguage,
  });

  try {
    // ── 5. URL collection ────────────────────────────────────────────────
    let chapterUrls: string[] = [];

    if (config.method === "toc") {
      disp.section("Step 1 of 3 — Table of Contents");
      chapterUrls = await scrapeTOC(
        browser,
        config.tocUrl!,
        cookies.length ? cookies : undefined,
        appCfg.waitUntil,
        appCfg.navigationTimeoutMs,
      );
      if (chapterUrls.length === 0) {
        disp.err("No chapter links found on the TOC page.");
        disp.dim(
          "Tip: check the URL, or add session cookies via the Cookie Manager.",
        );
        process.exit(1);
      }
    } else {
      disp.section("Step 1 of 3 — Sequential URL Collection");
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
        disp.err(
          "No URLs collected. Check your chapter URLs and next-button locator.",
        );
        process.exit(1);
      }
    }

    // ── 6. Chapter list review ────────────────────────────────────────────
    chapterUrls = await editChapterLinks(chapterUrls);
    if (chapterUrls.length === 0) {
      disp.warn("No chapters left — nothing to scrape.");
      process.exit(0);
    }
    disp.success(
      `${chalk.cyan(String(chapterUrls.length))} chapters confirmed — starting scrape`,
    );

    // ── 7. Scrape + package ────────────────────────────────────────────────
    await scrapeAndPackage(
      browser,
      chapterUrls,
      config,
      cookies,
      appCfg,
      domain,
      isNewDomain,
      startMs,
    );
  } finally {
    await closeBrowser();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Auto scrape flow — driven by a SiteAdapter
//
//  Quality-of-life goal: on a supported site, a person should be able to
//  paste a novel URL and reach a running scrape after exactly two
//  confirmations:
//    1. "Use these auto-detected settings and continue?"
//    2. "Start scraping N chapters now?"
//  Declining the first confirmation drops into the full customization
//  wizard (chapter list review + gatherAutoConfig) for anyone who wants to
//  change selectors, metadata, output location, or performance settings
//  before running. That path ends with its own single confirmation, so it
//  never asks fewer questions than the person actually wants to answer —
//  it just isn't the default.
// ═══════════════════════════════════════════════════════════════════════════
async function startAutoScrape(): Promise<void> {
  const appCfg = readConfig();
  logger.level = appCfg.logLevel;

  disp.section("Auto Scrape — Novel URL");
  disp.dim("Paste the URL of the novel's main page (not the chapter list).");
  disp.dim(`Supported sites: ${SITE_ADAPTERS.map((a) => a.label).join(", ")}`);
  console.log("");

  const { novelUrl } = await prompt<{ novelUrl: string }>({
    type: "input",
    name: "novelUrl",
    message: "Novel URL:",
    validate: (v: string) => {
      try {
        new URL(v.trim());
        return true;
      } catch {
        return "Please enter a valid URL (include https://)";
      }
    },
  });

  const trimmedUrl = novelUrl.trim();
  const adapter = findSiteAdapter(trimmedUrl);

  if (!adapter) {
    disp.err("This site is not supported for auto-scraping yet.");
    disp.dim(
      `Currently supported: ${SITE_ADAPTERS.map((a) => a.label).join(", ")}`,
    );
    const { fallback } = await prompt<{ fallback: boolean }>({
      type: "confirm",
      name: "fallback",
      message: "Switch to manual setup instead?",
      initial: true,
    });
    return fallback ? startScrape() : mainMenu();
  }

  const domain = hostnameFrom(trimmedUrl);
  const profile = domain ? loadProfile(domain) : null;
  const isNewDomain = domain ? !hasProfile(domain) : false;

  // ── Resolve which cookie profile to use for the domain ───────────────
  const selection = domain
    ? await selectCookieProfileForScrape(domain)
    : { profileName: null as string | null, cookies: [] as Cookie[] };
  const cookies: Cookie[] = selection.cookies;

  const browser = await getBrowser({
    headless: appCfg.headless,
    humanize: appCfg.humanize,
    humanPreset: appCfg.humanPreset,
    fingerprintSeed: appCfg.fingerprintSeed,
    timezone: "America/New_York",
    locale: appCfg.defaultLanguage === "en" ? "en-US" : appCfg.defaultLanguage,
  });

  let auto: AutoScrapeResult;

  try {
    const context = await createStealthContext(
      browser,
      cookies.length ? cookies : undefined,
    );
    const page = await createPage(context);

    const spin1 = disp.spinner(
      `Fetching novel metadata from ${adapter.label}…`,
    );
    let metadata;
    try {
      metadata = await adapter.scrapeMetadata(page, trimmedUrl);
      spin1.succeed(
        `Metadata fetched: "${metadata.title}" by ${metadata.author}`,
      );
    } catch (e) {
      spin1.fail("Metadata fetch failed");
      await context.close();
      throw e;
    }

    const spin2 = disp.spinner(
      "Collecting chapter links (this can take a while on long novels)…",
    );
    let chapterLinks: string[];
    try {
      chapterLinks = await adapter.scrapeChapterLinks(page, trimmedUrl, {
        waitUntil: appCfg.waitUntil,
        navTimeoutMs: appCfg.navigationTimeoutMs,
      });
      spin2.succeed(`Collected ${chapterLinks.length} chapter link(s)`);
    } catch (e) {
      spin2.fail("Chapter link collection failed");
      await context.close();
      throw e;
    }

    await context.close();
    auto = { siteId: adapter.id, novelUrl: trimmedUrl, metadata, chapterLinks };
  } catch (e) {
    await reportError("Auto-scrape failed", e);
    await closeBrowser();
    return mainMenu();
  }

  if (auto.chapterLinks.length === 0) {
    await reportNotice([
      "No chapter links were found. The page structure on this site may have changed.",
    ]);
    await closeBrowser();
    return mainMenu();
  }

  // ── Scan summary + first confirmation ───────────────────────────────────
  disp.section("Scan Complete");
  disp.success(
    `Detected "${auto.metadata.title}" by ${auto.metadata.author || "an unknown author"}`,
  );
  disp.info(
    `Chapters found  : ${chalk.cyan(String(auto.chapterLinks.length))}`,
  );
  disp.dim(`  first: ${auto.chapterLinks[0]}`);
  disp.dim(`  last : ${auto.chapterLinks[auto.chapterLinks.length - 1]}`);
  disp.info(
    `Content selector: ${chalk.cyan(profile?.contentSelector ?? adapter.defaultContentSelector)} ${profile ? chalk.dim("(from saved profile)") : chalk.dim("(site default)")}`,
  );
  disp.info(
    `Cover image     : ${auto.metadata.coverUrl ? chalk.cyan("found automatically") : chalk.dim("none found")}`,
  );
  console.log("");
  disp.dim(
    "These settings were filled in automatically from the site and any saved profile for this domain.",
  );
  console.log("");

  const { useDefaults } = await prompt<{ useDefaults: boolean }>({
    type: "confirm",
    name: "useDefaults",
    message: "Use these settings as-is and continue?",
    initial: true,
  });

  let config: ScraperConfig;

  if (useDefaults) {
    // Fast path: the only remaining step is the "start scraping" confirmation below.
    config = buildQuickAutoConfig(appCfg, profile, adapter, auto);
  } else {
    // Full customization path: review the chapter list, then walk through every setting.
    disp.section("Review Chapter List");
    auto.chapterLinks = await editChapterLinks(auto.chapterLinks);
    if (auto.chapterLinks.length === 0) {
      await reportNotice(["No chapters left to scrape."]);
      await closeBrowser();
      return mainMenu();
    }

    try {
      config = await gatherAutoConfig(appCfg, profile, adapter, auto);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      const msg = (e as Error).message ?? "";
      if (
        code === "ERR_USE_AFTER_CLOSE" ||
        msg.includes("cancelled") ||
        msg.includes("canceled")
      ) {
        console.log(chalk.yellow("\n  Cancelled — goodbye!\n"));
        await closeBrowser();
        process.exit(0);
      }
      await closeBrowser();
      throw e;
    }
  }

  logger.info("Auto-scrape configuration confirmed", {
    site: adapter.id,
    title: config.metadata.title,
    domain,
    quickPath: useDefaults,
  });

  // ── Second confirmation — only needed on the fast path.
  //    gatherAutoConfig() already asked its own final confirmation on the
  //    customization path, so we don't ask twice there. ─────────────────
  if (useDefaults) {
    disp.section("Ready to Scrape");
    disp.info(
      `Output file : ${chalk.cyan(`${config.outputDir}/${config.outputFilename}`)}`,
    );
    disp.info(
      `Concurrency : ${chalk.cyan(String(config.concurrency))}   Delay: ${chalk.cyan(`${config.delayMin}-${config.delayMax}`)} ms`,
    );
    console.log("");

    const { confirmed } = await prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message: `Start scraping ${chalk.cyan(String(auto.chapterLinks.length))} chapters now?`,
      initial: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow("\n  Cancelled by user.\n"));
      await closeBrowser();
      return mainMenu();
    }
  }

  const startMs = Date.now();

  try {
    await scrapeAndPackage(
      browser,
      auto.chapterLinks,
      config,
      cookies,
      appCfg,
      domain,
      isNewDomain,
      startMs,
    );
  } finally {
    await closeBrowser();
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
mainMenu().catch(async (e) => {
  logger.error("Fatal error", { error: e });
  disp.err(`Fatal: ${(e as Error).message}`);
  disp.dim("See logs/error.log for full details.");
  await closeAllBrowsers().catch(() => {});
  process.exit(1);
});
