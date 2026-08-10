// ─────────────────────────────────────────────────────────────────────────────
//  AutoProbeScreen - adapter probe + confirm #1 + route fast/customize
//  (readme §2.5). Pushed by NewScrapeScreen on `auto`.
//
//  Behavior ported from v1 `startAutoScrape` (src/index.ts:579-846):
//    - find adapter by `matches(entryUrl)`; if none, offer manual fallback
//    - resolve cookies once (v1 :649-652) and pass them to the probe context
//    - probe: spinner "fetching metadata" -> scrapeMetadata; spinner
//      "collecting chapter links" -> scrapeChapterLinks; close the probe
//      context when done
//    - render the §1.3 scan summary (title/author/chapters/first/last/content
//      selector/cover)
//    - confirm #1 "use these as-is and continue?":
//        - yes  -> build *quick* JobConfig (buildQuickAutoConfig port, zero
//                  prompts) -> confirm #2 "start N chapters now?" ->
//                  push TaskScreen(job, chapterLinks, cookies, domain, isNew)
//        - no   -> replace ChapterListScreen with nextScreen=auto-customize
//                  carrying the AutoScrapeResult + adapter + cookies + domain
//                  (readme §2.5: chapter-list review happens BEFORE the
//                  customize screen, matching v1 ordering index.ts:754-770)
//    - on zero chapter links: "No chapter links were found" notice + pop
//
//  The probe browser lifecycle is owned by THIS screen (not ScrapeService) -
//  it's an ephemeral context closed before the scrape browser starts, exactly
//  like v1 (:666-703). TaskScreen later launches its own browser via
//  ScrapeService.run.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import { resolveCookiesForScrape, launchOptionsForScrape } from "../scope.js";
import { findSiteAdapter } from "../../site-registry/index.js";
import * as fmt from "../format.js";
import { defaultFilenameFor } from "../validation.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { JobConfig } from "../../../core/domain/JobConfig.js";
import type {
  AutoNovelMetadata,
  AutoScrapeResult,
  SiteAdapter,
} from "../../../core/domain/SiteAdapter.js";
import type { SiteProfile } from "../../../ports/ProfileStore.js";
import type { DomainCookie } from "../../../core/domain/Cookie.js";
import type { NovelMetadata } from "../../../core/domain/NovelMetadata.js";
import type { NewScrapeCommonParams } from "./NewScrapeScreen.js";

export class AutoProbeScreen implements Screen {
  readonly id = "auto-probe";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const p = params as NewScrapeCommonParams;
    const appCfg = await ctx.config.read();
    const { entryUrl, domain, profile, isNewDomain } = p;
    const adapter = findSiteAdapter(entryUrl);

    // ── Unsupported-site fallback (v1 index.ts:605-616) ──────────────────────
    if (!adapter) {
      ctx.prompt.log(
        "error",
        "This site is not supported for auto-scraping yet.",
      );
      ctx.prompt.log(
        "dim",
        "Currently supported: novelfire.net, wtr-lab.com (add more via src/adapters/site-*/).",
      );
      const fallback = await ctx.prompt.confirm({
        message: "Switch to manual setup instead?",
        initial: true,
      });
      if (fallback === Cancel) return { action: "pop" };
      if (fallback) {
        return { action: "replace", screen: "manual-wizard", params: p };
      }
      return { action: "pop" };
    }

    // ── Resolve cookies once (v1 :649-652). The same DomainCookie[] feeds
    //    the probe context AND is passed through to TaskScreen / the
    //    customize path so neither re-prompts.
    const cookies: DomainCookie[] = domain
      ? await resolveCookiesForScrape(ctx.prompt, ctx.cookies, domain)
      : [];

