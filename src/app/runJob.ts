// ─────────────────────────────────────────────────────────────────────────────
//  runJob — composition root: wires adapters into core, runs a full scrape.
//  JobConfig → ScrapeResult.
// ─────────────────────────────────────────────────────────────────────────────

import { PlaywrightBrowserPort } from "../adapters/browser-playwright/PlaywrightBrowserPort.js";
import { JsonSessionStore } from "../adapters/store-json/JsonSessionStore.js";
import { JsonNovelRegistryStore } from "../adapters/store-json/JsonNovelRegistryStore.js";
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
  const registry = new JsonNovelRegistryStore(log);

  const cookies = opts.cookies ?? [];

  let resume: { session: ScrapeSession } | undefined;
  if (opts.resumeSessionId) {
    const session = await sessions.load(opts.resumeSessionId);
    if (session) {
      resume = { session };
      log.info(`Resuming session: ${session.id} — ${session.completedChapters.length} chapters already done`);
    }
  } else {
    // Auto-resume (issue 3): when the user re-runs `wnscrape run --job foo.yaml`
    // WITHOUT `--resume`, look for an existing in-progress checkpoint whose
    // entry URL matches this job's natural entry key (tocUrl for toc-method,
    // firstChapterUrl for sequential) and resume from it. This means any
    // interrupted scrape — Ctrl+Q, crash, network drop — just works on the
    // next run without the user ever needing `--resume`. The lookup is on
    // `entryUrl` (recorded on the session at first-run time, mirroring the
    // TUI's NewScrapeScreen `findByEntryUrl` matching path). The first-run
    // session is now always persisted by ScrapeService.run, so the user no
    // longer has to opt into resumability.
    const entryUrl = job.tocUrl || job.firstChapterUrl || "";
    if (entryUrl) {
      const existing = await sessions.findByEntryUrl(entryUrl);
      if (existing) {
        resume = { session: existing };
        log.info(
          `Auto-resuming existing session: ${existing.id} — ${existing.completedChapters.length}/${existing.chapterUrls.length} chapters already done`,
        );
      }
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
    registry,
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