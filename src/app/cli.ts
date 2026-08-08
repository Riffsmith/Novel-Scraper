// ─────────────────────────────────────────────────────────────────────────────
//  CLI entry - cac-powered. Phase 5 (ADR-P5-A): thin shell; each .action is
//  a one-liner that delegates to cliCommands/<name>.ts. Global --json / --quiet
//  options are read by every command via opts.json / opts.quiet.
//
//  Per §2.2 each command's body lives in `cliCommands/`. The `tui` subcommand
//  boots `app/tui.ts:main()` so one binary exposes both the interactive shell
//  and the scriptable CLI (ADR-005).
//
//  Group dispatch: cac@7 does not match space-separated command names like
//  `"cookies ls"` against `argv[0] === "cookies ls"`; only the first token is
//  matched. So `cookies` / `sessions` / `profiles` / `config` are registered
//  as `<group> <action>` commands and dispatch on the positional action arg
//  (see deviation log D-P5-C). The user-facing surface still reads
//  `wnscrape cookies ls`, `wnscrape config get`, etc, exactly as the design
//  doc §1.5 table lists.
// ─────────────────────────────────────────────────────────────────────────────

import { cac } from "cac";

import { runCommand } from "./cliCommands/run.js";
import {
  sessionsLsCommand,
  sessionsRmCommand,
} from "./cliCommands/sessions.js";
import {
  cookiesLsCommand,
  cookiesAddCommand,
  cookiesRmCommand,
} from "./cliCommands/cookies.js";
import {
  profilesLsCommand,
  profilesRmCommand,
} from "./cliCommands/profiles.js";
import {
  configGetCommand,
  configSetCommand,
  configResetCommand,
} from "./cliCommands/config.js";
import { doctorCommand } from "./cliCommands/doctorCmd.js";
import { emitJson, type JsonResult } from "../adapters/cli-json/envelope.js";

interface CliOpts {
  json: boolean;
  quiet: boolean;
}

function cliOpts(opts: { json?: boolean; quiet?: boolean }): CliOpts {
  return { json: opts.json === true, quiet: opts.quiet === true };
}

const cli = cac("wnscrape");

// Global options every subcommand inherits.
cli
  .option("--json", "Emit machine-stable JSON on stdout (no ANSI)", { default: false })
  .option("--quiet, -q", "Suppress stderr progress lines", { default: false });

// ── run + resume + tui ─────────────────────────────────────────────────────────
cli
  .command("run", "Run a scrape job from a YAML file")
  .option("--job <file>", "Path to job YAML file", { default: "" })
  .option("--resume <id>", "Resume from a session checkpoint id", { default: "" })
  .option("--cookies-file <f>", "Path to a v1 cookie-snippet JSON file or Cookie: header string", { default: "" })
  .option("--validate-only", "Validate the job file and exit (no browser)", { default: false })
  .action(async (opts) =>
    runCommand({
      ...cliOpts(opts),
      job: opts.job || undefined,
      resume: opts.resume || undefined,
      cookiesFile: opts.cookiesFile || undefined,
      validateOnly: opts.validateOnly === true,
    }),
  );

cli
  .command("resume <id>", "Alias: run --resume <id>")
  .action(async (id, opts) =>
    runCommand({ ...cliOpts(opts), resume: String(id) }),
  );

cli
  .command("tui", "Launch the interactive shell")
  .action(async () => {
    const mod = await import("./tui.js");
    await mod.main();
  });

// ── sessions <action> [...rest] ──────────────────────────────────────────────
cli
  .command("sessions <action> [...rest]", "Session checkpoints: ls | rm")
  .action(async (action: string, rest: string[] | undefined, opts) => {
    if (action === "ls") return sessionsLsCommand(cliOpts(opts));
    if (action === "rm") {
      const idArg = rest?.[0];
      if (!idArg) {
        if (opts.json) {
          emitJson({
            ok: false,
            command: "sessions rm",
            error: { code: "USAGE", message: "Usage: wnscrape sessions rm <id>" },
          } satisfies JsonResult);
        } else {
          console.error("Usage: wnscrape sessions rm <id>");
        }
        process.exit(1);
      }
      return sessionsRmCommand(idArg, cliOpts(opts));
    }
    console.error(`Unknown sessions action "${action}" (try: ls, rm)`);
    process.exit(1);
  });

