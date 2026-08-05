// ─────────────────────────────────────────────────────────────────────────────
//  wizardGroups - the shared Extraction / Metadata / Output / Perf / Review
//  group definitions used by ManualWizardScreen and AutoCustomizeScreen
//  (readme §1.2 / §2.4 / audit P5).
//
//  v1 had `gatherConfig` and `gatherAutoConfig` duplicating ~60% of their
//  step lists (:280-735 vs :764-1139). Phase 4 keeps the two screens (the
//  Source group exists only for the manual flow, the auto flow seeds the
//  probe result) but the *body* of each screen builds its question run from
//  the group helpers here so the duplication is one shared definition, not
//  two wall-of-code functions.
//
//  Each `*Group` helper takes the PromptProvider, an in-memory `A` (the
//  running answer object for the screen) and a `seed` bag holding any
//  AutoScrapeResult / SiteAdapter / SiteProfile / AppConfig pre-fill values
//  the group needs. Each call returns the updated partial answer; `Cancel`
//  propagates up so the screen's back-stack can walk the user back one group
//  (readme §2.4) rather than re-running skipped steps.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel, type PromptProvider, type SelectOption } from "./PromptProvider.js";
import { promptMultilineText } from "./wizardShared.js";
import {
  defaultFilenameFor,
  validateDelayRange,
  validateNonEmpty,
  validatePerfRange,
  validateUrl,
} from "./validation.js";
import type { NextLocator } from "../../core/domain/Locator.js";
import type { CoverSource, NovelMetadata } from "../../core/domain/NovelMetadata.js";
import type { ScrapeMethod } from "../../core/domain/JobConfig.js";
import type { AppConfig } from "../../core/domain/AppConfig.js";
import type { AutoNovelMetadata, SiteAdapter } from "../../core/domain/SiteAdapter.js";
import type { SiteProfile } from "../../ports/ProfileStore.js";

/** The combined wizard answer object passed by both screens. */
export interface ConfigAnswers {
  method?: ScrapeMethod;
  tocUrl?: string;
  firstChapterUrl?: string;
  lastChapterUrl?: string;
  nextButtonLocators?: NextLocator[];

  contentSelector?: string;
  separateTitle?: boolean;
  titleSelector?: string;
  hasExclusions?: boolean;
  excludeSelectors?: string[];

  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  hasSynopsis?: boolean;
  synopsis?: string;
  coverSource?: CoverSource;
  coverUrl?: string;
  coverPath?: string;

  outputDir?: string;
  outputFilename?: string;
  concurrency?: number;
  delayRange?: string;

  confirmed?: boolean;
}

/** Pre-fill seed bag. AutoCustomize uses `adapter` + `auto`; ManualWizard
 * uses only `profile` (+ appCfg).  `appCfg` is always present. */
export interface Seed {
  appCfg: AppConfig;
  profile: SiteProfile | null;
  adapter?: SiteAdapter;
  auto?: AutoNovelMetadata;
}

/** Source group - method + tocUrl OR (first/last + locators). Manual-only. */
export async function sourceGroup(
  prompt: PromptProvider,
  a: ConfigAnswers,
  seed: Seed,
  entryUrl: string,
): Promise<ConfigAnswers | typeof Cancel> {
  const profileMethod = seed.profile?.method ?? "toc";
  const methodRes = await prompt.select<ScrapeMethod>({
    message: "How do you want to supply chapter URLs?",
    options: [
      {
        value: "toc",
        label:
          "Table of Contents URL - automatically discover every chapter link from a TOC page",
      },
      {
        value: "sequential",
        label: 'First and last chapter - walk the novel using a "Next Chapter" button',
      },
    ],
    initial: a.method ?? profileMethod,
  });
  if (methodRes === Cancel) return Cancel;
  const method = methodRes;
  let tocUrl: string | undefined;
  let firstChapterUrl: string | undefined;
  let lastChapterUrl: string | undefined;
  let nextButtonLocators: NextLocator[] | undefined;

  if (method === "toc") {
    const r = await prompt.text({
      message: "Table of Contents URL:",
      initial: a.tocUrl ?? entryUrl,
      validate: validateUrl,
    });
    if (r === Cancel) return Cancel;
    tocUrl = r.trim();
  } else {
    const r1 = await prompt.text({
      message: "URL of the FIRST chapter:",
      initial: a.firstChapterUrl ?? entryUrl,
      validate: validateUrl,
    });
    if (r1 === Cancel) return Cancel;
    firstChapterUrl = r1.trim();

    const r2 = await prompt.text({
      message: "URL of the LAST chapter:",
      initial: a.lastChapterUrl ?? "",
      validate: validateUrl,
    });
    if (r2 === Cancel) return Cancel;
    lastChapterUrl = r2.trim();

    // Locator capture is handled by the manual screen via wizardShared.promptLocator,
    // because the locus differs between manual (profile locators) and auto flow.
    // Pre-fill from profile only here; the screen mutates this group's answer.
    nextButtonLocators = seed.profile?.nextButtonLocators ?? undefined;
  }

  return { ...a, method, tocUrl, firstChapterUrl, lastChapterUrl, nextButtonLocators };
}

