// ─────────────────────────────────────────────────────────────────────────────
//  session schema - zod validation for the per-session JSON files.
//
//  v1 shape is documented in src/types.ts:188-203 (ScrapeSession). Phase 2
//  adds an optional `schemaVersion` sibling of the existing fields - never a
//  shape change. Phase 1 wrote v1-shaped files deliberately (per phase-1
//  readme §4 "side-by-side operation guarantee"); Phase 2 stamps
//  `schemaVersion: 2` on *next write*, not on read.
//
//  The document is a flat object - no nested hostname-style passthrough keys
//  - but `config` embeds a ScraperConfig which may carry unknown keys from
//  future job-file extensions. So `.passthrough()` applies here too: any
//  unknown sibling field on the session document survives a save round-trip
//  (same invariant as v1's session-store pass-through behaviour, phase-1 D6).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const chapterSchema = z.object({
  index: z.number(),
  title: z.string(),
  url: z.string(),
  htmlContent: z.string(),
  wordCount: z.number(),
});

export const scrapeErrorSchema = z.object({
  url: z.string(),
  error: z.string(),
  retries: z.number(),
});

// ScraperConfig embedded in a session - same shape as v1 types.ts:107-141.
// Unknown keys pass through so a session saved by a future job file with
// extra fields round-trips untouched.
export const scraperConfigSchema = z
  .object({
    method: z.enum(["toc", "sequential"]),

    tocUrl: z.string().optional(),
    chapterLinks: z.array(z.string()).optional(),

    firstChapterUrl: z.string().optional(),
    lastChapterUrl: z.string().optional(),
    nextButtonLocators: z
      .array(
        z.object({
          kind: z.enum(["css", "xpath", "regex"]),
          value: z.string(),
          flags: z.string().optional(),
        }),
      )
      .optional(),

    contentSelector: z.string(),
    separateTitle: z.boolean(),
    titleSelector: z.string().optional(),
    excludeSelectors: z.array(z.string()),

    metadata: z.object({
      title: z.string(),
      author: z.string(),
      language: z.string(),
      synopsis: z.string().optional(),
      publisher: z.string().optional(),
      coverSource: z.enum(["url", "file", "none"]),
      coverUrl: z.string().optional(),
      coverPath: z.string().optional(),
    }),

    outputDir: z.string(),
    outputFilename: z.string(),

    concurrency: z.number(),
    delayMin: z.number(),
    delayMax: z.number(),
    headless: z.boolean(),
  })
  .passthrough();

export const sessionDocumentSchema = z
  .object({
    id: z.string(),
    status: z.literal("in-progress"),
    createdAt: z.string(),
    updatedAt: z.string(),
    domain: z.string(),
    entryUrl: z.string(),
    novelTitle: z.string(),
    config: scraperConfigSchema,
    chapterUrls: z.array(z.string()),
    completedChapters: z.array(chapterSchema),
    errors: z.array(scrapeErrorSchema),
    // Phase 2 additive (05 §5): schemaVersion is absent on v1 files.
    // The reader treats absent as implicit v1; the writer stamps v2.
    schemaVersion: z.number().optional(),
  })
  .passthrough();

export const SESSION_STORE_SCHEMA_VERSION = 2;

export type SessionDocumentParsed = z.output<typeof sessionDocumentSchema>;
