import chalk from "chalk";
import * as disp from "./display.js";
import type {
  ScraperConfig,
  NovelMetadata,
  CoverSource,
  NextLocator,
  AppConfig,
  SiteProfile,
} from "../types.js";
import type { AutoScrapeResult, SiteAdapter } from "../sites/types.js";
import { formatLocator } from "../scraper/selectors.js";
import { step, runWizard, WizardBack, type WizardStep } from "./wizard.js";

// ── Validators ───────────────────────────────────────────────────────────────
export function validateUrl(val: string): boolean | string {
  try {
    new URL(val.trim());
    return true;
  } catch {
    return "Please enter a valid URL (include https://)";
  }
}

function validateNonEmpty(label: string) {
  return (val: string) => val.trim().length > 0 || `${label} cannot be empty`;
}

function validateRegex(val: string): boolean | string {
  try {
    new RegExp(val.trim());
    return true;
  } catch {
    return "Invalid regex pattern — check syntax";
  }
}

const SELECTOR_HINT =
  'Accepts a CSS selector (e.g. ".class", "#id") or an XPath expression ' +
  '(e.g. \'//div[@class="x"]\', optionally prefixed with "xpath=").';

const BACK_HINT = chalk.dim("(Escape goes back a step)");

// ═══════════════════════════════════════════════════════════════════════════
//  promptLocator — unified locator entry (css | xpath | regex)
//  prefill: optionally pre-select a locator kind and value from a profile
//
//  This is its own little back-navigable flow (kind → value → [flags]) via
//  runWizard. Pressing Escape on its very first question ("locator type")
//  throws WizardBack out of promptLocator entirely — the OUTER wizard step
//  that called it (see nextButtonLocators below) is wrapped in the same
//  try/catch machinery as every other step, so that propagates naturally
//  into "go back to the field before this one", with no special-casing
//  needed here.
// ═══════════════════════════════════════════════════════════════════════════
interface LocatorAnswers {
  kind: "css" | "xpath" | "regex";
  value: string;
  flags: string;
}

async function promptLocator(
  label: string,
  prefill?: NextLocator,
): Promise<NextLocator> {
  const answers = await runWizard<LocatorAnswers>([
    {
      key: "kind",
      run: async (a) => {
        const { kind } = await step<{ kind: string }>({
          type: "select",
          name: "kind",
          message: `${label} — locator type: ${BACK_HINT}`,
          choices: [
            {
              name: "css",
              message: `${chalk.cyan("CSS selector")}      e.g. .btn-next  a[rel="next"]  #nextchap`,
            },
            {
              name: "xpath",
              message: `${chalk.magenta("XPath expression")}  e.g. //a[contains(@class,"next")]`,
            },
            {
              name: "regex",
              message: `${chalk.yellow("Regex text match")}   e.g. >>  Next Chapter  下一章`,
            },
          ],
          initial: a.kind ?? prefill?.kind ?? "css",
        });
        return kind as LocatorAnswers["kind"];
      },
    },
    {
      key: "value",
      run: async (a) => {
        if (a.kind === "css") {
          const { value } = await step<{ value: string }>({
            type: "input",
            name: "value",
            message: `CSS selector: ${BACK_HINT}`,
            hint: 'e.g.  .next-chapter  |  a[rel="next"]  |  #btn-next',
            initial: a.value ?? (prefill?.kind === "css" ? prefill.value : ""),
            validate: validateNonEmpty("Selector"),
          });
          return value.trim();
        } else if (a.kind === "xpath") {
          const { value } = await step<{ value: string }>({
            type: "input",
            name: "value",
            message: `XPath expression: ${BACK_HINT}`,
            hint: 'e.g.  //a[contains(@class,"next")]  |  //p/a[last()]',
            initial: a.value ?? (prefill?.kind === "xpath" ? prefill.value : ""),
            validate: validateNonEmpty("XPath expression"),
          });
          return value.trim().replace(/^xpath=/i, "");
        } else {
          disp.dim(
            "Matched against the visible text and title attribute of every <a href> on the page.",
          );
          const { value } = await step<{ value: string }>({
            type: "input",
            name: "value",
            message: `Regex pattern (no / delimiters): ${BACK_HINT}`,
            hint: "e.g.  >>  |  Next\\s*Chapter  |  下一章",
            initial: a.value ?? (prefill?.kind === "regex" ? prefill.value : ""),
            validate: validateRegex,
          });
          return value.trim();
        }
      },
    },
    {
      key: "flags",
      skip: (a) => a.kind !== "regex",
      run: async (a) => {
        const { flags } = await step<{ flags: string }>({
          type: "input",
          name: "flags",
          message: `Regex flags: ${BACK_HINT}`,
          initial: a.flags ?? prefill?.flags ?? "i",
          hint: "i = case-insensitive, u = unicode (needed for CJK text)",
          validate: (v: string) => {
            try {
              new RegExp("", v.trim());
              return true;
            } catch {
              return "Invalid regex flags";
            }
          },
        });
        return flags.trim() || "i";
      },
    },
  ]);

  if (answers.kind === "css") return { kind: "css", value: answers.value };
  if (answers.kind === "xpath") return { kind: "xpath", value: answers.value };
  return { kind: "regex", value: answers.value, flags: answers.flags };
}

