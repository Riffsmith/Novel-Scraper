// ─────────────────────────────────────────────────────────────────────────────
//  Resume-a-scrape picker — mirrors the style of tui/cookieManager.ts /
//  tui/configManager.ts's site-profile section: a select-menu loop over
//  saved records, with a delete action alongside.
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";
import * as disp from "./display.js";
import { step, WizardBack } from "./wizard.js";
import { listSessions, deleteSession } from "../sessions/store.js";
import type { ScrapeSession } from "../types.js";

function formatUpdatedAt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function sessionLine(s: ScrapeSession): string {
  const progress = `${s.completedChapters.length}/${s.chapterUrls.length} chapters`;
  return `${chalk.cyan(s.novelTitle)}  ${chalk.dim(`(${progress} · ${s.domain} · updated ${formatUpdatedAt(s.updatedAt)})`)}`;
}

// Returns the chosen session, or null if the user backed out (via the
// "Back" choice or by pressing Escape).
export async function pickResumableSession(): Promise<ScrapeSession | null> {
  while (true) {
    const sessions = listSessions();
    if (sessions.length === 0) return null;

    disp.section("Resume a Previous Scrape");

    let chosen: string;
    try {
      const r = await step<{ chosen: string }>({
        type: "select",
        name: "chosen",
        message: "Select a scrape to resume, or manage saved sessions:",
        choices: [
          ...sessions.map((s) => ({ name: s.id, message: sessionLine(s) })),
          { name: "__delete__", message: chalk.red("Delete a saved session") },
          { name: "__back__", message: chalk.dim("Back") },
        ],
      });
      chosen = r.chosen;
    } catch (e) {
      if (e instanceof WizardBack) return null;
      throw e;
    }

    if (chosen === "__back__") return null;

    if (chosen === "__delete__") {
      await deleteSessionFlow(sessions);
      continue; // re-list, in case the count changed
    }

    return sessions.find((s) => s.id === chosen) ?? null;
  }
}

async function deleteSessionFlow(sessions: ScrapeSession[]): Promise<void> {
  try {
    const { toDelete } = await step<{ toDelete: string }>({
      type: "select",
      name: "toDelete",
      message: "Delete which session? (only removes the checkpoint — nothing already downloaded is affected)",
      choices: [
        ...sessions.map((s) => ({
          name: s.id,
          message: `${s.novelTitle}  ${chalk.dim(s.domain)}`,
        })),
        { name: "__cancel__", message: chalk.dim("Cancel") },
      ],
    });

    if (toDelete === "__cancel__") return;

    deleteSession(toDelete);
    disp.success("Session deleted.");
  } catch (e) {
    if (e instanceof WizardBack) return;
    throw e;
  }
}
