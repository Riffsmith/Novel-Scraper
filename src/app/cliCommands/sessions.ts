// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/sessions.ts - `wnscrape sessions ls` / `sessions rm <id>`.
//
//  §1.5 table: mirrors the `ResumeScreen`'s discovery surface (which only
//  lists, never deletes). `rm` is the new delete counterpart (parity with
//  cookies/profiles). Both honor `--json`.
// ─────────────────────────────────────────────────────────────────────────────

import { JsonSessionStore } from "../../adapters/store-json/JsonSessionStore.js";
import { createDefaultWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import type { Logger } from "../../ports/Logger.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";
import type { GlobalCliOpts } from "./run.js";

function newLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope - swap to a silent Logger port so the ONLY
  // stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createDefaultWinstonLogger();
}

export async function sessionsLsCommand(opts: GlobalCliOpts): Promise<void> {
  const command = "sessions ls";
  const log = newLog(opts.json === true);
  try {
    const store = new JsonSessionStore(log);
    const summaries = await store.list();
    if (opts.json) {
      emitJson({ ok: true, command, data: summaries } satisfies JsonResult);
      return;
    }
    if (summaries.length === 0) {
      console.log("No saved session checkpoints.");
      return;
    }
    for (const s of summaries) {
      console.log(`${s.id}  ${s.novelTitle}  ${s.completedCount}/${s.totalChapters}  ${s.domain}  ${s.updatedAt}`);
    }
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "SESSIONS_LS_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

export async function sessionsRmCommand(id: string, opts: GlobalCliOpts): Promise<void> {
  const command = "sessions rm";
  const log = newLog(opts.json === true);
  try {
    const store = new JsonSessionStore(log);
    const removed = await store.delete(id);
    if (opts.json) {
      emitJson({ ok: true, command, data: { id, removed } } satisfies JsonResult);
    } else if (removed) {
      console.log(`Deleted session ${id}`);
    } else {
      console.error(`No session with id ${id}`);
    }
    if (!removed) process.exit(1);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "SESSIONS_RM_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}
