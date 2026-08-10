// ─────────────────────────────────────────────────────────────────────────────
//  JobConfig schema - zod validation for the YAML job file (`jobs/*.yaml`).
//
//  This is the one Phase 1 artifact Phase 2 deliberately deletes
//  (phase-2 §2.5): `app/loadJobFile.ts`'s hand-rolled validator is replaced
//  by this schema, exporting `parseJobConfig(yaml: string): JobConfig` so
//  no call-site changes ripple.
//
//  The JobConfig domain shape lives in core/domain/JobConfig.ts; this schema
//  is the validation boundary. Top-level `.passthrough()` is applied so any
//  v1-named key (such as an alternate `defaultConcurrency` field) parses
//  without error - the unknown-key preservation invariant v1 already had for
//  App/SiteProfile is applied to job files here too. Phase 5 will publish a
//  schema file generated from this zod definition.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

const nextLocatorSchema = z.object({
  kind: z.enum(["css", "xpath", "regex"]),
  value: z.string(),
  flags: z.string().optional(),
});

const novelMetadataSchema = z.object({
  title: z.string(),
  author: z.string(),
  language: z.string().default("en"),
  synopsis: z.string().optional(),
  publisher: z.string().optional(),
  coverSource: z.enum(["url", "file", "none"]).default("none"),
  coverUrl: z.string().optional(),
  coverPath: z.string().optional(),
});

// Phase 7 Scaffold additive (ADR-P7-A/B): one entry per chapter-grouped
// volume from a site adapter's catalog walk. Flat-catalog adapters leave
// `volumes` absent; the EPUB writer falls through its no-volumes path.
const volumeSchema = z.object({
  name: z.string(),
  chapterUrls: z.array(z.string()),
});

export const jobConfigSchema = z
  .object({
    method: z.enum(["toc", "sequential"]),

    tocUrl: z.string().optional(),
    chapterLinks: z.array(z.string()).optional(),

    firstChapterUrl: z.string().optional(),
    lastChapterUrl: z.string().optional(),
    nextButtonLocators: z.array(nextLocatorSchema).optional(),

    contentSelector: z.string(),
    separateTitle: z.boolean().default(false),
    titleSelector: z.string().optional(),
    excludeSelectors: z.array(z.string()).default([]),

    metadata: novelMetadataSchema,
    outputDir: z.string(),
    outputFilename: z.string(),

    concurrency: z.number().default(2),
    delayMin: z.number().default(1200),
    delayMax: z.number().default(3500),
    headless: z.boolean().default(true),

    // Phase 1 superset additions (phase-1 ADR-P1-F) - preserved as-is in v2.
    jobId: z.string().optional(),
    cookiesFile: z.string().optional(),
    resumeFromSessionId: z.string().optional(),

    output: z
      .object({
        epub: z.boolean().default(true),
      })
      .default({ epub: true }),

    // Phase 7 Scaffold additive-optional (ADR-P7-B): present only when a
    // site adapter's scrapeVolumes() call produced volume-grouping data.
    // Default-undefined to keep flat-catalog jobs byte-identical to today.
    volumes: z.array(volumeSchema).optional(),
  })
  .passthrough();

export type JobConfigParsed = z.output<typeof jobConfigSchema>;