    // ── Probe (v1 :663-709) ──────────────────────────────────────────────────
    let auto: AutoScrapeResult;
    const spin = ctx.prompt.spinner();
    try {
      spin.start(`Fetching novel metadata from ${adapter.label}...`);
      const browser = await ctx.browser.launch(
        launchOptionsForScrape(appCfg, {
          ...baseJobSeed,
          headless: appCfg.headless,
        }),
      );
      const context = await ctx.browser.createContext(
        browser,
        cookies.length ? cookies : undefined,
      );
      const page = await ctx.browser.newPage(context);

      let metadata: AutoNovelMetadata;
      try {
        metadata = await adapter.scrapeMetadata(page, entryUrl);
        spin.succeed(
          `Metadata fetched: "${metadata.title}" by ${metadata.author}`,
        );
      } catch (e) {
        spin.fail("Metadata fetch failed");
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        throw e;
      }

      spin.start(
        "Collecting chapter links (this can take a while on long novels)...",
      );
      let chapterLinks: string[];
      try {
        chapterLinks = await adapter.scrapeChapterLinks(page, entryUrl, {
          waitUntil: appCfg.waitUntil,
          navTimeoutMs: appCfg.navigationTimeoutMs,
        });
        spin.succeed(`Collected ${chapterLinks.length} chapter link(s)`);
      } catch (e) {
        spin.fail("Chapter link collection failed");
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        throw e;
      }

      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      auto = { siteId: adapter.id, novelUrl: entryUrl, metadata, chapterLinks };
    } catch (e) {
      ctx.prompt.log("error", `Auto-scrape failed: ${(e as Error).message}`);
      await ctx.prompt
        .text({ message: "Press Enter to return..." })
        .catch(() => {});
      return { action: "pop" };
    }

    if (auto.chapterLinks.length === 0) {
      ctx.prompt.log(
        "error",
        "No chapter links were found. The page structure on this site may have changed.",
      );
      await ctx.prompt
        .text({ message: "Press Enter to return..." })
        .catch(() => {});
      return { action: "pop" };
    }

    // ── Scan summary (v1 :719-739) ───────────────────────────────────────────
    renderScanSummary(ctx, auto, adapter, profile);

    // ── Confirm #1 (v1 :741-746) ──────────────────────────────────────────────
    const useDefaults = await ctx.prompt.confirm({
      message: "Use these settings as-is and continue?",
      initial: true,
    });
    if (useDefaults === Cancel) return { action: "pop" };

    if (useDefaults) {
      // Fast path: build quick JobConfig + the second confirm, then push
      // TaskScreen with the resolved cookies + chapterLinks (v1 :750-827).
      const job = buildQuickAutoConfig(appCfg, profile, adapter, auto);
      return fastPathConfirmStart(ctx, job, auto, cookies, isNewDomain);
    }

    // Customize path: chapter-list review FIRST (v1 :754-770), then the
    // AutoCustomizeScreen receives the (possibly-edited) chapter list.
    return {
      action: "replace",
      screen: "chapter-list",
      params: {
        urls: auto.chapterLinks,
        title: "Review Chapter List",
        nextScreen: "auto-customize",
        replaceParams: {
          auto,
          adapter,
          profile,
          cookies,
          domain,
          isNewDomain,
        },
      },
    };
  }
}

// ── Fast-path confirm #2 + TaskScreen push (v1 :805-827) ────────────────────
async function fastPathConfirmStart(
  ctx: ShellContext,
  job: JobConfig,
  auto: AutoScrapeResult,
  cookies: DomainCookie[],
  isNewDomain: boolean,
): Promise<ScreenResult> {
  ctx.prompt.log("info", fmt.section("Ready to Scrape"));
  ctx.prompt.log(
    "info",
    `Output file : ${job.outputDir}/${job.outputFilename}`,
  );
  ctx.prompt.log(
    "info",
    `Concurrency : ${job.concurrency}   Delay: ${job.delayMin}-${job.delayMax} ms`,
  );
  const confirmed = await ctx.prompt.confirm({
    message: `Start scraping ${auto.chapterLinks.length} chapters now?`,
    initial: true,
  });
  if (confirmed === Cancel) return { action: "pop" };
  if (!confirmed) return { action: "pop" };
  return {
    action: "replace",
    screen: "task",
    params: { job, chapterUrls: auto.chapterLinks, cookies, isNewDomain },
  };
}

