// ─────────────────────────────────────────────────────────────────────────────
//  loadJobFile - read + validate a YAML JobConfig file.
//
//  Phase 1 shipped a hand-rolled validator here per phase-1 ADR-P1-F; Phase 2
//  replaces the body with the zod schema (phase-2 §2.5: "one file, one
//  commit, no call-site changes"). Two exported entry points:
//    - parseJobConfig(yaml: string): JobConfig      // pure, for tests + CLI
//    - loadJobFile(filePath: string): JobConfig     // I/O wrapper for cli.ts
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import YAML from "yaml";

import { jobConfigSchema } from "../adapters/schemas/jobConfig.js";
import type { JobConfig } from "../core/domain/JobConfig.js";

export function parseJobConfig(yaml: string): JobConfig {
  const raw = YAML.parse(yaml);
  if (raw === null || typeof raw !== "object") {
    throw new Error("Job file is empty or not a YAML mapping");
  }
  // zod produces human-readable error paths via `format()` - T9 assert.
  const parsed = jobConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  at ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid job file:\n${issues}`);
  }
  // The schema-derived output is structurally compatible with JobConfig;
  // the cast is required because JobConfig embeds the optional v1-only
  // `chapterLinks` etc. as declared fields, which zod surfaces as objects.
  return parsed.data as unknown as JobConfig;
}

export function loadJobFile(filePath: string): JobConfig {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  return parseJobConfig(raw);
}
