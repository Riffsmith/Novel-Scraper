// ─────────────────────────────────────────────────────────────────────────────
//  loadJobFile — read + validate a YAML JobConfig file (Phase 1 hand-rolled).
//  Phase 2 ships zod schema — this keeps the phase unblocked.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import YAML from "yaml";

import type { JobConfig } from "../core/domain/JobConfig.js";

export function loadJobFile(filePath: string): JobConfig {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Job file ${filePath} is empty or not a mapping`);
  }

  const job = parsed as unknown as JobConfig;

  if (!job.method || (job.method !== "toc" && job.method !== "sequential")) {
    throw new Error(`method must be "toc" or "sequential", got "${job.method}"`);
  }

  if (!job.contentSelector) {
    throw new Error(`Missing required key "contentSelector" in ${filePath}`);
  }

  if (!job.outputDir || !job.outputFilename) {
    throw new Error(`Missing outputDir or outputFilename in ${filePath}`);
  }

  if (!job.metadata || !job.metadata.title || !job.metadata.author) {
    throw new Error(`Missing metadata.title or metadata.author in ${filePath}`);
  }

  if (job.concurrency === undefined) job.concurrency = 2;
  if (job.delayMin === undefined) job.delayMin = 1200;
  if (job.delayMax === undefined) job.delayMax = 3500;
  if (job.headless === undefined) job.headless = true;
  if (job.separateTitle === undefined) job.separateTitle = false;
  if (!job.excludeSelectors) job.excludeSelectors = [];

  if (!job.output) {
    job.output = { epub: true };
  }

  if (!job.metadata.coverSource) {
    job.metadata.coverSource = "none";
  }
  if (!job.metadata.language) {
    job.metadata.language = "en";
  }

  return job;
}