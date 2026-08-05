// ─────────────────────────────────────────────────────────────────────────────
//  ErrorScreen - parity for tui/errors.ts (readme §1.4).
//
//  v1's reportError blocked on a keypress so a failure could never scroll
//  away. Phase 3 honors the same contract via the PromptProvider seam:
//  reportError/notice -> log + a text prompt whose only purpose is "press
//  Enter to continue". For the headless CLI equivalent (ADR-005) the prompt
//  is a no-op - the blocking semantics live in the prompt itself, not the
//  screen.
//
//  Exit-action policy: errors always pop (never push into a flow).
// ─────────────────────────────────────────────────────────────────────────────

import type { Logger } from "../../../ports/Logger.js";
import type { PromptProvider } from "../PromptProvider.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";

export interface ErrorReporter {
  reportError(context: string, e: unknown): Promise<ScreenResult>;
  reportNotice(lines: string[]): Promise<ScreenResult>;
}

/** Construct the ErrorScreen's report helpers (used by other screens). */
export function makeErrorReporter(
  prompt: PromptProvider,
  log: Logger,
): ErrorReporter {
  return {
    async reportError(context, e): Promise<ScreenResult> {
      const err = e as Error;
      log.error(context, { error: err.message, stack: err.stack });
      prompt.log("error", `${context}: ${err.message}`);
      if (err.stack) {
        const first = err.stack.split("\n").slice(1, 5).join("\n");
        prompt.log("dim", first);
      }
      // Block on acknowledge - v1's "Press Enter to return" contract.
      await prompt.text({ message: "Press Enter to return…" });
      return { action: "pop" };
    },
    async reportNotice(lines): Promise<ScreenResult> {
      lines.forEach((l) => prompt.log("warn", l));
      await prompt.text({ message: "Press Enter to continue…" });
      return { action: "pop" };
    },
  };
}

/** ErrorScreen entry-point (used standalone via the `:error` palette). */
export class ErrorScreen implements Screen {
  readonly id = "error";
  constructor(private context: string, private e: unknown, private lines?: string[]) {}
  async render(ctx: ShellContext): Promise<ScreenResult> {
    const reporter = makeErrorReporter(ctx.prompt, ctx.log);
    if (this.lines) return reporter.reportNotice(this.lines);
    return reporter.reportError(this.context, this.e);
  }
}

// Reserved export kept for inline construction (screens register it).
export function makeErrorScreen(context: string, e: unknown): Screen {
  return new ErrorScreen(context, e);
}
