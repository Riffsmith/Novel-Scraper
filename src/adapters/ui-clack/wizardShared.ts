// ─────────────────────────────────────────────────────────────────────────────
//  wizardShared - the locator / multiline / fallback sub-flows shared by
//  ManualWizardScreen and AutoCustomizeScreen (readme §1.2 / §2.4).
//
//  These are pure ui-clack adapter helpers ported verbatim from v1
//  src/tui/prompts.ts:
//    - promptLocator (kind -> value -> [flags] for css/xpath/regex)
//    - promptMultilineText (one-paragraph-at-a-time editor)
//    - appendFallbacks (the "add fallback #N" loop with the running
//      "priority order" print)
//
//  v1 channels these through runWizard (src/tui/wizard.ts:57-88) so Escape can
//  step back one *field*. v2 routes them through PromptProvider's Cancel
//  symbol - the ManualWizardScreen keeps an in-memory answer object + a small
//  back-stack that mirrors runWizard's skip-aware walk (readme §2.4) so Escape
//  on a group moves back one *group*. The sub-flows here merely need to honour
//  Cancel by returning it up to the outer screen for that back-stack to catch.
//
//  XPath strips the `xpath=` prefix exactly like v1 (:115); regex flags
//  default to 'i' (:151); fallback loop appends and prints the priority order
//  exactly like v1 (:217-227).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel, type PromptProvider } from "./PromptProvider.js";
import { formatLocator } from "../../core/services/SelectorService.js";
import { validateNonEmpty, validateRegex, validateRegexFlags } from "./validation.js";
import type { NextLocator } from "../../core/domain/Locator.js";

export type { Cancel };

/** Locating type chosen from the locator-kind selector. */
export type LocatorKind = "css" | "xpath" | "regex";

const XPATH_PREFIX_RE = /^xpath=/i;

/**
 * promptLocator - v1 src/tui/prompts.ts:62-159 ported to the PromptProvider
 * seam. Each step returns `Cancel` on Escape, which the caller rethrows to
 * the group back-stack exactly as the outer wizard does.
 */
export async function promptLocator(
  prompt: PromptProvider,
  label: string,
  prefill?: NextLocator,
): Promise<NextLocator | typeof Cancel> {
  const kindRes = await prompt.select<LocatorKind>({
    message: `${label} - locator type:`,
    options: [
      { value: "css", label: `CSS selector  e.g. .btn-next  a[rel="next"]  #nextchap` },
      { value: "xpath", label: `XPath expression  e.g. //a[contains(@class,"next")]` },
      { value: "regex", label: `Regex text match  e.g. >>  Next Chapter  下一章` },
    ],
    initial: prefill?.kind ?? "css",
  });
  if (kindRes === Cancel) return Cancel;

  let value: string;
  if (kindRes === "css") {
    const v = await prompt.text({
      message: "CSS selector:",
      placeholder: '.next-chapter  |  a[rel="next"]  |  #btn-next',
      initial: prefill?.kind === "css" ? prefill.value : "",
      validate: validateNonEmpty("Selector"),
    });
    if (v === Cancel) return Cancel;
    value = v.trim();
  } else if (kindRes === "xpath") {
    const v = await prompt.text({
      message: "XPath expression:",
      placeholder: '//a[contains(@class,"next")]  |  //p/a[last()]',
      initial: prefill?.kind === "xpath" ? prefill.value : "",
      validate: validateNonEmpty("XPath expression"),
    });
    if (v === Cancel) return Cancel;
    value = v.trim().replace(XPATH_PREFIX_RE, "");
  } else {
    prompt.log("dim", "Matched against the visible text and title attribute of every <a href> on the page.");
    const v = await prompt.text({
      message: "Regex pattern (no / delimiters):",
      placeholder: ">>  |  Next\\s*Chapter  |  下一章",
      initial: prefill?.kind === "regex" ? prefill.value : "",
      validate: validateRegex,
    });
    if (v === Cancel) return Cancel;
    value = v.trim();
  }

  if (kindRes === "regex") {
    const flags = await prompt.text({
      message: "Regex flags:",
      initial: prefill?.flags ?? "i",
      hint: "i = case-insensitive, u = unicode (needed for CJK text)",
      validate: validateRegexFlags,
    });
    if (flags === Cancel) return Cancel;
    return { kind: "regex", value, flags: flags.trim() || "i" };
  }
  return { kind: kindRes, value };
}

/**
 * promptMultilineText - v1 src/tui/prompts.ts:161-184 port. Enter paragraphs
 * one at a time; a blank line terminates; joins with `\n\n` between
 * paragraphs. If the user cancels every prompt, returns the existing value
 * (matching v1's "if no paragraphs were entered" branch).
 */
export async function promptMultilineText(
  prompt: PromptProvider,
  label: string,
  existing?: string,
): Promise<string | typeof Cancel> {
  prompt.log("dim", `Enter "${label}" one paragraph at a time. Leave a line blank when you are done.`);
  const paragraphs: string[] = [];
  let idx = 1;
  while (true) {
    const line = await prompt.text({
      message: `Paragraph ${idx} (blank = done):`,
    });
    if (line === Cancel) return Cancel;
    if (!line.trim()) break;
    paragraphs.push(line.trim());
    idx++;
  }
  if (paragraphs.length === 0) return existing?.trim() ?? "";
  return paragraphs.join("\n\n");
}

/**
 * appendFallbacks - v1 src/tui/prompts.ts:191-229 port. Offers to add fallback
 * locators after the primary, looping with a running "priority order" print.
 * Cancel aborts the whole fallback-adding pass (v1 has no per-item undo,
 * readme §1.2).
 */
export async function appendFallbacks(
  prompt: PromptProvider,
  locators: NextLocator[],
): Promise<NextLocator[] | typeof Cancel> {
  const wantFallbacks = await prompt.confirm({
    message:
      "Add fallback locators? (only needed when the layout changes partway through the novel)",
    initial: false,
  });
  if (wantFallbacks === Cancel) return Cancel;
  if (!wantFallbacks) return locators;

  let idx = 1;
  while (true) {
    const addAnother = await prompt.confirm({
      message: `Add fallback #${idx}?`,
      initial: true,
    });
    if (addAnother === Cancel) return Cancel;
    if (!addAnother) break;

    const fb = await promptLocator(prompt, `Fallback #${idx}`);
    if (fb === Cancel) return Cancel;
    locators.push(fb);

    prompt.log("info", "Locator priority order:");
    locators.forEach((l, i) => {
      const tag = i === 0 ? "primary" : `fallback ${i}`;
      prompt.log("info", `  ${i + 1}. [${tag}]  ${formatLocator(l)}`);
    });
    idx++;
  }
  return locators;
}
