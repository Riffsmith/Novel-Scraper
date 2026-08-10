// ─────────────────────────────────────────────────────────────────────────────
//  ResumeScreen - list/delete session checkpoints (readme §1.3 / §2.4).
//
//  v1 behaviour preserved (sessionManager.ts):
//   - List sessions by `updatedAt` desc; each line is the `sessionLine`
//     format pulled from `format.ts`.
//   - `Delete a saved session` and `Back` sentinel choices.
//   - deleteSessionFlow picks one to delete (no confirm: delete is
//     non-destructive - only the checkpoint goes, downloads are untouched).
//
//  Boundary: the *resume* action (Phase 4 - replaces the Phase 3 stub) pushes
//  TaskScreen with mkResumeParams(session). The cookie re-selection for the
//  resumed domain happens inside TaskScreen exactly like v1 (readme §1.6).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import { mkResumeParams } from "./NewScrapeScreen.js";
import * as fmt from "../format.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";

export class ResumeScreen implements Screen {
  readonly id = "resume";

  async render(ctx: ShellContext): Promise<ScreenResult> {
    while (true) {
      const summaries = await ctx.sessions.list();
      if (summaries.length === 0) {
        ctx.prompt.log(
          "warn",
          "No saved sessions. Run a scrape first, then this screen lists your checkpoints.",
        );
        return { action: "pop" };
      }

      const options = [
        ...summaries.map((s) => ({
          value: `session:${s.id}`,
          label: fmt.sessionLine(s),
        })),
        { value: "__delete__", label: "Delete a saved session" },
        { value: "__back__", label: "Back" },
      ];
      const choice = await ctx.prompt.select<string>({
        message: "Select a scrape to resume, or manage saved sessions:",
        options,
      });

      if (choice === Cancel) return { action: "pop" };
      if (choice === "__back__") return { action: "pop" };
      if (choice === "__delete__") {
        const r = await this.deleteSessionFlow(ctx, summaries);
        if (r === Cancel) return { action: "pop" };
        continue;
      }
      if (choice.startsWith("session:")) {
        const id = choice.slice("session:".length);
        const session = await ctx.sessions.load(id);
        if (!session) {
          ctx.prompt.log(
            "warn",
            `Session ${id} could not be loaded (it may have been deleted).`,
          );
          continue;
        }
        return {
          action: "replace",
          screen: "task",
          params: mkResumeParams(session),
        };
      }
      ctx.prompt.log("warn", `Unknown choice: ${choice}`);
      continue;
    }
  }

  private async deleteSessionFlow(
    ctx: ShellContext,
    summaries: { id: string; novelTitle: string; domain: string }[],
  ): Promise<void | typeof Cancel> {
    const options = [
      ...summaries.map((s) => ({
        value: `del:${s.id}`,
        label: `${s.novelTitle}  ${s.domain}`,
      })),
      { value: "__cancel__", label: "Cancel" },
    ];
    const picked = await ctx.prompt.select<string>({
      message:
        "Delete which session? (only removes the checkpoint - nothing already downloaded is affected)",
      options,
    });
    if (picked === Cancel) return Cancel;
    if (picked === "__cancel__") return;
    if (picked.startsWith("del:")) {
      const id = picked.slice("del:".length);
      const ok = await ctx.sessions.delete(id);
      if (ok) ctx.prompt.log("success", "Session deleted.");
      else
        ctx.prompt.log(
          "warn",
          "Session could not be deleted (already removed?).",
        );
    }
  }
}
