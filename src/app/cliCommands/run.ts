// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/run.ts - `wnscrape run` and the `wnscrape resume <id>` alias.
//
//  Phase 5 §1.5 / §2.2 / §2.3. Pulls the run command out of `app/cli.ts` so
//  the shell stays thin; threads `--resume` / `--cookies-file` /
//  `--validate-only` / `--json` (ADR-P5-A). One shared function body serves
//  both `run` and `resume`; the alias just supplies `resume` from `<id>`.
// ─────────────────────────────────────────────────────────────────────────────

import { loadJobFile } from "../loadJobFile.js";
import { runJob } from "../runJob.js";
import { createDefaultWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import { NoopUIAdapter } from "../../adapters/ui-noop/NoopUIAdapter.js";
import { CollectingUIAdapter } from "../../adapters/cli-json/CollectingUIAdapter.js";
import { JsonSessionStore } from "../../adapters/store-json/JsonSessionStore.js";
import type { Logger } from "../../ports/Logger.js";
import type { ScrapeEvent } from "../../core/services/events.js";
import type { JsonResultError } from "../../adapters/cli-json/envelope.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";
import { loadCookiesFile } from "./cookies.js";

export interface GlobalCliOpts {
  json?: boolean;
  quiet?: boolean;
}

export interface RunCommandOpts extends GlobalCliOpts {
  job?: string;
  resume?: string;
  cookiesFile?: string;
  validateOnly?: boolean;
}

// Published shape of the `run --json` envelope `data` field (§1.8 contract).
export interface RunResultJson {
  outputPath: string | null;
  chapters: number;
  totalWords: number;
  scrapeMs: number;
  errors: { url: string; error: string; retries: number }[];
  session?: { id: string; completedCount: number; totalChapters: number };
}

function commonLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope; swap to a silent Logger port so the
  // ONLY stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createDefaultWinstonLogger();
}

/** Convert the recorded ScrapeEvent list + ScrapeResult into the JSON shape. */
export function toRunResultJson(
  result: { chapters: unknown[] | { wordCount: number }[]; errors: { url: string; error: string; retries: number }[]; totalWords: number; scrapeMs: number },
  events: ScrapeEvent[],
): RunResultJson {
  const epubDone = events.find((e) => e.type === "epub.done") as
    | { type: "epub.done"; path: string }
    | undefined;
  const checkpoint = events
    .slice()
    .reverse()
    .find((e) => e.type === "checkpoint.saved") as
    | { type: "checkpoint.saved"; sessionId: string; done: number }
    | undefined;
  const discoveryDone = events.find((e) => e.type === "discovery.done") as
    | { type: "discovery.done"; urls: string[] }
    | undefined;
  const totalChapters =
    checkpoint?.done ?? discoveryDone?.urls.length ?? result.chapters.length;
  return {
    outputPath: epubDone?.path ?? null,
    chapters: result.chapters.length,
    totalWords: result.totalWords,
    scrapeMs: result.scrapeMs,
    errors: result.errors,
    session: checkpoint
      ? {
          id: checkpoint.sessionId,
          completedCount: checkpoint.done,
          totalChapters,
        }
      : undefined,
  };
}

function fatalEnvelope(command: string, code: string, message: string): JsonResult {
  return {
    ok: false,
    command,
    error: { code, message } satisfies JsonResultError,
  };
}

export async function runCommand(opts: RunCommandOpts): Promise<void> {
  const command = opts.resume ? "resume" : "run";
  const log = commonLog(opts.json === true);

  try {
    // 1. Resolve the job file path: explicit --job, WNSCRAPE_JOB env, OR --resume (reads session).
    const jobFilePath: string | undefined = opts.job || process.env["WNSCRAPE_JOB"];

    if (opts.resume) {
      if (!jobFilePath) {
        // resume <id> reads its embedded config from the checkpoint
        const sessions = new JsonSessionStore(log);
        const session = await sessions.load(opts.resume);
        if (!session) {
          const err = fatalEnvelope(command, "SESSION_NOT_FOUND", `No session with id ${opts.resume}`);
          if (opts.json) emitJson(err);
          else console.error(`Error: session not found: ${opts.resume}`);
          process.exit(1);
          return; // unreachable in prod (process.exit terminates); unit-test stub returns cleanly.
        }
        // Reconstruct a JobConfig from the checkpoint's embedded `config` (a
        // ScraperConfig superset already; output is reconstructed as the only
        // missing field).
        const inlineJob = {
          ...session.config,
          output: { epub: true } as const,
        };
        await execScrape(inlineJob, opts, log);
        return;
      }
    } else if (!jobFilePath) {
      const err = fatalEnvelope(command, "JOB_REQUIRED", "--job <file> is required (or set WNSCRAPE_JOB)");
      if (opts.json) emitJson(err);
      else console.error("Error: --job <file> is required");
      process.exit(1);
      return; // unreachable in prod; satisfies "no follow-up code" invariant.
    }

    // jobFilePath is set: parse + (optionally) validate-only.
    const job = loadJobFile(jobFilePath!);

    if (opts.validateOnly) {
      // Validate-by-parse: loadJobFile already throws on invalid YAML/zod.
      // We treat this as exit 0 on success, exit 1 already happened above.
      if (opts.json) {
        emitJson({ ok: true, command: "run", data: { valid: true, jobFile: jobFilePath } } satisfies JsonResult);
      } else {
        console.log(`OK: ${jobFilePath!} validates against jobConfigSchema`);
      }
      return;
    }

    await execScrape(job, opts, log);
  } catch (e) {
    const err = fatalEnvelope(command, "RUN_FAILED", (e as Error).message);
    if (opts.json) emitJson(err);
    else console.error(`Fatal: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function execScrape(
  job: Parameters<typeof runJob>[0],
  opts: RunCommandOpts,
  log: Logger,
): Promise<void> {
  const cookies = opts.cookiesFile ? loadCookiesFile(opts.cookiesFile) : [];
  const ui = opts.json ? new CollectingUIAdapter() : new NoopUIAdapter();

  const command = opts.resume ? "resume" : "run";
  const result = await runJob(job, {
    log,
    ui,
    cookies,
    resumeSessionId: opts.resume,
  });

  if (opts.json) {
    const data = toRunResultJson(result, (ui as CollectingUIAdapter).events);
    emitJson({ ok: true, command, data } satisfies JsonResult);
    return;
  }

  if (result.chapters.length === 0) {
    console.error("No chapters scraped");
    process.exit(1);
    return; // unreachable in prod; satisfies the "no follow-up code" invariant.
  }
  console.log(
    `Done: ${result.chapters.length} chapters, ${result.totalWords} words, ${(result.scrapeMs / 1000).toFixed(1)}s`,
  );
}
