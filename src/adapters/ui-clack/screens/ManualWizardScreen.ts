// ─────────────────────────────────────────────────────────────────────────────
//  ManualWizardScreen - the grouped wizard mapping v1's `gatherConfig`
//  (`:280-735`) onto Clack `group`-style ordering (readme §2.4) using the
//  shared group helpers in `wizardGroups.ts`.
//
//  Groups in order: Source → Extraction → Metadata → Output & Performance →
//  Review (table §2.4). Escape on a group moves back one *group* (the v1
//  group-level split arrives with Phase 4's group() wizards - phase-3 §2.6).
//  Escape out of the very first group pops the screen back to Main.
//
//  The screen keeps an in-memory `answers: ConfigAnswers` and a small
//  back-stack of group indices; this mirrors runWizard's skip-aware walk
//  (`src/tui/wizard.ts:63-85`) so Escape goes to the previous *applicable*
//  group. **A false final confirm** returns a sentinel result the shell
//  maps to `pop` (abort to main) - never `process.exit`.
//
//  Output: a `JobConfig` with **empty `chapterLinks`** and
//  `output.epub: true` (readme §1.2 / table row "Assembly into ScraperConfig
//  with CHAPTERLINKS EMPTY"). The screen does NOT scrape; discovery runs
//  afterwards, feeding the chapter list.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import { appendFallbacks, promptLocator } from "../wizardShared.js";
import {
  buildMetadata,
  extractionGroup,
  metadataGroup,
  outputPerfGroup,
  sourceGroup,
  type ConfigAnswers,
  type Seed,
} from "../wizardGroups.js";
import { defaultFilenameFor } from "../validation.js";
import * as fmt from "../format.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { JobConfig } from "../../../core/domain/JobConfig.js";
import type { NextLocator } from "../../../core/domain/Locator.js";
import type { NewScrapeCommonParams } from "./NewScrapeScreen.js";

export type ManualWizardParams = NewScrapeCommonParams;

export class ManualWizardScreen implements Screen {
  readonly id = "manual-wizard";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const p = params as ManualWizardParams;
    const appCfg = await ctx.config.read();
    const seed: Seed = { appCfg, profile: p.profile };
    const entryUrl = p.entryUrl;

    let a: ConfigAnswers = {};
    // Group order maps the v1 table (readme §2.4).
    const groups: Array<{
      name: string;
      run(
        prompt: ShellContext["prompt"],
        ans: ConfigAnswers,
      ): Promise<ConfigAnswers | typeof Cancel>;
    }> = [
      {
        name: "Source",
        run: async (_p, ans) => sourceGroup(ctx.prompt, ans, seed, entryUrl),
      },
      {
        name: "Next-Chapter Locator",
        run: async (_p, ans) => locatorsGroup(ctx.prompt, ans, seed),
      },
      {
        name: "Extraction",
        run: async (_p, ans) => extractionGroup(ctx.prompt, ans, seed),
      },
      {
        name: "Metadata",
        run: async (_p, ans) => metadataGroup(ctx.prompt, ans, seed),
      },
      {
        name: "Output & Performance",
        run: async (_p, ans) => outputPerfGroup(ctx.prompt, ans, seed),
      },
      {
        name: "Review",
        run: async (_p, ans) => reviewGroup(ctx.prompt, ans, p),
      },
    ];

    let i = 0;
    while (i < groups.length) {
      const g = groups[i];
      if (g.name === "Next-Chapter Locator" && a.method !== "sequential") {
        i++;
        continue;
      }
      ctx.prompt.log("info", fmt.section(g.name));
      const r = await g.run(ctx.prompt, a);
      if (r === Cancel) {
        // Back one group; skip locator group if not sequential.
        i--;
        let j = i;
        while (j >= 0) {
          const prev = groups[j];
          if (prev.name === "Next-Chapter Locator" && a.method !== "sequential")
            j--;
          else break;
        }
        i = j;
        if (i < 0) return { action: "pop" };
        continue;
      }
      a = r;
      i++;
    }

