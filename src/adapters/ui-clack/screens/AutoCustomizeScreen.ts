// ─────────────────────────────────────────────────────────────────────────────
//  AutoCustomizeScreen - the `gatherAutoConfig` port (readme §2.5).
//
//  Reached from ChapterListScreen on the auto customize path (the user
//  declined "use defaults"). Reuses the shared group definitions from
//  `wizardGroups.ts` (extraction/metadata/output-perf) so the ~60% shared
//  surface with ManualWizardScreen is one definition (readme §1.3 / audit P5),
//  then ends with its own final confirm - the fast path's second confirm is
//  NOT re-asked because the two paths are mutually exclusive (v1 prompts.ts
//  :1100-1105 vs index.ts :805-827).
//
//  Seeds `initial` from the probe result (`auto.metadata`), the site defaults
//  (`adapter.default*Selector`), and the profile. The synopsis "edit the
//  auto-fetched synopsis? No keeps it as fetched" branch (v1 :946-966) is
//  already encoded in `metadataGroup` via the `seed.auto?.description` path,
//  so this screen just supplies the right Seed.
//
//  Output: a JobConfig with `chapterLinks` filled from the (edited)
//  ChapterListScreen result; pushes TaskScreen. The auto flow always uses
//  `method: "toc"` and `tocUrl: adapter.getTocUrl(auto.novelUrl)` (v1 :1124-1125).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import {
  buildMetadata,
  extractionGroup,
  metadataGroup,
  outputPerfGroup,
  type ConfigAnswers,
  type Seed,
} from "../wizardGroups.js";
import { defaultFilenameFor } from "../validation.js";
import * as fmt from "../format.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { JobConfig } from "../../../core/domain/JobConfig.js";
import type {
  AutoScrapeResult,
  SiteAdapter,
} from "../../../core/domain/SiteAdapter.js";
import type { SiteProfile } from "../../../ports/ProfileStore.js";
import type { DomainCookie } from "../../../core/domain/Cookie.js";

export interface AutoCustomizeParams {
  /** Chapter list AFTER the ChapterListScreen review (possibly edited). */
  chapterLinks: string[];
  /** The probe result - metadata + the original (pre-edit) chapter list. */
  auto: AutoScrapeResult;
  /** The matched site adapter (for defaults + getTocUrl). */
  adapter: SiteAdapter;
  /** Profile for the domain, if any. */
  profile: SiteProfile | null;
  /** Resolved cookies for the domain (already attached to the probe
   * context; passed straight through to TaskScreen so it doesn't re-prompt). */
  cookies: DomainCookie[];
  /** Scrape domain + new-domain flag for the TaskScreen + profile-save tail. */
  domain?: string;
  isNewDomain?: boolean;
}

export class AutoCustomizeScreen implements Screen {
  readonly id = "auto-customize";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const p = params as AutoCustomizeParams;
    const appCfg = await ctx.config.read();
    const seed: Seed = {
      appCfg,
      profile: p.profile,
      adapter: p.adapter,
      auto: p.auto.metadata,
    };

    // Review banner (v1 :772-791).
    ctx.prompt.log("info", fmt.section("Auto-Scrape Review"));
    ctx.prompt.log("success", `Site        : ${p.adapter.label}`);
    ctx.prompt.log("info", `Novel       : ${p.auto.metadata.title}`);
    ctx.prompt.log("info", `Author      : ${p.auto.metadata.author}`);
    ctx.prompt.log("info", `Chapters    : ${p.chapterLinks.length}`);
    if (p.auto.metadata.coverUrl) {
      ctx.prompt.log("info", `Cover       : ${p.auto.metadata.coverUrl}`);
    }
    ctx.prompt.log(
      "dim",
      "Every field below was filled in automatically from the site. Review each one and change anything that does not look right before the scrape begins.",
    );
    if (p.profile) {
      ctx.prompt.log("info", fmt.section("Site Profile Loaded"));
      ctx.prompt.log(
        "success",
        `Found a saved profile for ${p.profile.domain}`,
      );
      ctx.prompt.log("dim", `Label: ${p.profile.label ?? "(no label)"}`);
    }

    // The three shared groups - extraction -> metadata -> output & perf.
    let a: ConfigAnswers = {
      contentSelector:
        p.profile?.contentSelector ?? p.adapter.defaultContentSelector,
      separateTitle: p.profile?.separateTitle ?? p.adapter.defaultSeparateTitle,
      titleSelector: p.profile?.titleSelector ?? p.adapter.defaultTitleSelector,
      excludeSelectors:
        p.profile?.excludeSelectors ?? p.adapter.defaultExcludeSelectors,
      title: p.auto.metadata.title,
      author: p.auto.metadata.author || appCfg.defaultAuthor,
      language: appCfg.defaultLanguage,
      publisher: appCfg.defaultPublisher,
    };

