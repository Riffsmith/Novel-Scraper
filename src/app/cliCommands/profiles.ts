// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/profiles.ts - `wnscrape profiles ls` / `profiles rm --domain <d>`.
//
//  §1.5 table: read-only listing mirrors `LibraryScreen`; `rm` mirrors
//  `SettingsScreen`'s delete action. Both honor `--json`.
// ─────────────────────────────────────────────────────────────────────────────

import { JsonProfileStore } from "../../adapters/store-json/JsonProfileStore.js";
import { createWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import logger from "../../logger/index.js";
import type { Logger } from "../../ports/Logger.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";
import type { GlobalCliOpts } from "./run.js";

function newLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope - swap to a silent Logger port so the ONLY
  // stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createWinstonLogger(logger);
}

export async function profilesLsCommand(opts: GlobalCliOpts): Promise<void> {
  const command = "profiles ls";
  const log = newLog(opts.json === true);
  try {
    const store = new JsonProfileStore(log);
    const all = await store.list();
    if (opts.json) {
      emitJson({ ok: true, command, data: all } satisfies JsonResult);
      return;
    }
    const domains = Object.keys(all).sort();
    if (domains.length === 0) {
      console.log("No saved site profiles.");
      return;
    }
    for (const d of domains) {
      const p = all[d];
      const label = p.label ? ` (${p.label})` : "";
      console.log(`${d}${label}  ${p.method}  ${p.contentSelector}  saved ${p.savedAt}`);
    }
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "PROFILES_LS_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

export async function profilesRmCommand(opts: { domain: string } & GlobalCliOpts): Promise<void> {
  const command = "profiles rm";
  const log = newLog(opts.json === true);
  try {
    const store = new JsonProfileStore(log);
    const removed = await store.delete(opts.domain);
    if (opts.json) {
      emitJson({ ok: true, command, data: { domain: opts.domain, removed } } satisfies JsonResult);
    } else if (removed) {
      console.log(`Deleted site profile for ${opts.domain}`);
    } else {
      console.error(`No site profile for ${opts.domain}`);
    }
    if (!removed) process.exit(1);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "PROFILES_RM_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}