    const job = assembleJob(a, appCfg, p);
    return {
      action: "replace",
      screen: "manual-discovery",
      params: { job, domain: p.domain, isNewDomain: p.isNewDomain },
    };
  }
}

// ── Sequential-only locator group (v1 src/tui/prompts.ts:367-404) ─────────────
async function locatorsGroup(
  prompt: ShellContext["prompt"],
  a: ConfigAnswers,
  seed: Seed,
): Promise<ConfigAnswers | typeof Cancel> {
  const profileLocators = seed.profile?.nextButtonLocators ?? [];

  if (profileLocators.length > 0) {
    prompt.log("info", "This profile has saved locators:");
    profileLocators.forEach((l, i) => {
      const tag = i === 0 ? "primary" : `fallback ${i}`;
      prompt.log("info", `    [${tag}]  ${l.kind} ${l.value}`);
    });
    const useRes = await prompt.confirm({
      message: "Use these saved locators?",
      initial: true,
    });
    if (useRes === Cancel) return Cancel;
    if (useRes) return { ...a, nextButtonLocators: profileLocators };
  } else {
    prompt.log(
      "dim",
      "Three modes are available: CSS selector, XPath expression, or regex text match.",
    );
  }

  const primary = await promptLocator(
    prompt,
    "Primary locator",
    profileLocators[0],
  );
  if (primary === Cancel) return Cancel;
  let locators: NextLocator[] = [primary];
  const fresh = await appendFallbacks(prompt, [...locators]);
  if (fresh === Cancel) return Cancel;
  locators = fresh;
  return { ...a, nextButtonLocators: locators };
}

// ── Review group (the v1 `:658-695` final card + confirm) ────────────────────
async function reviewGroup(
  prompt: ShellContext["prompt"],
  a: ConfigAnswers,
  params: ManualWizardParams,
): Promise<ConfigAnswers | typeof Cancel> {
  prompt.log("info", "");
  prompt.log("info", `Novel   : ${a.title ?? ""}`);
  prompt.log("info", `Method  : ${a.method ?? ""}`);
  if (a.method === "sequential" && a.nextButtonLocators?.length) {
    a.nextButtonLocators.forEach((l, i) => {
      const tag = i === 0 ? "primary" : `fallback ${i}`;
      prompt.log("info", `Next [${tag}]: ${l.kind} ${l.value}`);
    });
  }
  if (params.profile) {
    prompt.log("info", `Profile : ${params.domain} (pre-filled)`);
  }
  prompt.log("info", `Threads : ${a.concurrency ?? ""}`);
  prompt.log("info", `Delay   : ${a.delayRange ?? ""} ms`);
  prompt.log(
    "info",
    `Output  : ${a.outputDir ?? ""}/${a.outputFilename ?? ""}`,
  );
  prompt.log("dim", "Escape goes back to change something · Ctrl+Q quits");

  const confirmed = await prompt.confirm({
    message: "Start scraping with these settings?",
    initial: true,
  });
  if (confirmed === Cancel) return Cancel;
  if (!confirmed) {
    // v1 calls `process.exit(0)`; the screen returns a sentinel so the shell
    // pops cleanly to Main (readme §1.2, false-confirm handling).
    return Cancel;
  }
  return { ...a, confirmed: true };
}

// ── Assembly into ScraperConfig with CHAPTERLINKS EMPTY (v1 :700-735) ────────
function assembleJob(
  answers: ConfigAnswers,
  appCfg: Seed["appCfg"],
  params: ManualWizardParams,
): JobConfig {
  const metadata = buildMetadata(answers);
  const [delayMin, delayMax] = (answers.delayRange ?? "1200-3500")
    .split("-")
    .map((n) => parseInt(n, 10));

  const job: JobConfig = {
    method: answers.method ?? "toc",
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
    chapterLinks: [],
    output: { epub: true },
  };

  if (answers.method === "toc") {
    job.tocUrl = answers.tocUrl?.trim() || params.entryUrl;
  } else {
    job.firstChapterUrl = answers.firstChapterUrl;
    job.lastChapterUrl = answers.lastChapterUrl;
    job.nextButtonLocators = answers.nextButtonLocators;
  }
  return job;
}
