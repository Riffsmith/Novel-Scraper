// ─────────────────────────────────────────────────────────────────────────────
//  ChapterListScreen - the table review action loop (readme §2.6).
//
//  Not a Clack `group()` wizard - a single-screen action menu that loops.
//  Renders the current chapter list numbered; offers proceed / remove / add /
//  reverse / view actions. Returns the final list when the user proceeds.
//
//  v1 (`editChapterLinks` `:1197-1277`) behavior preserved:
//    - remove by index/ranges (`parseRanges`): `5`, `10-20`, `5, 10-20, 99`.
//    - add: comma- or newline-separated URL list, valid-URL filter.
//    - reverse: WITH CONFIRM (order is almost always intentional).
//    - view: re-print the full list.
//    - proceed with zero chapters returns a "nothing to scrape" notice.
//
//  The screen mutates an in-memory array and returns the final list when
//  the user proceeds, so callers (manual post-discovery + customize path)
//  share one reviewer. `parseRanges` lives in `validation.ts` (pure).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import { parseRanges } from "../validation.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";

type Action = "proceed" | "remove" | "add" | "reverse" | "view" | "back";

export interface ChapterListParams {
  urls: string[];
  /** Caller title for the section header. Defaults to "Chapter List Review". */
  title?: string;
  /** Manual post-discovery path carries the job + resolved cookies + domain
   * context so a "proceed" hands them off to TaskScreen. The auto customize
   * path uses ChapterListScreen for the review while deciding later. */
  job?: import("../../../core/domain/JobConfig.js").JobConfig;
  cookies?: import("../../../core/domain/Cookie.js").DomainCookie[];
  domain?: string;
  isNewDomain?: boolean;
  /** `true` when reached from the manual flow - "proceed" pushes TaskScreen.
   * False: just pops and returns the edited list (auto flow will push
   * AutoCustomizeScreen on its own). */
  manual?: boolean;
  /** Auto customize path: on proceed, `replace` this screen id with the
   * edited urls (plus any caller-supplied `replaceParams`) so the chapter
   * list review feeds straight into AutoCustomizeScreen without the
   * caller having to re-render. Mutually exclusive with `manual`. */
  nextScreen?: string;
  /** Extra params merged into the `replace` payload when `nextScreen` is set.
   * Carries the AutoScrapeResult + adapter + cookies + domain the
   * AutoCustomizeScreen needs. */
  replaceParams?: Record<string, unknown>;
}

export class ChapterListScreen implements Screen {
  readonly id = "chapter-list";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const cfg = params as ChapterListParams;
    let current = [...cfg.urls];

    while (true) {
      ctx.prompt.log("info", (cfg.title ?? "Chapter List Review"));
      ctx.prompt.log("info", `Found ${current.length} chapter(s)`);
      printChapterList(ctx, current);

      const action = await ctx.prompt.select<Action>({
        message: "What would you like to do?",
        options: [
          { value: "proceed", label: `Proceed with all ${current.length} chapters` },
          { value: "remove", label: "Remove chapters by index or range" },
          { value: "add", label: "Add chapter URLs" },
          { value: "reverse", label: "Reverse the order (first becomes last)" },
          { value: "view", label: "View the full chapter list" },
          { value: "back", label: "Cancel and go back" },
        ],
      });

      if (action === Cancel || action === "back") {
        return { action: "pop" };
      }
      if (action === "proceed") {
        if (current.length === 0) {
          ctx.prompt.log("warn", "No chapters left - nothing to scrape.");
          await ctx.prompt.text({ message: "Press Enter to return..." }).catch(() => {});
          return { action: "pop" };
        }
        // Manual path: push TaskScreen to scrape the edited list straight
        // away. The auto path forwards the edited list back to the caller
        // (AutoProbeScreen) for AutoCustomizeScreen to consume - design
        // §2.6, ChapterListScreen is a pure-in-adapter helper here too.
        if (cfg.manual && cfg.job) {
          return {
            action: "push",
            screen: "task",
            params: {
              job: cfg.job,
              chapterUrls: current,
              cookies: cfg.cookies,
              domain: cfg.domain,
              isNewDomain: cfg.isNewDomain,
            },
          };
        }
        if (cfg.nextScreen) {
          return {
            action: "replace",
            screen: cfg.nextScreen,
            params: { ...cfg.replaceParams, chapterLinks: current },
          };
        }
        return { action: "pop" };
      }
      if (action === "reverse") {
        const ok = await ctx.prompt.confirm({
          message: "Reverse the order? (first becomes last, last becomes first)",
          initial: false,
        });
        if (ok === Cancel) continue;
        if (!ok) continue;
        current.reverse();
        ctx.prompt.log("success", `Order reversed - now starts at: ${current[0] ?? "(none)"}`);
        continue;
      }
      if (action === "view") {
        printChapterList(ctx, current, current.length);
        continue;
      }
      if (action === "remove") {
        ctx.prompt.log("info", "Enter indices or ranges to remove, separated by commas.");
        ctx.prompt.log("dim", "Examples:  5  |  10-20  |  5, 10-20, 99");
        const r = await ctx.prompt.text({
          message: "Indices / ranges to remove:",
        });
        if (r === Cancel) {
          ctx.prompt.log("dim", "Cancelled - nothing removed.");
          continue;
        }
        const toRemove = parseRanges(r, current.length);
        const before = current.length;
        current = current.filter((_, i) => !toRemove.has(i + 1));
        ctx.prompt.log("success", `Removed ${before - current.length} chapter(s). ${current.length} remaining.`);
        continue;
      }
      if (action === "add") {
        const r = await ctx.prompt.text({
          message: "Enter URLs to add (comma or newline separated):",
        });
        if (r === Cancel) {
          ctx.prompt.log("dim", "Cancelled - nothing added.");
          continue;
        }
        const added = r
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
        ctx.prompt.log("success", `Added ${added.length} URL(s). ${current.length} total.`);
        continue;
      }
    }
  }
}

function printChapterList(ctx: ShellContext, links: string[], maxDisplay = 50): void {
  const show = links.slice(0, maxDisplay);
  show.forEach((link, i) => {
    ctx.prompt.log("dim", `  ${String(i + 1).padStart(5)}.  ${truncateUrl(link, 80)}`);
  });
  if (links.length > maxDisplay) {
    ctx.prompt.log("dim", `         ... and ${links.length - maxDisplay} more`);
  }
}

function truncateUrl(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}
