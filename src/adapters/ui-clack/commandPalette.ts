// ─────────────────────────────────────────────────────────────────────────────
//  commandPalette - bare ':' prompt that maps to navigation.
//  Per readme §2.4: open on MainScreen (and any menu screen); commands
//  :resume / :cookies / :settings / :library / :quit map to the same
//  navigation as the menu. :new is registered but stubbed until Phase 4.
//  Unknown commands render a one-line warn and loop.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel, type PromptProvider } from "./PromptProvider.js";
import type { ScreenResult } from "./ShellContext.js";

export type PaletteCommand =
  | "main"
  | "resume"
  | "cookies"
  | "settings"
  | "library"
  | "new"
  | "quit";

const COMMANDS: PaletteCommand[] = ["main", "resume", "cookies", "settings", "library", "new", "quit"];

export function knownCommand(cmd: string): cmd is PaletteCommand {
  return (COMMANDS as string[]).includes(cmd);
}

/**
 * Render the palette loop. Returns the navigation result once a known command
 * is entered, or null if the user cancels (Esc). Unknown commands emit a
 * one-line warn and the loop re-opens (readme §2.4).
 */
export async function commandPaletteLoop(
  prompt: PromptProvider,
): Promise<ScreenResult | null> {
  while (true) {
    const raw = await prompt.text({
      message: "Command:",
      placeholder: ":resume · :cookies · :settings · :library · :quit (Esc to cancel)",
    });
    if (raw === Cancel) return null;
    let cmd = raw.trim();
    if (cmd.startsWith(":")) cmd = cmd.slice(1);
    if (cmd === "") return null;
    if (!knownCommand(cmd)) {
      prompt.log("warn", `Unknown command: "${cmd}". Try :resume / :cookies / :settings / :library / :quit.`);
      continue;
    }
    switch (cmd) {
      case "main":
        return { action: "replace", screen: "main" };
      case "resume":
        return { action: "push", screen: "resume" };
      case "cookies":
        return { action: "push", screen: "cookies" };
      case "settings":
        return { action: "push", screen: "settings" };
      case "library":
        return { action: "push", screen: "library" };
      case "new":
        // Phase 4 stub (ADR-P3-E): notice + stay in the palette loop (no
        // navigation to a half-built wizard).
        prompt.log("warn", "Scraping flows arrive in Phase 4 (:new is stubbed).");
        continue;
      case "quit":
        return { action: "quit" };
    }
  }
}