/** Extraction group - contentSelector, separateTitle, titleSelector, exclusions. */
export async function extractionGroup(
  prompt: PromptProvider,
  a: ConfigAnswers,
  seed: Seed,
): Promise<ConfigAnswers | typeof Cancel> {
  const defContent =
    a.contentSelector ??
    seed.profile?.contentSelector ??
    seed.adapter?.defaultContentSelector ??
    "";
  const content = await prompt.text({
    message: "Chapter content container:",
    hint: 'CSS or XPath  e.g.  .chapter-content  |  //div[@id="chapter-body"]',
    initial: defContent,
    validate: validateNonEmpty("Content selector"),
  });
  if (content === Cancel) return Cancel;
  const contentSelector = content.trim();

  const defSep =
    a.separateTitle ??
    seed.profile?.separateTitle ??
    seed.adapter?.defaultSeparateTitle ??
    true;
  const sepRes = await prompt.confirm({
    message: "Extract the chapter title from a separate element?",
    initial: defSep,
  });
  if (sepRes === Cancel) return Cancel;
  const separateTitle = sepRes;

  let titleSelector = a.titleSelector;
  if (separateTitle) {
    const defTitle =
      a.titleSelector ??
      seed.profile?.titleSelector ??
      seed.adapter?.defaultTitleSelector ??
      "";
    const r = await prompt.text({
      message: "Chapter title element:",
      hint: 'CSS or XPath  e.g.  .chapter-title  |  //h1[@class="title"]',
      initial: defTitle,
      validate: validateNonEmpty("Title selector"),
    });
    if (r === Cancel) return Cancel;
    titleSelector = r.trim();
  } else {
    titleSelector = undefined;
  }

  const profileExcludes =
    seed.profile?.excludeSelectors ?? seed.adapter?.defaultExcludeSelectors ?? [];
  const hasExcRes = await prompt.confirm({
    message:
      "Exclude any elements from the scraped content (e.g. ads, author notes)?",
    initial: a.hasExclusions ?? profileExcludes.length > 0,
  });
  if (hasExcRes === Cancel) return Cancel;
  const hasExclusions = hasExcRes;

  let excludeSelectors: string[] = a.excludeSelectors ?? [];
  if (hasExclusions) {
    prompt.log("dim", "CSS and XPath are both accepted. Separate multiple selectors with commas.");
    const r = await prompt.text({
      message: "Selectors to exclude:",
      initial: (a.excludeSelectors ?? profileExcludes).join(", "),
    });
    if (r === Cancel) return Cancel;
    excludeSelectors = r.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    excludeSelectors = [];
  }

  return { ...a, contentSelector, separateTitle, titleSelector, hasExclusions, excludeSelectors };
}

