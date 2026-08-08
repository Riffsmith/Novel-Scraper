// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/config.ts - `wnscrape config get / set / reset`.
//
//  §1.5 / §2.5: `set` uses schema-driven coercion (ADR-P5-B) - the zod
//  `appConfigSchema.partial()` parses `{ [key]: rawValue }` and reports the
//  issue on failure; no per-key hand-rolled coercion table.
//
//  Unknown keys parse-error via the zod issue (`.passthrough()` still
//  accepts unknown keys at the document level, but `config set <key>` only
//  ever updates ONE key at a time - feeding a key the schema doesn't know
//  about is the user's typo, surfaced as a parse error). The `fingerprintSeed`
//  string-coercion tweak (ADR-P5-B) lives in the schema itself.
// ─────────────────────────────────────────────────────────────────────────────

import { YamlConfigStore } from "../../adapters/config-yaml/YamlConfigStore.js";
import { appConfigSchema } from "../../adapters/schemas/appConfig.js";
import { createDefaultWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import type { Logger } from "../../ports/Logger.js";
import type { AppConfig } from "../../core/domain/AppConfig.js";
import { DEFAULT_CONFIG } from "../../core/domain/AppConfig.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";
import type { GlobalCliOpts } from "./run.js";

function newLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope - swap to a silent Logger port so the ONLY
  // stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createDefaultWinstonLogger();
}

/** Keys the schema knows about - used for the `unknown key` fast-path. */
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function parseSetInput(key: string, rawValue: string): { value: unknown } | { error: string } {
  // Single-key schema parse: feed the partial schema a one-key object.
  const partial = appConfigSchema.partial();
  const input: Record<string, unknown> = {};
  input[key] = rawValue;

  // If the key isn't a known one at all, surface that distinctly so the
  // error message points at the user's typo rather than zod internals.
  if (!KNOWN_KEYS.has(key)) {
    return { error: `unknown config key "${key}" (valid keys: ${Array.from(KNOWN_KEYS).sort().join(", ")})` };
  }

  const parsed = partial.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue ? `${(issue.path.join(".") || key)}: ${issue.message}` : "parse error" };
  }
  // The parsed.data carries the (possibly coerced) value under `key`.
  return { value: (parsed.data as Record<string, unknown>)[key] };
}

// ── `config get [--key <k>]` ─────────────────────────────────────────────────

export async function configGetCommand(opts: { key?: string } & GlobalCliOpts): Promise<void> {
  const command = "config get";
  const log = newLog(opts.json === true);
  try {
    const store = new YamlConfigStore(log);
    const cfg: AppConfig = await store.read();
    if (opts.key) {
      const v = (cfg as unknown as Record<string, unknown>)[opts.key];
      if (v === undefined && !KNOWN_KEYS.has(opts.key)) {
        const err = { code: "UNKNOWN_KEY", message: `unknown config key "${opts.key}"` };
        if (opts.json) emitJson({ ok: false, command, error: err });
        else console.error(`Error: ${err.message}`);
        process.exit(1);
        return; // unreachable in prod; satisfies the "no follow-up code" invariant.
      }
      if (opts.json) {
        emitJson({ ok: true, command, data: { [opts.key]: v } } satisfies JsonResult);
        return;
      }
      console.log(typeof v === "string" ? v : JSON.stringify(v));
      return;
    }
    if (opts.json) {
      emitJson({ ok: true, command, data: cfg } satisfies JsonResult);
      return;
    }
    renderConfigHuman(cfg);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "CONFIG_GET_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── `config set <key> <value>` ────────────────────────────────────────────────

export async function configSetCommand(key: string, rawValue: string, opts: GlobalCliOpts): Promise<void> {
  const command = "config set";
  const log = newLog(opts.json === true);
  try {
    const parsed = parseSetInput(key, rawValue);
    if ("error" in parsed) {
      if (opts.json) {
        emitJson({ ok: false, command, error: { code: "INVALID_VALUE", message: parsed.error } });
      } else {
        console.error(`Error: ${parsed.error}`);
      }
      process.exit(1);
      return; // unreachable in prod; satisfies the "no follow-up code" invariant.
    }
    const store = new YamlConfigStore(log);
    await store.write({ [key]: parsed.value } as Partial<AppConfig>);
    if (opts.json) {
      emitJson({ ok: true, command, data: { key, value: parsed.value } } satisfies JsonResult);
      return;
    }
    console.log(`Set ${key} = ${JSON.stringify(parsed.value)}`);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "CONFIG_SET_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── `config reset` ──────────────────────────────────────────────────────────

export async function configResetCommand(opts: GlobalCliOpts): Promise<void> {
  const command = "config reset";
  const log = newLog(opts.json === true);
  try {
    const store = new YamlConfigStore(log);
    await store.reset();
    if (opts.json) {
      emitJson({ ok: true, command, data: { reset: true } } satisfies JsonResult);
      return;
    }
    console.log("Config reset to defaults.");
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "CONFIG_RESET_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── Human-readable renderer ───────────────────────────────────────────────────

function renderConfigHuman(cfg: AppConfig): void {
  for (const [k, v] of Object.entries(cfg)) {
    console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
}
