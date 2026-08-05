// ─────────────────────────────────────────────────────────────────────────────
//  DiscoveryService - the discovery-only half of `runJob` (ADR-P4-B).
//
//  `app/runJob.ts` originally did discovery+scrape in one call. Phase 4's TUI
//  needs to discover-and-return the chapter URL list so the ChapterListScreen
//  can review/edit between discovery and scrape (readme §1.10 / §2.8). This
//  service extracts that block verbatim:
//    - launch a browser
//    - create one context (with cookies)
//    - run ChapterListService.discoverTOC or collectSequential depending on
//      `job.method`
//    - close the context and the browser
//    - return the URL list
//
//  No behaviour change to runJob: that composition root keeps calling this
//  service and then handing the result to ScrapeService - exactly the same
//  sequence as before, only the boundary moved. ADR-P4-B records that the TUI
//  and Phase 5 CLI both reuse this seam so there is no duplicate discovery
//  fork.
// ─────────────────────────────────────────────────────────────────────────────

import { ChapterListService } from "./ChapterListService.js";

import type { JobConfig } from "../domain/JobConfig.js";
import type { DomainCookie } from "../domain/Cookie.js";
import type { BrowserPort } from "../../ports/BrowserPort.js";
import type { UIAdapter } from "../../ports/UIAdapter.js";
import type { Logger } from "../../ports/Logger.js";

export interface DiscoveryResult {
  urls: string[];
}

/**
 * Run discovery over a job's TOC or sequential scheme and return the chapter
 * URL list (in correct reading order). The caller is responsible for any
 * session/resume handling: this service is the *fresh* discovery path.
 *
 * `job.chapterLinks`, if already set, is returned as-is - matching runJob's
 * original "skip discovery if the caller pre-resolved links" behaviour.
 */
export async function discoverJobChapters(
  job: JobConfig,
  deps: { browser: BrowserPort; cookies: DomainCookie[]; ui: UIAdapter; log: Logger },
): Promise<string[]> {
  if (job.chapterLinks && job.chapterLinks.length > 0) {
    return job.chapterLinks;
  }

  const browserHandle = await deps.browser.launch({
    headless: job.headless,
    humanize: false,
    humanPreset: "default",
    fingerprintSeed: null,
    timezone: "America/New_York",
    locale: "en-US",
  });

  try {
    const ctx = await deps.browser.createContext(browserHandle, deps.cookies);
    const page = await deps.browser.newPage(ctx);
    const listService = new ChapterListService(deps.log, deps.ui);

    let urls: string[];
    if (job.method === "toc" && job.tocUrl) {
      urls = await listService.discoverTOC(page, job.tocUrl, "domcontentloaded", 30_000);
    } else if (
      job.method === "sequential" &&
      job.firstChapterUrl &&
      job.lastChapterUrl &&
      job.nextButtonLocators
    ) {
      urls = await listService.collectSequential(
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
    return urls;
  } finally {
    await browserHandle.close();
  }
}
