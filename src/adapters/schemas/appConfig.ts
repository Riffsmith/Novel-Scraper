// ─────────────────────────────────────────────────────────────────────────────
//  appConfig schema - zod validation for config.yaml.
//
//  Interface lives in core/domain/AppConfig.ts (with DEFAULT_CONFIG); this
//  schema is the validation boundary used by YamlConfigStore (the
//  config-yaml adapter). `.passthrough()` at the document level preserves
//  unknown keys (v1's writeConfig semantics - phase-2 §1.1 / §2.2 #3).
//  The migration guide §2 promises every key documented AND every unknown
//  key preserved when YAML is written by the template-writer.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const appConfigSchema = z
  .object({
    defaultOutputDir: z.string(),

    defaultConcurrency: z.number(),
    defaultDelayMin: z.number(),
    defaultDelayMax: z.number(),

    headless: z.boolean(),
    waitUntil: z.enum(["domcontentloaded", "networkidle", "load"]),
    navigationTimeoutMs: z.number(),

    humanize: z.boolean(),
    humanPreset: z.enum(["default", "careful"]),
    fingerprintSeed: z.number().nullable(),

    maxRetries: z.number(),

    defaultLanguage: z.string(),
    defaultAuthor: z.string(),
    defaultPublisher: z.string(),

    logLevel: z.enum(["error", "warn", "info", "debug"]),

    askSaveProfile: z.boolean(),

    // Phase 2 additive: schemaVersion stamps the YAML document. Absent on
    // first migration (config.json has no schemaVersion field); the
    // YamlConfigStore stamps v2 on first write.
    schemaVersion: z.number().optional(),
  })
  .passthrough();

export const APP_CONFIG_SCHEMA_VERSION = 2;

export type AppConfigParsed = z.output<typeof appConfigSchema>;