async function promptMultilineText(
  label: string,
  existing?: string,
): Promise<string> {
  disp.dim(
    `Enter "${label}" one paragraph at a time. Leave a line blank when you are done.`,
  );

  const paragraphs: string[] = [];
  let idx = 1;
  while (true) {
    const { line } = await step<{ line: string }>({
      type: "input",
      name: "line",
      message: `Paragraph ${idx} (blank = done):`,
    });
    if (!line.trim()) break;
    paragraphs.push(line.trim());
    idx++;
  }

  if (paragraphs.length === 0) return existing?.trim() ?? "";
  return paragraphs.join("\n\n");
}

// ── Shared fallback-loop helper ───────────────────────────────────────────────
// Escape here abandons whatever fallbacks were added IN THIS CALL and
// propagates WizardBack out to the caller (same reasoning as promptLocator
// above) — it does not offer per-fallback undo, only "start this whole
// fallback-adding pass over".
async function appendFallbacks(
  locators: NextLocator[],
): Promise<NextLocator[]> {
  const { wantFallbacks } = await step<{ wantFallbacks: boolean }>({
    type: "confirm",
    name: "wantFallbacks",
    message:
      "Add fallback locators? (only needed when the layout changes partway through the novel)",
    initial: false,
  });
  if (!wantFallbacks) return locators;

  let idx = 1;
  while (true) {
    const { addAnother } = await step<{ addAnother: boolean }>({
      type: "confirm",
      name: "addAnother",
      message: `Add fallback #${idx}?`,
      initial: true,
    });
    if (!addAnother) break;

    const fb = await promptLocator(`Fallback #${idx}`);
    locators.push(fb);
    idx++;

    console.log("");
    disp.info(chalk.bold("Locator priority order:"));
    locators.forEach((l, i) => {
      const tag =
        i === 0 ? chalk.cyan.bold("  primary") : chalk.yellow(`fallback ${i}`);
      console.log(
        `    ${chalk.dim(`${i + 1}.`)} [${tag}]  ${chalk.white(formatLocator(l))}`,
      );
    });
    console.log("");
  }
  return locators;
}

// ═══════════════════════════════════════════════════════════════════════════
//  gatherConfig — manual setup wizard
//
//  Every question below is a runWizard() step. Pressing Escape on any of
//  them re-opens the previous one (with whatever was typed there still
//  showing, ready to edit) instead of the old "type the wrong thing, live
//  with it until the final confirm, then start completely over" flow.
//  Pressing Escape on the very first step (scraping method) throws
//  WizardBack out of gatherConfig entirely — index.ts catches that and
//  returns to the main menu, matching how declining the final confirm
//  already works today.
// ═══════════════════════════════════════════════════════════════════════════
interface ConfigAnswers {
  method: "toc" | "sequential";
  tocUrl: string;
  firstChapterUrl: string;
  lastChapterUrl: string;
  nextButtonLocators: NextLocator[];
  contentSelector: string;
  separateTitle: boolean;
  titleSelector: string;
  hasExclusions: boolean;
  excludeSelectors: string[];
  title: string;
  author: string;
  language: string;
  publisher: string;
  hasSynopsis: boolean;
  synopsis: string;
  coverSource: CoverSource;
  coverUrl: string;
  coverPath: string;
  outputDir: string;
  outputFilename: string;
  concurrency: number;
  delayRange: string;
  confirmed: boolean;
}

