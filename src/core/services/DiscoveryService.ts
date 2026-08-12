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
//
//  Challenge wait-out (fix-issue-tui-url-cleanliness §3.5.2):
//    The discovery phase used to silently break the walk on the first stuck
//    security challenge and close the browser without retrying - the user got
//    back a one-URL (or zero-URL) list with no chance to wait it out. The
//    scrape phase's existing `SecurityChallengeError` + 45 s backoff path
//    (`ScrapeService.ts:233-275`) is mirrored here: a stuck challenge during a
//    discovery attempt triggers a fresh browser relaunch + inter-attempt
//    backoff, up to `DISCOVERY_MAX_RETRIES`. A fresh browser context gets a
//    fresh TLS session + fingerprint seed, which is the documented behavioural
//    contract for a transient challenge. The existing `ChapterExtractor` +
//    `SecurityChallengeError` machinery is reused verbatim - no new challenge
//    detection logic is invented.
// ─────────────────────────────────────────────────────────────────────────────

import { ChapterListService } from "./ChapterListService.js";
import { ChapterExtractor } from "./ChapterExtractor.js";
import { SecurityChallengeError } from "../errors.js";

import type { JobConfig } from "../domain/JobConfig.js";
import type { DomainCookie } from "../domain/Cookie.js";
import type { BrowserPort } from "../../ports/BrowserPort.js";
import type { UIAdapter } from "../../ports/UIAdapter.js";
import type { Logger } from "../../ports/Logger.js";

const DISCOVERY_MAX_RETRIES = 3;
const DISCOVERY_CHALLENGE_BACKOFF_MS = 45_000;

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
 *
 * On a stuck security challenge, the discovery attempts up to
 * `DISCOVERY_MAX_RETRIES` fresh-browser relaunches with
 * `DISCOVERY_CHALLENGE_BACKOFF_MS` inter-attempt backoff (mirroring
 * `ScrapeService.ts:233-275`). Non-challenge errors bubble immediately.
 */
export async function discoverJobChapters(
  job: JobConfig,
  deps: { browser: BrowserPort; cookies: DomainCookie[]; ui: UIAdapter; log: Logger },
): Promise<string[]> {
  if (job.chapterLinks && job.chapterLinks.length > 0) {
    return job.chapterLinks;
  }

  const extractor = new ChapterExtractor(deps.log);
  let attempt = 0;

  while (true) {
    attempt++;
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
      const listService = new ChapterListService(deps.log, deps.ui, extractor);

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
    } catch (e) {
      const isChallenge = e instanceof SecurityChallengeError;
      if (isChallenge && attempt <= DISCOVERY_MAX_RETRIES) {
        const backoff = attempt * DISCOVERY_CHALLENGE_BACKOFF_MS;
        deps.ui.emit({
          type: "challenge.waiting",
          url: job.firstChapterUrl ?? job.tocUrl ?? "",
        });
        deps.log.warn(
          `Security challenge during discovery (attempt ${attempt}/${DISCOVERY_MAX_RETRIES}) - retrying after ${backoff}ms`,
        );
        await delay(backoff);
        continue;
      }
      throw e;
    } finally {
      await browserHandle.close();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
