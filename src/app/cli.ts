// ─────────────────────────────────────────────────────────────────────────────
//  CLI entry — cac-powered.  Phase 1 ships only `wnscrape run --job <file>`.
//  Phase 5 adds the rest.
// ─────────────────────────────────────────────────────────────────────────────

import { cac } from "cac";

import { loadJobFile } from "./loadJobFile.js";
import { runJob } from "./runJob.js";

import { createWinstonLogger } from "../adapters/logger-winston/WinstonLogger.js";
import { NoopUIAdapter } from "../adapters/ui-noop/NoopUIAdapter.js";

import logger from "../logger/index.js";

const cli = cac("wnscrape");

cli
  .command("run", "Run a scrape job from a YAML file")
  .option("--job <file>", "Path to job YAML file", { default: "" })
  .action(async (opts: { job?: string }) => {
    const jobFile = opts.job || process.env["WNSCRAPE_JOB"];
    if (!jobFile) {
      console.error("Error: --job <file> is required");
      process.exit(1);
    }

    const ui = new NoopUIAdapter();
    const log = createWinstonLogger(logger);

    try {
      const job = loadJobFile(jobFile);
      const result = await runJob(job, { log, ui });

      if (result.chapters.length === 0) {
        console.error("No chapters scraped");
        process.exit(1);
      }

      console.log(
        `Done: ${result.chapters.length} chapters, ${result.totalWords} words, ${(result.scrapeMs / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      console.error(`Fatal: ${(e as Error).message}`);
      process.exit(1);
    }
  });

cli.help();
cli.parse();