function defaultFilenameFor(title: string): string {
  return (
    title
      .replace(/[^a-z0-9\s]/gi, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase() + ".epub"
  );
}

export async function gatherConfig(
  appCfg: AppConfig,
  profile: SiteProfile | null,
): Promise<ScraperConfig> {
  disp.banner();

  if (profile) {
    disp.section("Site Profile Loaded");
    disp.success(`Found a saved profile for ${chalk.cyan(profile.domain)}`);
    disp.dim(`Label: ${profile.label ?? "(no label)"}`);
    disp.dim(
      "Every field below is pre-filled from this profile — press Enter to accept a value, or type a new one to override it.",
    );
    console.log("");
  }

  const steps: WizardStep<ConfigAnswers, keyof ConfigAnswers>[] = [
    {
      key: "method",
      run: async (a) => {
        disp.section("Scraping Method");
        const { method } = await step<{ method: string }>({
          type: "select",
          name: "method",
          message: `How do you want to supply chapter URLs? ${BACK_HINT}`,
          choices: [
            {
              name: "toc",
              message:
                "Table of Contents URL — automatically discover every chapter link from a TOC page",
            },
            {
              name: "sequential",
              message:
                'First and last chapter — walk the novel using a "Next Chapter" button',
            },
          ],
          initial: a.method ?? profile?.method ?? "toc",
        });
        return method as ConfigAnswers["method"];
      },
    },
    {
      key: "tocUrl",
      skip: (a) => a.method !== "toc",
      run: async (a) => {
        disp.section("Source Configuration");
        const r = await step<{ tocUrl: string }>({
          type: "input",
          name: "tocUrl",
          message: `Table of Contents URL: ${BACK_HINT}`,
          initial: a.tocUrl ?? "",
          validate: validateUrl,
        });
        return r.tocUrl.trim();
      },
    },
    {
      key: "firstChapterUrl",
      skip: (a) => a.method !== "sequential",
      run: async (a) => {
        disp.section("Source Configuration");
        const r = await step<{ firstChapterUrl: string }>({
          type: "input",
          name: "firstChapterUrl",
          message: `URL of the FIRST chapter: ${BACK_HINT}`,
          initial: a.firstChapterUrl ?? "",
          validate: validateUrl,
        });
        return r.firstChapterUrl.trim();
      },
    },
    {
      key: "lastChapterUrl",
      skip: (a) => a.method !== "sequential",
      run: async (a) => {
        const r = await step<{ lastChapterUrl: string }>({
          type: "input",
          name: "lastChapterUrl",
          message: `URL of the LAST chapter: ${BACK_HINT}`,
          initial: a.lastChapterUrl ?? "",
          validate: validateUrl,
        });
        return r.lastChapterUrl.trim();
      },
    },
    {
      key: "nextButtonLocators",
      skip: (a) => a.method !== "sequential",
      run: async () => {
        disp.section("Next-Chapter Locator");
        const profileLocators = profile?.nextButtonLocators ?? [];

        if (profileLocators.length > 0) {
          disp.info("This profile has saved locators:");
          profileLocators.forEach((l, i) => {
            const tag =
              i === 0 ? chalk.cyan("primary") : chalk.yellow(`fallback ${i}`);
            console.log(`    [${tag}]  ${chalk.white(formatLocator(l))}`);
          });
          console.log("");

          const { useProfile } = await step<{ useProfile: boolean }>({
            type: "confirm",
            name: "useProfile",
            message: "Use these saved locators?",
            initial: true,
          });

          if (useProfile) return profileLocators;

          const primary = await promptLocator(
            "Primary locator",
            profileLocators[0],
          );
          return appendFallbacks([primary]);
        }

        disp.dim(
          "Three modes are available: CSS selector, XPath expression, or regex text match.",
        );
        console.log("");
        const primary = await promptLocator("Primary locator");
        return appendFallbacks([primary]);
      },
    },
    {
      key: "contentSelector",
      run: async (a) => {
        disp.section("Content Extraction");
        disp.dim(SELECTOR_HINT);
        console.log("");
        const { contentSelector } = await step<{ contentSelector: string }>({
          type: "input",
          name: "contentSelector",
          message: `Chapter content container: ${BACK_HINT}`,
          hint: 'CSS or XPath  e.g.  .chapter-content  |  //div[@id="chapter-body"]',
          initial: a.contentSelector ?? profile?.contentSelector ?? "",
          validate: validateNonEmpty("Content selector"),
        });
        return contentSelector.trim();
      },
    },
    {
      key: "separateTitle",
      run: async (a) => {
        const { separateTitle } = await step<{ separateTitle: boolean }>({
          type: "confirm",
          name: "separateTitle",
          message: `Extract the chapter title from a separate element? ${BACK_HINT}`,
          initial: a.separateTitle ?? profile?.separateTitle ?? true,
        });
        return separateTitle;
      },
    },
    {
      key: "titleSelector",
      skip: (a) => !a.separateTitle,
      run: async (a) => {
        const r = await step<{ titleSelector: string }>({
          type: "input",
          name: "titleSelector",
          message: `Chapter title element: ${BACK_HINT}`,
          hint: 'CSS or XPath  e.g.  .chapter-title  |  //h1[@class="title"]',
          initial: a.titleSelector ?? profile?.titleSelector ?? "",
          validate: validateNonEmpty("Title selector"),
        });
        return r.titleSelector.trim();
      },
    },
    {
      key: "hasExclusions",
      run: async (a) => {
        disp.section("Exclusions (optional)");
        const profileExcludes = profile?.excludeSelectors ?? [];
        const { hasExclusions } = await step<{ hasExclusions: boolean }>({
          type: "confirm",
          name: "hasExclusions",
          message: `Exclude any elements from the scraped content (e.g. ads, author notes)? ${BACK_HINT}`,
          initial: a.hasExclusions ?? profileExcludes.length > 0,
        });
        return hasExclusions;
      },
    },
    {
      key: "excludeSelectors",
      skip: (a) => !a.hasExclusions,
      run: async (a) => {
        const profileExcludes = profile?.excludeSelectors ?? [];
        disp.dim(
          "CSS and XPath are both accepted. Separate multiple selectors with commas.",
        );
        const r = await step<{ exclusionList: string }>({
          type: "input",
          name: "exclusionList",
          message: "Selectors to exclude:",
          initial: a.excludeSelectors?.join(", ") ?? profileExcludes.join(", "),
        });
        return r.exclusionList
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    {
      key: "title",
      run: async (a) => {
        disp.section("Novel Metadata");
        const r = await step<{ title: string }>({
          type: "input",
          name: "title",
          message: `Novel title: ${BACK_HINT}`,
          initial: a.title ?? "",
          validate: validateNonEmpty("Title"),
        });
        return r.title.trim();
      },
    },
    {
      key: "author",
      run: async (a) => {
        const r = await step<{ author: string }>({
          type: "input",
          name: "author",
          message: `Author name: ${BACK_HINT}`,
          initial: a.author ?? appCfg.defaultAuthor,
        });
        return r.author.trim() || appCfg.defaultAuthor;
      },
    },
    {
      key: "language",
      run: async (a) => {
        const r = await step<{ language: string }>({
          type: "input",
          name: "language",
          message: `Language code (ISO 639-1): ${BACK_HINT}`,
          initial: a.language ?? appCfg.defaultLanguage,
        });
        return r.language.trim() || appCfg.defaultLanguage;
      },
    },
    {
      key: "publisher",
      run: async (a) => {
        const r = await step<{ publisher: string }>({
          type: "input",
          name: "publisher",
          message: `Publisher or source (optional): ${BACK_HINT}`,
          initial: a.publisher ?? appCfg.defaultPublisher,
        });
        return r.publisher.trim() || appCfg.defaultPublisher;
      },
    },
    {
      key: "hasSynopsis",
      run: async (a) => {
        const { hasSynopsis } = await step<{ hasSynopsis: boolean }>({
          type: "confirm",
          name: "hasSynopsis",
          message: `Add a synopsis or description? ${BACK_HINT}`,
          initial: a.hasSynopsis ?? false,
        });
        return hasSynopsis;
      },
    },
    {
      key: "synopsis",
      skip: (a) => !a.hasSynopsis,
      run: async (a) => promptMultilineText("Synopsis", a.synopsis),
    },
    {
      key: "coverSource",
      run: async (a) => {
        const { coverSource } = await step<{ coverSource: string }>({
          type: "select",
          name: "coverSource",
          message: `Cover image: ${BACK_HINT}`,
          choices: [
            { name: "none", message: "No cover image" },
            { name: "url", message: "Download the cover from a URL" },
            { name: "file", message: "Use a local image file as the cover" },
          ],
          initial: a.coverSource ?? "none",
        });
        return coverSource as CoverSource;
      },
    },
    {
      key: "coverUrl",
      skip: (a) => a.coverSource !== "url",
      run: async (a) => {
        const rc = await step<{ coverUrl: string }>({
          type: "input",
          name: "coverUrl",
          message: `Cover image URL: ${BACK_HINT}`,
          initial: a.coverUrl ?? "",
          validate: validateUrl,
        });
        return rc.coverUrl.trim();
      },
    },
    {
      key: "coverPath",
      skip: (a) => a.coverSource !== "file",
      run: async (a) => {
        const rc = await step<{ coverPath: string }>({
          type: "input",
          name: "coverPath",
          message: `Path to cover image file: ${BACK_HINT}`,
          initial: a.coverPath ?? "",
          validate: validateNonEmpty("Path"),
        });
        return rc.coverPath.trim();
      },
    },
    {
      key: "outputDir",
      run: async (a) => {
        disp.section("Output Settings");
        const ro1 = await step<{ outputDir: string }>({
          type: "input",
          name: "outputDir",
          message: `Output directory: ${BACK_HINT}`,
          initial: a.outputDir ?? appCfg.defaultOutputDir,
        });
        return ro1.outputDir;
      },
    },
    {
      key: "outputFilename",
      run: async (a) => {
        const ro2 = await step<{ outputFilename: string }>({
          type: "input",
          name: "outputFilename",
          message: `Output filename (.epub): ${BACK_HINT}`,
          initial: a.outputFilename ?? defaultFilenameFor(a.title ?? ""),
        });
        return ro2.outputFilename;
      },
    },
    {
      key: "concurrency",
      run: async (a) => {
        disp.section("Performance and Stealth");
        const defConcurrency = profile?.concurrency ?? appCfg.defaultConcurrency;
        const rp1 = await step<{ concurrency: string }>({
          type: "input",
          name: "concurrency",
          message: `Concurrent browser pages (1 to 5): ${BACK_HINT}`,
          initial: String(a.concurrency ?? defConcurrency),
          validate: (v: string) => {
            const n = parseInt(v, 10);
            return (!isNaN(n) && n >= 1 && n <= 5) || "Must be between 1 and 5";
          },
        });
        return parseInt(rp1.concurrency, 10);
      },
    },
    {
      key: "delayRange",
      run: async (a) => {
        const defDelayMin = profile?.delayMin ?? appCfg.defaultDelayMin;
        const defDelayMax = profile?.delayMax ?? appCfg.defaultDelayMax;
        const rp2 = await step<{ delayRange: string }>({
          type: "input",
          name: "delayRange",
          message: `Delay range between requests in milliseconds (min-max): ${BACK_HINT}`,
          initial: a.delayRange ?? `${defDelayMin}-${defDelayMax}`,
          validate: (v: string) => {
            const [x, y] = v.split("-").map(Number);
            return (!isNaN(x) && !isNaN(y) && x >= 0 && y >= x) || "Format: min-max";
          },
        });
        return rp2.delayRange;
      },
    },
    {
      key: "confirmed",
      run: async (a) => {
        disp.section("Review and Confirm");
        console.log("");
        disp.info(`Novel   : ${chalk.cyan(a.title!)}`);
        disp.info(`Method  : ${chalk.cyan(a.method!)}`);
        if (a.method === "sequential" && a.nextButtonLocators?.length) {
          a.nextButtonLocators.forEach((l, i) => {
            const tag =
              i === 0 ? chalk.cyan("primary ") : chalk.yellow(`fallback ${i}`);
            disp.info(`Next [${tag}]: ${chalk.white(formatLocator(l))}`);
          });
        }
        if (profile)
          disp.info(
            `Profile : ${chalk.cyan(profile.domain)} ${chalk.dim("(pre-filled)")}`,
          );
        disp.info(`Threads : ${chalk.cyan(String(a.concurrency))}`);
        disp.info(`Delay   : ${chalk.cyan(a.delayRange!)} ms`);
        disp.info(`Output  : ${chalk.cyan(a.outputDir + "/" + a.outputFilename)}`);
        console.log("");
        disp.dim(`Escape goes back to change something · Ctrl+Q quits`);
        console.log("");

        const { confirmed } = await step<{ confirmed: boolean }>({
          type: "confirm",
          name: "confirmed",
          message: "Start scraping with these settings?",
          initial: true,
        });

        if (!confirmed) {
          console.log(chalk.yellow("\n  Aborted by user.\n"));
          process.exit(0);
        }
        return true;
      },
    },
  ];

  const answers = await runWizard<ConfigAnswers>(steps);

  const [delayMin, delayMax] = answers.delayRange.split("-").map(Number);

  const meta: NovelMetadata = {
    title: answers.title,
    author: answers.author,
    language: answers.language,
    publisher: answers.publisher,
    synopsis: answers.hasSynopsis ? answers.synopsis : undefined,
    coverSource: answers.coverSource,
    coverUrl: answers.coverSource === "url" ? answers.coverUrl : undefined,
    coverPath: answers.coverSource === "file" ? answers.coverPath : undefined,
  };

  return {
    method: answers.method,
    tocUrl: answers.method === "toc" ? answers.tocUrl : undefined,
    chapterLinks: [],
    firstChapterUrl:
      answers.method === "sequential" ? answers.firstChapterUrl : undefined,
    lastChapterUrl:
      answers.method === "sequential" ? answers.lastChapterUrl : undefined,
    nextButtonLocators:
      answers.method === "sequential" ? answers.nextButtonLocators : undefined,
    contentSelector: answers.contentSelector,
    separateTitle: answers.separateTitle,
    titleSelector: answers.separateTitle ? answers.titleSelector : undefined,
    excludeSelectors: answers.hasExclusions ? answers.excludeSelectors : [],
    metadata: meta,
    outputDir: answers.outputDir.trim(),
    outputFilename: answers.outputFilename.trim(),
    concurrency: answers.concurrency,
    delayMin,
    delayMax,
    headless: appCfg.headless,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  gatherAutoConfig — full review/edit screen for an AUTO scrape.
//  Same runWizard treatment as gatherConfig above; the method/URL-collection
//  steps don't apply here since the SiteAdapter already resolved those.
// ═══════════════════════════════════════════════════════════════════════════
interface AutoConfigAnswers {
  contentSelector: string;
  separateTitle: boolean;
  titleSelector: string;
  hasExclusions: boolean;
  excludeSelectors: string[];
  title: string;
  author: string;
  language: string;
  publisher: string;
  hasSynopsis: boolean;
  synopsis: string;
  coverSource: CoverSource;
  coverUrl: string;
  coverPath: string;
  outputDir: string;
  outputFilename: string;
  concurrency: number;
  delayRange: string;
  confirmed: boolean;
}

export async function gatherAutoConfig(
  appCfg: AppConfig,
  profile: SiteProfile | null,
  adapter: SiteAdapter,
  auto: AutoScrapeResult,
): Promise<ScraperConfig> {
  disp.banner();

  disp.section("Auto-Scrape Review");
  disp.success(`Site        : ${adapter.label}`);
  disp.info(`Novel       : ${chalk.cyan(auto.metadata.title)}`);
  disp.info(`Author      : ${chalk.cyan(auto.metadata.author)}`);
  disp.info(`Chapters    : ${chalk.cyan(String(auto.chapterLinks.length))}`);
  if (auto.metadata.coverUrl)
    disp.info(`Cover       : ${chalk.dim(auto.metadata.coverUrl)}`);
  console.log("");
  disp.dim(
    "Every field below was filled in automatically from the site. Review each one and change anything that does not look right before the scrape begins.",
  );
  console.log("");

  if (profile) {
    disp.section("Site Profile Loaded");
    disp.success(`Found a saved profile for ${chalk.cyan(profile.domain)}`);
    disp.dim(`Label: ${profile.label ?? "(no label)"}`);
    console.log("");
  }

  const steps: WizardStep<AutoConfigAnswers, keyof AutoConfigAnswers>[] = [
    {
      key: "contentSelector",
      run: async (a) => {
        disp.section("Content Extraction");
        disp.dim(SELECTOR_HINT);
        disp.dim(
          "Pre-filled with this site's default selector. Open one real chapter page in a browser and confirm it matches before running a large batch.",
        );
        console.log("");
        const { contentSelector } = await step<{ contentSelector: string }>({
          type: "input",
          name: "contentSelector",
          message: `Chapter content container: ${BACK_HINT}`,
          hint: 'CSS or XPath  e.g.  .chapter-content  |  //div[@id="chapter-body"]',
          initial:
            a.contentSelector ?? profile?.contentSelector ?? adapter.defaultContentSelector,
          validate: validateNonEmpty("Content selector"),
        });
        return contentSelector.trim();
      },
    },
    {
      key: "separateTitle",
      run: async (a) => {
        const { separateTitle } = await step<{ separateTitle: boolean }>({
          type: "confirm",
          name: "separateTitle",
          message: `Extract the chapter title from a separate element? ${BACK_HINT}`,
          initial: a.separateTitle ?? profile?.separateTitle ?? adapter.defaultSeparateTitle,
        });
        return separateTitle;
      },
    },
    {
      key: "titleSelector",
      skip: (a) => !a.separateTitle,
      run: async (a) => {
        const r = await step<{ titleSelector: string }>({
          type: "input",
          name: "titleSelector",
          message: `Chapter title element: ${BACK_HINT}`,
          hint: 'CSS or XPath  e.g.  .chapter-title  |  //h1[@class="title"]',
          initial:
            a.titleSelector ?? profile?.titleSelector ?? adapter.defaultTitleSelector ?? "",
          validate: validateNonEmpty("Title selector"),
        });
        return r.titleSelector.trim();
      },
    },
    {
      key: "hasExclusions",
      run: async (a) => {
        disp.section("Exclusions (optional)");
        const profileExcludes = profile?.excludeSelectors ?? adapter.defaultExcludeSelectors;
        const { hasExclusions } = await step<{ hasExclusions: boolean }>({
          type: "confirm",
          name: "hasExclusions",
          message: `Exclude any elements from the scraped content (e.g. ads, author notes)? ${BACK_HINT}`,
          initial: a.hasExclusions ?? profileExcludes.length > 0,
        });
        return hasExclusions;
      },
    },
    {
      key: "excludeSelectors",
      skip: (a) => !a.hasExclusions,
      run: async (a) => {
        const profileExcludes = profile?.excludeSelectors ?? adapter.defaultExcludeSelectors;
        disp.dim(
          "CSS and XPath are both accepted. Separate multiple selectors with commas.",
        );
        const r = await step<{ exclusionList: string }>({
          type: "input",
          name: "exclusionList",
          message: "Selectors to exclude:",
          initial: a.excludeSelectors?.join(", ") ?? profileExcludes.join(", "),
        });
        return r.exclusionList
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    {
      key: "title",
      run: async (a) => {
        disp.section("Novel Metadata");
        const r = await step<{ title: string }>({
          type: "input",
          name: "title",
          message: `Novel title: ${BACK_HINT}`,
          initial: a.title ?? auto.metadata.title,
          validate: validateNonEmpty("Title"),
        });
        return r.title.trim();
      },
    },
    {
      key: "author",
      run: async (a) => {
        const r = await step<{ author: string }>({
          type: "input",
          name: "author",
          message: `Author name: ${BACK_HINT}`,
          initial: a.author ?? (auto.metadata.author || appCfg.defaultAuthor),
        });
        return r.author.trim() || appCfg.defaultAuthor;
      },
    },
    {
      key: "language",
      run: async (a) => {
        const r = await step<{ language: string }>({
          type: "input",
          name: "language",
          message: `Language code (ISO 639-1): ${BACK_HINT}`,
          initial: a.language ?? appCfg.defaultLanguage,
        });
        return r.language.trim() || appCfg.defaultLanguage;
      },
    },
    {
      key: "publisher",
      run: async (a) => {
        const r = await step<{ publisher: string }>({
          type: "input",
          name: "publisher",
          message: `Publisher or source (optional): ${BACK_HINT}`,
          initial: a.publisher ?? appCfg.defaultPublisher,
        });
        return r.publisher.trim() || appCfg.defaultPublisher;
      },
    },
    {
      key: "hasSynopsis",
      run: async (a) => {
        if (auto.metadata.description) {
          disp.section("Synopsis (auto-fetched)");
          disp.printParagraphs(auto.metadata.description);
          console.log("");
        }
        const { hasSynopsis } = await step<{ hasSynopsis: boolean }>({
          type: "confirm",
          name: "hasSynopsis",
          message: `Include a synopsis or description? ${BACK_HINT}`,
          initial: a.hasSynopsis ?? auto.metadata.description.length > 0,
        });
        return hasSynopsis;
      },
    },
    {
      key: "synopsis",
      skip: (a) => !a.hasSynopsis,
      run: async (a) => {
        if (a.synopsis !== undefined) {
          // Returning to re-edit after already having made a choice here —
          // just re-open the free-form editor on whatever was there.
          return promptMultilineText("Synopsis", a.synopsis);
        }
        if (auto.metadata.description) {
          const { editSynopsis } = await step<{ editSynopsis: boolean }>({
            type: "confirm",
            name: "editSynopsis",
            message:
              "Edit the auto-fetched synopsis? (No keeps it exactly as fetched, line breaks and all)",
            initial: false,
          });
          return editSynopsis
            ? promptMultilineText("Synopsis", auto.metadata.description)
            : auto.metadata.description;
        }
        return promptMultilineText("Synopsis");
      },
    },
    {
      key: "coverSource",
      run: async (a) => {
        const { coverSource } = await step<{ coverSource: string }>({
          type: "select",
          name: "coverSource",
          message: `Cover image: ${BACK_HINT}`,
          choices: [
            { name: "none", message: "No cover image" },
            { name: "url", message: "Download the cover from a URL" },
            { name: "file", message: "Use a local image file as the cover" },
          ],
          initial: a.coverSource ?? (auto.metadata.coverUrl ? "url" : "none"),
        });
        return coverSource as CoverSource;
      },
    },
    {
      key: "coverUrl",
      skip: (a) => a.coverSource !== "url",
      run: async (a) => {
        const rc = await step<{ coverUrl: string }>({
          type: "input",
          name: "coverUrl",
          message: `Cover image URL: ${BACK_HINT}`,
          initial: a.coverUrl ?? auto.metadata.coverUrl ?? "",
          validate: validateUrl,
        });
        return rc.coverUrl.trim();
      },
    },
    {
      key: "coverPath",
      skip: (a) => a.coverSource !== "file",
      run: async (a) => {
        const rc = await step<{ coverPath: string }>({
          type: "input",
          name: "coverPath",
          message: `Path to cover image file: ${BACK_HINT}`,
          initial: a.coverPath ?? "",
          validate: validateNonEmpty("Path"),
        });
        return rc.coverPath.trim();
      },
    },
    {
      key: "outputDir",
      run: async (a) => {
        disp.section("Output Settings");
        const ro1 = await step<{ outputDir: string }>({
          type: "input",
          name: "outputDir",
          message: `Output directory: ${BACK_HINT}`,
          initial: a.outputDir ?? appCfg.defaultOutputDir,
        });
        return ro1.outputDir;
      },
    },
    {
      key: "outputFilename",
      run: async (a) => {
        const ro2 = await step<{ outputFilename: string }>({
          type: "input",
          name: "outputFilename",
          message: `Output filename (.epub): ${BACK_HINT}`,
          initial: a.outputFilename ?? defaultFilenameFor(a.title ?? ""),
        });
        return ro2.outputFilename;
      },
    },
    {
      key: "concurrency",
      run: async (a) => {
        disp.section("Performance and Stealth");
        const defConcurrency = profile?.concurrency ?? appCfg.defaultConcurrency;
        const rp1 = await step<{ concurrency: string }>({
          type: "input",
          name: "concurrency",
          message: `Concurrent browser pages (1 to 5): ${BACK_HINT}`,
          initial: String(a.concurrency ?? defConcurrency),
          validate: (v: string) => {
            const n = parseInt(v, 10);
            return (!isNaN(n) && n >= 1 && n <= 5) || "Must be between 1 and 5";
          },
        });
        return parseInt(rp1.concurrency, 10);
      },
    },
    {
      key: "delayRange",
      run: async (a) => {
        const defDelayMin = profile?.delayMin ?? appCfg.defaultDelayMin;
        const defDelayMax = profile?.delayMax ?? appCfg.defaultDelayMax;
        const rp2 = await step<{ delayRange: string }>({
          type: "input",
          name: "delayRange",
          message: `Delay range between requests in milliseconds (min-max): ${BACK_HINT}`,
          initial: a.delayRange ?? `${defDelayMin}-${defDelayMax}`,
          validate: (v: string) => {
            const [x, y] = v.split("-").map(Number);
            return (!isNaN(x) && !isNaN(y) && x >= 0 && y >= x) || "Format: min-max";
          },
        });
        return rp2.delayRange;
      },
    },
    {
      key: "confirmed",
      run: async (a) => {
        disp.section("Review and Confirm");
        console.log("");
        disp.info(`Novel      : ${chalk.cyan(a.title!)}`);
        disp.info(`Author     : ${chalk.cyan(a.author!)}`);
        disp.info(`Chapters   : ${chalk.cyan(String(auto.chapterLinks.length))}`);
        disp.info(`Content sel: ${chalk.cyan(a.contentSelector!)}`);
        if (profile)
          disp.info(
            `Profile    : ${chalk.cyan(profile.domain)} ${chalk.dim("(pre-filled)")}`,
          );
        disp.info(`Threads    : ${chalk.cyan(String(a.concurrency))}`);
        disp.info(`Delay      : ${chalk.cyan(a.delayRange!)} ms`);
        disp.info(`Output     : ${chalk.cyan(a.outputDir + "/" + a.outputFilename)}`);
        console.log("");
        disp.dim(`Escape goes back to change something · Ctrl+Q quits`);
        console.log("");

        const { confirmed } = await step<{ confirmed: boolean }>({
          type: "confirm",
          name: "confirmed",
          message: "Start scraping with these settings?",
          initial: true,
        });

        if (!confirmed) {
          console.log(chalk.yellow("\n  Aborted by user.\n"));
          process.exit(0);
        }
        return true;
      },
    },
  ];

  const answers = await runWizard<AutoConfigAnswers>(steps);
  const [delayMin, delayMax] = answers.delayRange.split("-").map(Number);

  const meta: NovelMetadata = {
    title: answers.title,
    author: answers.author,
    language: answers.language,
    publisher: answers.publisher,
    synopsis: answers.hasSynopsis ? answers.synopsis : undefined,
    coverSource: answers.coverSource,
    coverUrl: answers.coverSource === "url" ? answers.coverUrl : undefined,
    coverPath: answers.coverSource === "file" ? answers.coverPath : undefined,
  };

  return {
    method: "toc",
    tocUrl: adapter.getTocUrl(auto.novelUrl),
    chapterLinks: auto.chapterLinks,
    contentSelector: answers.contentSelector,
    separateTitle: answers.separateTitle,
    titleSelector: answers.separateTitle ? answers.titleSelector : undefined,
    excludeSelectors: answers.hasExclusions ? answers.excludeSelectors : [],
    metadata: meta,
    outputDir: answers.outputDir.trim(),
    outputFilename: answers.outputFilename.trim(),
    concurrency: answers.concurrency,
    delayMin,
    delayMax,
    headless: appCfg.headless,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  buildQuickAutoConfig — the fast path for auto-scraping. No prompts here,
//  unchanged.
// ═══════════════════════════════════════════════════════════════════════════
export function buildQuickAutoConfig(
  appCfg: AppConfig,
  profile: SiteProfile | null,
  adapter: SiteAdapter,
  auto: AutoScrapeResult,
): ScraperConfig {
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

  const outputFilename = defaultFilenameFor(metadata.title);

  return {
    method: "toc",
    tocUrl: adapter.getTocUrl(auto.novelUrl),
    chapterLinks: auto.chapterLinks,
    contentSelector,
    separateTitle,
    titleSelector,
    excludeSelectors,
    metadata,
    outputDir: appCfg.defaultOutputDir,
    outputFilename,
    concurrency: profile?.concurrency ?? appCfg.defaultConcurrency,
    delayMin: profile?.delayMin ?? appCfg.defaultDelayMin,
    delayMax: profile?.delayMax ?? appCfg.defaultDelayMax,
    headless: appCfg.headless,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chapter link editor
//
//  Not restructured into runWizard (it's an action menu you loop through,
//  not a linear sequence — "back" doesn't really apply). Escape is still
//  made safe here though: it cancels whichever sub-action you were in the
//  middle of (remove/add) and returns to the action menu, rather than
//  crashing or bailing out of the whole chapter review screen.
// ═══════════════════════════════════════════════════════════════════════════
export async function editChapterLinks(links: string[]): Promise<string[]> {
  disp.section("Chapter List Review");
  disp.info(`Found ${chalk.cyan(String(links.length))} chapters`);
  disp.printChapterList(links);
  console.log("");

  let current = [...links];

  while (true) {
    const { action } = await step<{ action: string }>({
      type: "select",
      name: "action",
      message: "What would you like to do?",
      choices: [
        {
          name: "proceed",
          message: `Proceed with all ${current.length} chapters`,
        },
        { name: "remove", message: "Remove chapters by index or range" },
        { name: "add", message: "Add chapter URLs" },
        { name: "reverse", message: "Reverse the order (first becomes last)" },
        { name: "view", message: "View the full chapter list" },
      ],
    });

    if (action === "proceed") break;

    if (action === "reverse") {
      current.reverse();
      disp.success(`Order reversed — now starts at: ${chalk.dim(current[0])}`);
      disp.printChapterList(current);
    } else if (action === "view") {
      disp.printChapterList(current, current.length);
    } else if (action === "remove") {
      try {
        disp.info("Enter indices or ranges to remove, separated by commas.");
        disp.dim("Examples:  5  |  10-20  |  5, 10-20, 99");
        const { rangeStr } = await step<{ rangeStr: string }>({
          type: "input",
          name: "rangeStr",
          message: "Indices / ranges to remove:",
        });
        const toRemove = parseRanges(rangeStr, current.length);
        const before = current.length;
        current = current.filter((_, i) => !toRemove.has(i + 1));
        disp.success(
          `Removed ${before - current.length} chapter(s). ${current.length} remaining.`,
        );
      } catch (e) {
        if (!(e instanceof WizardBack)) throw e;
        disp.dim("Cancelled — nothing removed.");
      }
    } else if (action === "add") {
      try {
        const { rawUrls } = await step<{ rawUrls: string }>({
          type: "input",
          name: "rawUrls",
          message: "Enter URLs to add (comma or newline separated):",
        });
        const added = rawUrls
          .split(/[\n,]+/)
          .map((u) => u.trim())
          .filter((u) => {
            try {
              new URL(u);
              return true;
            } catch {
              return false;
            }
          });
        current.push(...added);
        disp.success(`Added ${added.length} URL(s). ${current.length} total.`);
      } catch (e) {
        if (!(e instanceof WizardBack)) throw e;
        disp.dim("Cancelled — nothing added.");
      }
    }
  }

  return current;
}

function parseRanges(input: string, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-").map(Number);
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = Math.max(1, a); i <= Math.min(max, b); i++) result.add(i);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= max) result.add(n);
    }
  }
  return result;
}
