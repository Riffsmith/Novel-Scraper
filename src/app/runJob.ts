// ─────────────────────────────────────────────────────────────────────────────
//  runJob — composition root: wires adapters into core, runs a full scrape.
//  JobConfig → ScrapeResult.
// ─────────────────────────────────────────────────────────────────────────────

import { PlaywrightBrowserPort } from "../adapters/browser-playwright/PlaywrightBrowserPort.js";
import { JsonSessionStore } from "../adapters/store-json/JsonSessionStore.js";
import { ArchiverEpubWriter } from "../adapters/epub-archiver/ArchiverEpubWriter.js";
import { NoopUIAdapter } from "../adapters/ui-noop/NoopUIAdapter.js";
import { createWinstonLogger } from "../adapters/logger-winston/WinstonLogger.js";

import { ChapterListService } from "../core/services/ChapterListService.js";
import { ScrapeService } from "../core/services/ScrapeService.js";

import type { JobConfig, ScrapeResult } from "../core/domain/JobConfig.js";
import type { ScrapeSession } from "../core/domain/Session.js";
import type { DomainCookie } from "../core/domain/Cookie.js";
import type { UIAdapter } from "../ports/UIAdapter.js";
import type { Logger } from "../ports/Logger.js";

export interface RunJobOptions {
  log: Logger;
  ui?: UIAdapter;
  cookies?: DomainCookie[];
  resumeSessionId?: string;
}

export async function runJob(
  job: JobConfig,
  opts: RunJobOptions,
): Promise<ScrapeResult> {
  const log = opts.log;
  const ui = opts.ui ?? new NoopUIAdapter();

  const browser = new PlaywrightBrowserPort();
  const sessions = new JsonSessionStore(log);
  const epub = new ArchiverEpubWriter(log);

  const cookies = opts.cookies ?? [];

  let resume: { session: ScrapeSession } | undefined;
  if (opts.resumeSessionId) {
    const session = await sessions.load(opts.resumeSessionId);
    if (session) {
      resume = { session };
      log.info(`Resuming session: ${session.id} — ${session.completedChapters.length} chapters already done`);
    }
  }

  if (resume) {
    job.chapterLinks = resume.session.chapterUrls;
  }

  if (!job.chapterLinks && !resume) {
    const browserHandle = await browser.launch({
      headless: job.headless,
      humanize: false,
      humanPreset: "default",
      fingerprintSeed: null,
      timezone: "America/New_York",
      locale: "en-US",
    });

    try {
      const ctx = await browser.createContext(browserHandle, cookies);
      const page = await browser.newPage(ctx);
      const listService = new ChapterListService(log, ui);

      if (job.method === "toc" && job.tocUrl) {
        job.chapterLinks = await listService.discoverTOC(
          page,
          job.tocUrl,
          "domcontentloaded",
          30_000,
        );
      } else if (
        job.method === "sequential" &&
        job.firstChapterUrl &&
        job.lastChapterUrl &&
        job.nextButtonLocators
      ) {
        job.chapterLinks = await listService.collectSequential(
          page,
          job.firstChapterUrl,
          job.lastChapterUrl,
          job.nextButtonLocators,
          job.delayMin,
          job.delayMax,
          "domcontentloaded",
          30_000,
        );
      } else {
        throw new Error("Invalid discovery config");
      }

      await page.close();
      await ctx.close();
    } finally {
      await browserHandle.close();
    }
  }

  const scrapeService = new ScrapeService({
    browser,
    sessions,
    epub,
    ui,
    log,
  });

  return scrapeService.run(job, cookies, resume);
}