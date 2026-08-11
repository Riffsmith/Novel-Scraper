// ─────────────────────────────────────────────────────────────────────────────
//  runJob — composition root: wires adapters into core, runs a full scrape.
//  JobConfig → ScrapeResult.
// ─────────────────────────────────────────────────────────────────────────────

import { PlaywrightBrowserPort } from "../adapters/browser-playwright/PlaywrightBrowserPort.js";
import { JsonSessionStore } from "../adapters/store-json/JsonSessionStore.js";
import { ArchiverEpubWriter } from "../adapters/epub-archiver/ArchiverEpubWriter.js";
import { NoopUIAdapter } from "../adapters/ui-noop/NoopUIAdapter.js";
import { createWinstonLogger } from "../adapters/logger-winston/WinstonLogger.js";

import { ScrapeService } from "../core/services/ScrapeService.js";
import { discoverJobChapters } from "../core/services/DiscoveryService.js";

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
    job.chapterLinks = await discoverJobChapters(job, { browser, cookies, ui, log });
  }

  const scrapeService = new ScrapeService({
    browser,
    sessions,
    epub,
    ui,
    log,
  });

  // Pipeline Phase 3: forward job.volumes to ScrapeService.run so the auto
  // flow's AutoScrapeResult.volumes flows through to EpubWriter at build time.
  // On resume, ScrapeService.run resolves session.volumes (if set) and
  // overrides the caller arg - the session checkpoint is the resume source
  // of truth. When job.volumes is undefined (manual flow / YAML job files /
  // flat-catalog adapters wtr-lab + novelfire), ScrapeService.run passes
  // undefined -> EpubWriter's no-volumes path runs byte-identical to today.
  return scrapeService.run(job, cookies, resume, job.volumes);
}