// ── cookies <action> ─────────────────────────────────────────────────────────
cli
  .command("cookies <action>", "Cookie profiles: ls | add | rm")
  .option("--file <f>", "Path to a v1 cookie-snippet JSON file or Cookie: header string", { default: "" })
  .option("--domain <d>", "Cookie domain (hostname)", { default: "" })
  .option("--profile <p>", "Profile name to upsert into", { default: "" })
  .option("--label <l>", "Optional profile label", { default: "" })
  .option("--all", "Remove every profile under --domain", { default: false })
  .action(async (action: string, opts) => {
    const o = cliOpts(opts);
    if (action === "ls") return cookiesLsCommand(o);
    if (action === "add") {
      return cookiesAddCommand({
        ...o,
        file: opts.file,
        domain: opts.domain,
        profile: opts.profile,
        label: opts.label || undefined,
      });
    }
    if (action === "rm") {
      return cookiesRmCommand({
        ...o,
        domain: opts.domain,
        profile: opts.profile || undefined,
        all: opts.all === true,
      });
    }
    console.error(`Unknown cookies action "${action}" (try: ls, add, rm)`);
    process.exit(1);
  });

// ── profiles <action> ────────────────────────────────────────────────────────
cli
  .command("profiles <action>", "Site profiles: ls | rm")
  .option("--domain <d>", "Site domain (hostname)", { default: "" })
  .action(async (action: string, opts) => {
    if (action === "ls") return profilesLsCommand(cliOpts(opts));
    if (action === "rm") {
      return profilesRmCommand({ ...cliOpts(opts), domain: opts.domain });
    }
    console.error(`Unknown profiles action "${action}" (try: ls, rm)`);
    process.exit(1);
  });

// ── config <action> [...rest] ─────────────────────────────────────────────────
cli
  .command("config <action> [...rest]", "App config: get | set | reset")
  .option("--key <k>", "Read one key (config get only)", { default: "" })
  .action(async (action: string, rest: string[] | undefined, opts) => {
    const o = cliOpts(opts);
    if (action === "get") return configGetCommand({ ...o, key: opts.key || undefined });
    if (action === "reset") return configResetCommand(o);
    if (action === "set") {
      // `config set <key> <value>` arrives with rest = ["<key>", "<value>"]
      const key = rest?.[0];
      const value = rest?.[1];
      if (!key || value === undefined) {
        if (opts.json) {
          emitJson({
            ok: false,
            command: "config set",
            error: { code: "USAGE", message: "Usage: wnscrape config set <key> <value>" },
          } satisfies JsonResult);
        } else {
          console.error("Usage: wnscrape config set <key> <value>");
        }
        process.exit(1);
      }
      return configSetCommand(key, value, o);
    }
    console.error(`Unknown config action "${action}" (try: get, set, reset)`);
    process.exit(1);
  });

// ── doctor ────────────────────────────────────────────────────────────────────
cli
  .command("doctor", "Validate binary, config, and stores")
  .option("--fix", "Stamp schemaVersion on out-of-date stores", { default: false })
  .action(async (opts) =>
    doctorCommand({ ...cliOpts(opts), fix: opts.fix === true }),
  );

cli.help();

// Wrap parse(): a future-per-invocation winston instance built by
// createDefaultWinstonLogger() (adapters/logger-winston) registers its
// exceptionHandlers INSIDE each command handler - i.e. AFTER cli.parse() has
// already returned - so a cac parse error thrown from the sync parse path is
// never touched by winston's top-level handler. Catch here so a cac `Unused
// args` / `Unknown option` surfaces as a proper non-zero exit code; under
// --json we emit a JSON error envelope so consumers don't get an empty stdout
// with exit 0. (See ADR-P6-B for the logger factory decision.)
try {
  cli.parse();
} catch (e) {
  const msg = (e as Error).message;
  // Determine whether --json was set; we already parsed the global option
  // (parsed.options on the globalCommand) so this branch is reachable.
  const jsonRequested =
    (cli.options as { json?: boolean } | undefined)?.json === true;
  if (jsonRequested) {
    emitJson({
      ok: false,
      command: "cli",
      error: { code: "PARSE_ERROR", message: msg },
    } satisfies JsonResult);
  } else {
    console.error(msg);
  }
  process.exit(1);
}