/** Metadata group - title, author, language, publisher, synopsis, cover+conditional. */
export async function metadataGroup(
  prompt: PromptProvider,
  a: ConfigAnswers,
  seed: Seed,
): Promise<ConfigAnswers | typeof Cancel> {
  const defTitle = a.title ?? seed.auto?.title ?? "";
  const tR = await prompt.text({
    message: "Novel title:",
    initial: defTitle,
    validate: validateNonEmpty("Title"),
  });
  if (tR === Cancel) return Cancel;
  const title = tR.trim();

  const defAuthor = a.author ?? (seed.auto?.author || seed.appCfg.defaultAuthor);
  const aR = await prompt.text({
    message: "Author name:",
    initial: defAuthor,
  });
  if (aR === Cancel) return Cancel;
  const author = aR.trim() || seed.appCfg.defaultAuthor;

  const lR = await prompt.text({
    message: "Language code (ISO 639-1):",
    initial: a.language ?? seed.appCfg.defaultLanguage,
  });
  if (lR === Cancel) return Cancel;
  const language = lR.trim() || seed.appCfg.defaultLanguage;

  const pR = await prompt.text({
    message: "Publisher or source (optional):",
    initial: a.publisher ?? seed.appCfg.defaultPublisher,
  });
  if (pR === Cancel) return Cancel;
  const publisher = pR.trim() || seed.appCfg.defaultPublisher;

  // Synopsis branch: auto flow auto-fetches (readme §2.5); manual has none.
  let synopsis = a.synopsis;
  let hasSynopsis = a.hasSynopsis;
  if (seed.auto?.description) {
    prompt.log("info", "Synopsis (auto-fetched):");
    seed.auto.description.split(/\n{2,}/).forEach((para) => {
      prompt.log("dim", para.trim());
    });
    const hRes = await prompt.confirm({
      message: "Include a synopsis or description?",
      initial: a.hasSynopsis ?? seed.auto.description.length > 0,
    });
    if (hRes === Cancel) return Cancel;
    hasSynopsis = hRes;
    if (hasSynopsis) {
      if (a.synopsis !== undefined) {
        // Returning to re-edit after already having made a choice here -
        // re-open the free-form editor on whatever was there.
        const s = await promptMultilineText(prompt, "Synopsis", a.synopsis);
        if (s === Cancel) return Cancel;
        synopsis = s;
      } else {
        const edit = await prompt.confirm({
          message:
            "Edit the auto-fetched synopsis? (No keeps it exactly as fetched, line breaks and all)",
          initial: false,
        });
        if (edit === Cancel) return Cancel;
        if (edit) {
          const s = await promptMultilineText(prompt, "Synopsis", seed.auto.description);
          if (s === Cancel) return Cancel;
          synopsis = s;
        } else {
          synopsis = seed.auto.description;
        }
      }
    } else {
      synopsis = undefined;
    }
  } else {
    const hRes = await prompt.confirm({
      message: "Add a synopsis or description?",
      initial: a.hasSynopsis ?? false,
    });
    if (hRes === Cancel) return Cancel;
    hasSynopsis = hRes;
    if (hasSynopsis) {
      const s = await promptMultilineText(prompt, "Synopsis", a.synopsis);
      if (s === Cancel) return Cancel;
      synopsis = s;
    } else {
      synopsis = undefined;
    }
  }

  const coverOptions: SelectOption<CoverSource>[] = [
    { value: "none", label: "No cover image" },
    { value: "url", label: "Download the cover from a URL" },
    { value: "file", label: "Use a local image file as the cover" },
  ];
  const defCover: CoverSource = a.coverSource ?? (seed.auto?.coverUrl ? "url" : "none");
  const cR = await prompt.select<CoverSource>({
    message: "Cover image:",
    options: coverOptions,
    initial: defCover,
  });
  if (cR === Cancel) return Cancel;
  const coverSource = cR;

  let coverUrl: string | undefined;
  if (coverSource === "url") {
    const r = await prompt.text({
      message: "Cover image URL:",
      initial: a.coverUrl ?? seed.auto?.coverUrl ?? "",
      validate: validateUrl,
    });
    if (r === Cancel) return Cancel;
    coverUrl = r.trim();
  }
  let coverPath: string | undefined;
  if (coverSource === "file") {
    const r = await prompt.text({
      message: "Path to cover image file:",
      initial: a.coverPath ?? "",
      validate: validateNonEmpty("Path"),
    });
    if (r === Cancel) return Cancel;
    coverPath = r.trim();
  }

  return {
    ...a,
    title,
    author,
    language,
    publisher,
    hasSynopsis,
    synopsis,
    coverSource,
    coverUrl,
    coverPath,
  };
}

/** Output & performance group. */
export async function outputPerfGroup(
  prompt: PromptProvider,
  a: ConfigAnswers,
  seed: Seed,
): Promise<ConfigAnswers | typeof Cancel> {
  const oDirR = await prompt.text({
    message: "Output directory:",
    initial: a.outputDir ?? seed.appCfg.defaultOutputDir,
  });
  if (oDirR === Cancel) return Cancel;
  const outputDir = oDirR.trim() || seed.appCfg.defaultOutputDir;

  const oFileR = await prompt.text({
    message: "Output filename (.epub):",
    initial: a.outputFilename ?? defaultFilenameFor(a.title ?? ""),
  });
  if (oFileR === Cancel) return Cancel;
  const outputFilename = oFileR.trim() || defaultFilenameFor(a.title ?? "");

  const defConcurrency = a.concurrency ?? (seed.profile?.concurrency ?? seed.appCfg.defaultConcurrency);
  const cRes = await prompt.text({
    message: "Concurrent browser pages (1 to 5):",
    initial: String(defConcurrency),
    validate: validatePerfRange,
  });
  if (cRes === Cancel) return Cancel;
  const concurrency = parseInt(cRes, 10);

  const defDelayMin = a.delayRange ? Number(a.delayRange.split("-")[0]) : (seed.profile?.delayMin ?? seed.appCfg.defaultDelayMin);
  const defDelayMax = a.delayRange ? Number(a.delayRange.split("-")[1]) : (seed.profile?.delayMax ?? seed.appCfg.defaultDelayMax);
  const dRes = await prompt.text({
    message: "Delay range between requests in milliseconds (min-max):",
    initial: a.delayRange ?? `${defDelayMin}-${defDelayMax}`,
    validate: validateDelayRange,
  });
  if (dRes === Cancel) return Cancel;
  const delayRange = dRes;

  return { ...a, outputDir, outputFilename, concurrency, delayRange };
}

/** Assemble NovelMetadata out of finalized answers. */
export function buildMetadata(answers: ConfigAnswers): NovelMetadata {
  return {
    title: answers.title ?? "",
    author: answers.author ?? "",
    language: answers.language ?? "en",
    publisher: answers.publisher,
    synopsis: answers.hasSynopsis ? answers.synopsis : undefined,
    coverSource: answers.coverSource ?? "none",
    coverUrl: answers.coverSource === "url" ? answers.coverUrl : undefined,
    coverPath: answers.coverSource === "file" ? answers.coverPath : undefined,
  };
}
