// ─────────────────────────────────────────────────────────────────────────────
//  MainScreen - top-level menu + ':' palette (readme §2.4).
//
//  Menu layout matches 03-tui-design §4.1 exactly (final from day one per
//  ADR-P3-E), including the two Phase-4 stubs ("Start a new scrape" and the
//  resume count badge). Per readme §2.6: cancel on the main screen is a
//  no-op (no screen to pop), and only the palette's `:quit` or Ctrl+Q
//  performs a graceful quit, strictly safer than v1.
//
//  The app banner is rendered ONCE by Shell.run() (header strip, ADR-P3-FIX-
//  TUI) - MainScreen.render emits no banner log row. Re-emitting it on every
//  visit pushed redundant rows into the log region (fix-issue-tui-url-clean-
//  liness §2.4.1).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import { commandPaletteLoop } from "../commandPalette.js";

type MainChoice = "new" | "resume" | "library" | "cookies" | "settings" | "palette" | "quit";

export class MainScreen implements Screen {
  readonly id = "main";

  async render(ctx: ShellContext): Promise<ScreenResult> {
    const sessions = await ctx.sessions.list();
    const resumeLabel = `Resume (${sessions.length} session${sessions.length !== 1 ? "s" : ""})`;

    const choice = await ctx.prompt.select<MainChoice>({
      message: "What do you want to do?",
      options: [
        { value: "new", label: "Start a new scrape" },
        { value: "resume", label: resumeLabel },
        { value: "library", label: "Library" },
        { value: "cookies", label: "Cookies" },
        { value: "settings", label: "Settings & profiles" },
        { value: "palette", label: ": command palette (or just type ':' on this menu)" },
        { value: "quit", label: "Quit" },
      ],
    });

    if (choice === Cancel) {
      // ADR-P3-H: cancel on the root is a no-op (the Shell treats pop-from-
      // root as a no-op). We leave the explicit decision to the Shell so a
      // single Escape/Ctrl+C never kills the app mid-menu.
      return { action: "pop" };
    }

    switch (choice) {
      case "new":
        return { action: "push", screen: "new" };
      case "resume":
        return { action: "push", screen: "resume" };
      case "library":
        return { action: "push", screen: "library" };
      case "cookies":
        return { action: "push", screen: "cookies" };
      case "settings":
        return { action: "push", screen: "settings" };
      case "palette": {
        const r = await commandPaletteLoop(ctx.prompt);
        return r ?? { action: "pop" };
      }
      case "quit":
        return { action: "quit" };
    }
  }
}
