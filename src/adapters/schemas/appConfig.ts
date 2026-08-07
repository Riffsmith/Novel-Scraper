// ─────────────────────────────────────────────────────────────────────────────
//  appConfig schema - zod validation for config.yaml.
//
//  Interface lives in core/domain/AppConfig.ts (with DEFAULT_CONFIG); this
//  schema is the validation boundary used by YamlConfigStore (the
//  config-yaml adapter). `.passthrough()` at the document level preserves
//  unknown keys (v1's writeConfig semantics - phase-2 §1.1 / §2.2 #3).
//  The migration guide §2 promises every key documented AND every unknown
//  key preserved when YAML is written by the template-writer.
//
//  Phase 5 additive tweaks (ADR-P5-B): every typed field accepts a string
//  CLI passthrough in addition to its native (YAML-parsed) type so `config
//  set <key> <cliString>` coerces correctly instead of failing on "false"
//  being a string against `z.boolean()`. The on-disk YAML config path keeps
//  using native types because YAML parses `true`/`123`/`null` natively; the
//  string-coercion branches only fire for the CLI `config set` path, which
//  always feeds a string. See deviation log D-P5-B for the deviation from
//  the readme's "only fingerprintSeed" wording.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

// CLI string -> boolean: "true"/"false" (case-insensitive) only. Anything
// else fails the parse and surfaces as a zod issue.
const boolOrStr = z.union([
  z.boolean(),
  z
    .string()
    .refine((v) => v.toLowerCase() === "true" || v.toLowerCase() === "false", {
      message: 'expected "true" or "false"',
    })
    .transform((v) => v.toLowerCase() === "true"),
]);

// CLI string -> number. NaN/Infinity rejected.
const numOrStr = z.union([
  z.number(),
  z
    .string()
    .refine((v) => Number.isFinite(Number(v)), {
      message: "expected a number",
    })
    .transform((v) => Number(v)),
]);

// CLI string -> "null" or number (matches `fingerprintSeed: number | null`).
const seedOrStr = z.union([
  z.number().nullable(),
  z
    .string()
    .transform((v) => (v === "null" ? null : Number(v)))
    .refine((v) => v === null || Number.isFinite(v), {
      message: "expected a number, 'null', or a numeric string",
    }),
]);

export const appConfigSchema = z
  .object({
    defaultOutputDir: z.string(),

    defaultConcurrency: numOrStr,
    defaultDelayMin: numOrStr,
    defaultDelayMax: numOrStr,

    headless: boolOrStr,
    waitUntil: z.enum(["domcontentloaded", "networkidle", "load"]),
    navigationTimeoutMs: numOrStr,

    humanize: boolOrStr,
    humanPreset: z.enum(["default", "careful"]),
    fingerprintSeed: seedOrStr,

    maxRetries: numOrStr,

    defaultLanguage: z.string(),
    defaultAuthor: z.string(),
    defaultPublisher: z.string(),

    logLevel: z.enum(["error", "warn", "info", "debug"]),

    askSaveProfile: boolOrStr,

    // Phase 2 additive: schemaVersion stamps the YAML document. Absent on
    // first migration (config.json has no schemaVersion field); the
    // YamlConfigStore stamps v2 on first write.
    schemaVersion: z.number().optional(),
  })
  .passthrough();

export const APP_CONFIG_SCHEMA_VERSION = 2;

export type AppConfigParsed = z.output<typeof appConfigSchema>;
