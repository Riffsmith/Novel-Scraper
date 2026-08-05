// ─────────────────────────────────────────────────────────────────────────────
//  siteProfile schema - zod validation for site-profiles.json.
//
//  v1 shape: Record<hostname, SiteProfile>, flat read-all/write-all
//  (src/config/siteProfiles.ts). v2 additive fields (05 §4): optional
//  `schemaVersion` sibling of the existing fields, and an optional
//  `lastUsedAt` on each SiteProfile (mirrors cookie profiles for
//  consistency). All additive-optional - never rename, never retype.
//
//  As with the cookie store, the hostnames are passthrough keys at the top
//  level, and `.passthrough()` is applied uniformly so unknown fields
//  survive a save round-trip (phase-2 §2.2 #3).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const nextLocatorSchema = z.object({
  kind: z.enum(["css", "xpath", "regex"]),
  value: z.string(),
  flags: z.string().optional(),
});

export const siteProfileSchema = z.object({
  domain: z.string(),
  label: z.string().optional(),
  method: z.enum(["toc", "sequential"]),
  contentSelector: z.string(),
  separateTitle: z.boolean(),
  titleSelector: z.string().optional(),
  excludeSelectors: z.array(z.string()),
  nextButtonLocators: z.array(nextLocatorSchema).optional(),
  concurrency: z.number().optional(),
  delayMin: z.number().optional(),
  delayMax: z.number().optional(),
  notes: z.string().optional(),
  savedAt: z.string(),
  updatedAt: z.string(),
  // Phase 2 additive (05 §4): mirror cookie-profile lastUsedAt semantics.
  lastUsedAt: z.string().optional(),
});

// Top-level document: hostname keys map to SiteProfile, with one optional
// `schemaVersion` sibling field.
export const siteProfilesDocumentSchema = z
  .object({
    schemaVersion: z.number().optional(),
  })
  .passthrough();

export const SITE_PROFILES_SCHEMA_VERSION = 2;

export type SiteProfileParsed = z.output<typeof siteProfileSchema>;