    const groups: Array<{
      name: string;
      run(
        prompt: ShellContext["prompt"],
        ans: ConfigAnswers,
      ): Promise<ConfigAnswers | typeof Cancel>;
    }> = [
      {
        name: "Content Extraction",
        run: (prompt, ans) => extractionGroup(prompt, ans, seed),
      },
      {
        name: "Novel Metadata",
        run: (prompt, ans) => metadataGroup(prompt, ans, seed),
      },
      {
        name: "Output & Performance",
        run: (prompt, ans) => outputPerfGroup(prompt, ans, seed),
      },
      {
        name: "Review and Confirm",
        run: (prompt, ans) => reviewGroup(prompt, ans, p),
      },
    ];

    let i = 0;
    while (i < groups.length) {
      const g = groups[i];
      ctx.prompt.log("info", fmt.section(g.name));
      const r = await g.run(ctx.prompt, a);
      if (r === Cancel) {
        i--;
        if (i < 0) return { action: "pop" };
        continue;
      }
      a = r;
      i++;
    }

    const job = assembleAutoJob(a, appCfg, p);
    return {
      action: "replace",
      screen: "task",
      params: {
        job,
        chapterUrls: p.chapterLinks,
        cookies: p.cookies,
        domain: p.domain,
        isNewDomain: p.isNewDomain,
      },
    };
  }
}

// ── Final confirm (v1 prompts.ts :1073-1106) - the auto-customize path ends
//    here; the fast path's second confirm is NOT re-asked (mutually exclusive).
async function reviewGroup(
  prompt: ShellContext["prompt"],
  a: ConfigAnswers,
  params: AutoCustomizeParams,
): Promise<ConfigAnswers | typeof Cancel> {
  prompt.log("info", "");
  prompt.log("info", `Novel      : ${a.title ?? ""}`);
  prompt.log("info", `Author     : ${a.author ?? ""}`);
  prompt.log("info", `Chapters   : ${params.chapterLinks.length}`);
  prompt.log("info", `Content sel: ${a.contentSelector ?? ""}`);
  if (params.profile) {
    prompt.log("info", `Profile    : ${params.profile.domain} (pre-filled)`);
  }
  prompt.log("info", `Threads    : ${a.concurrency ?? ""}`);
  prompt.log("info", `Delay      : ${a.delayRange ?? ""} ms`);
  prompt.log(
    "info",
    `Output     : ${a.outputDir ?? ""}/${a.outputFilename ?? ""}`,
  );
  prompt.log("dim", "Escape goes back to change something - Ctrl+Q quits");

  const confirmed = await prompt.confirm({
    message: "Start scraping with these settings?",
    initial: true,
  });
  if (confirmed === Cancel) return Cancel;
  if (!confirmed) return Cancel; // v1 calls process.exit(0); the screen returns Cancel so the shell pops.
  return { ...a, confirmed: true };
}

// ── Assembly (v1 prompts.ts :1109-1139) - method is always "toc" for the
//    auto flow; tocUrl comes from the adapter; chapterLinks from the
//    (edited) ChapterListScreen result.
function assembleAutoJob(
  answers: ConfigAnswers,
  appCfg: Seed["appCfg"],
  params: AutoCustomizeParams,
): JobConfig {
  const metadata = buildMetadata(answers);
  const [delayMin, delayMax] = (answers.delayRange ?? "1200-3500")
    .split("-")
    .map((n) => parseInt(n, 10));

  return {
    method: "toc",
    tocUrl: params.adapter.getTocUrl(params.auto.novelUrl),
    chapterLinks: [],
    contentSelector: answers.contentSelector ?? "",
    separateTitle: answers.separateTitle ?? true,
    titleSelector: answers.separateTitle ? answers.titleSelector : undefined,
    excludeSelectors: answers.excludeSelectors ?? [],
    metadata,
    outputDir: (answers.outputDir ?? appCfg.defaultOutputDir).trim(),
    outputFilename:
      (answers.outputFilename ?? "").trim() ||
      defaultFilenameFor(answers.title ?? ""),
    concurrency: answers.concurrency ?? appCfg.defaultConcurrency,
    delayMin: isNaN(delayMin) ? appCfg.defaultDelayMin : delayMin,
    delayMax: isNaN(delayMax) ? appCfg.defaultDelayMax : delayMax,
    headless: appCfg.headless,
    output: { epub: true },
  };
}