// ── Scan summary block (v1 :719-739) ────────────────────────────────────────
function renderScanSummary(
  ctx: ShellContext,
  auto: AutoScrapeResult,
  adapter: SiteAdapter,
  profile: SiteProfile | null,
): void {
  ctx.prompt.log("info", fmt.section("Scan Complete"));
  ctx.prompt.log(
    "success",
    `Detected "${auto.metadata.title}" by ${auto.metadata.author || "an unknown author"}`,
  );
  ctx.prompt.log("info", `Chapters found  : ${auto.chapterLinks.length}`);
  ctx.prompt.log("dim", `  first: ${auto.chapterLinks[0]}`);
  ctx.prompt.log(
    "dim",
    `  last : ${auto.chapterLinks[auto.chapterLinks.length - 1]}`,
  );
  ctx.prompt.log(
    "info",
    `Content selector: ${profile?.contentSelector ?? adapter.defaultContentSelector} ${profile ? "(from saved profile)" : "(site default)"}`,
  );
  ctx.prompt.log(
    "info",
    `Cover image     : ${auto.metadata.coverUrl ? "found automatically" : "none found"}`,
  );
  ctx.prompt.log(
    "dim",
    "These settings were filled in automatically from the site and any saved profile for this domain.",
  );
}

// ── buildQuickAutoConfig - port of v1 prompts.ts:1145-1186 (zero prompts) ──
// Builds a JobConfig straight out of the probe + adapter defaults + profile,
// with empty chapterLinks (TaskScreen fills them in from chapterUrls).
function buildQuickAutoConfig(
  appCfg: import("../../../core/domain/AppConfig.js").AppConfig,
  profile: SiteProfile | null,
  adapter: SiteAdapter,
  auto: AutoScrapeResult,
): JobConfig {
  const contentSelector =
    profile?.contentSelector ?? adapter.defaultContentSelector;
  const separateTitle = profile?.separateTitle ?? adapter.defaultSeparateTitle;
  const titleSelector = profile?.titleSelector ?? adapter.defaultTitleSelector;
  const excludeSelectors =
    profile?.excludeSelectors ?? adapter.defaultExcludeSelectors;

  const metadata: NovelMetadata = {
    title: auto.metadata.title,
    author: auto.metadata.author || appCfg.defaultAuthor,
    language: appCfg.defaultLanguage,
    publisher: appCfg.defaultPublisher,
    synopsis: auto.metadata.description || undefined,
    coverSource: auto.metadata.coverUrl ? "url" : "none",
    coverUrl: auto.metadata.coverUrl,
  };

  return {
    method: "toc",
    tocUrl: adapter.getTocUrl(auto.novelUrl),
    chapterLinks: [],
    contentSelector,
    separateTitle,
    titleSelector,
    excludeSelectors,
    metadata,
    outputDir: appCfg.defaultOutputDir,
    outputFilename: defaultFilenameFor(metadata.title),
    concurrency: profile?.concurrency ?? appCfg.defaultConcurrency,
    delayMin: profile?.delayMin ?? appCfg.defaultDelayMin,
    delayMax: profile?.delayMax ?? appCfg.defaultDelayMax,
    headless: appCfg.headless,
    output: { epub: true },
  };
}

// Minimal JobConfig seed for launchOptionsForScrape (only the fields it reads:
// job.headless). The rest is filled because JobConfig has no optional fields
// beyond the documented `?` ones; a throwaway probe seed is fine.
const baseJobSeed: JobConfig = {
  method: "toc",
  tocUrl: "",
  contentSelector: "",
  separateTitle: false,
  excludeSelectors: [],
  metadata: { title: "", author: "", language: "en", coverSource: "none" },
  outputDir: "",
  outputFilename: "",
  concurrency: 2,
  delayMin: 1200,
  delayMax: 3500,
  headless: true,
  output: { epub: false },
};
