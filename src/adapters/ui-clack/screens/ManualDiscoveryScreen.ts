// ─────────────────────────────────────────────────────────────────────────────
//  ManualDiscoveryScreen - discovery-only coordinator (readme §1.10 / §2.8).
//
//  Pushed by ManualWizardScreen after the wizard produces a JobConfig with
//  empty `chapterLinks`. Runs discovery via the shared `discoverJobChapters`
//  helper (ADR-P4-B - the same seam runJob uses), then:
//    - on empty result: the v1 "No chapter links found" / "No URLs collected"
//      notice and pop
//    - on success: replace with ChapterListScreen([{ urls, job, cookies }]);
//      ChapterListScreen on "proceed" pushes TaskScreen(job, editedUrls,
//      cookies, domain, isNewDomain)
//
//  Cookie resolution happens here once (v1 index.ts:476-484) so the discovery
//  browser context attaches the same cookies the scrape will, and TaskScreen
//  gets them passed in (no double-prompt).
// ─────────────────────────────────────────────────────────────────────────────

import { discoverJobChapters } from "../../../core/services/DiscoveryService.js";
import { ClackUIAdapter } from "../ClackUIAdapter.js";
import { resolveCookiesForScrape } from "../scope.js";
import * as fmt from "../format.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { DomainCookie } from "../../../core/domain/Cookie.js";
import type { JobConfig } from "../../../core/domain/JobConfig.js";

export interface ManualDiscoveryParams {
  job: JobConfig;
  domain: string;
  isNewDomain: boolean;
}

export class ManualDiscoveryScreen implements Screen {
  readonly id = "manual-discovery";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const { job, domain, isNewDomain } = params as ManualDiscoveryParams;
    const cookies: DomainCookie[] = domain ? await resolveCookiesForScrape(ctx.prompt, ctx.cookies, domain) : [];

    ctx.prompt.log("info", fmt.section(job.method === "toc" ? "Table of Contents" : "Sequential URL Collection"));
    const ui = new ClackUIAdapter(ctx.prompt);

    let urls: string[];
    try {
      urls = await discoverJobChapters(job, {
        browser: ctx.browser,
        cookies,
        ui,
        log: ctx.log,
      });
    } catch (e) {
      ctx.prompt.log("error", `Discovery failed: ${(e as Error).message}`);
      await ctx.prompt.text({ message: "Press Enter to return..." }).catch(() => {});
      return { action: "pop" };
    }

    if (urls.length === 0) {
      if (job.method === "toc") {
        ctx.prompt.log("error", "No chapter links found on the TOC page.");
        ctx.prompt.log("dim", "Tip: check the URL, or add session cookies via the Cookie Manager.");
      } else {
        ctx.prompt.log("error", "No URLs collected. Check your chapter URLs and next-button locator.");
      }
      await ctx.prompt.text({ message: "Press Enter to return..." }).catch(() => {});
      return { action: "pop" };
    }

    ctx.prompt.log("success", `Discovered ${urls.length} chapter URL(s).`);
    return {
      action: "replace",
      screen: "chapter-list",
      params: { urls, job, cookies, domain, isNewDomain, manual: true },
    };
  }
}
