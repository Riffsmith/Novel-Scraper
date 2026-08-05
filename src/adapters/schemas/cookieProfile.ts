// ─────────────────────────────────────────────────────────────────────────────
//  cookieProfile schema - zod validation for the cookies.json store document.
//
//  v1 docs shape (which v2 keeps):
//    Record<hostname, Record<profileName, CookieProfile>>
//  v2 additive changes (05 §3): a top-level optional `schemaVersion` field AND
//  an optional `notes` field on each CookieProfile. Both default on read.
//
//  The store document mixes ONE named field (`schemaVersion`) with arbitrary
//  hostname-keyed sibling records. zod handles this via top-level `.passthrough()`
//  so unknown (= every hostname) keys round-trip untouched - the same
//  unknown-key semantics v1's `writeConfig` already provided, applied
//  uniformly per the migration guide §9 / phase-2 §2.2 #3.
//
//  The legacy flat-array format (Record<hostname, StoredCookie[]>) is detected
//  by `Array.isArray(domainValue)` and migrated BEFORE zod sees it - see
//  migrations/cookies.1to2.ts. So the schema below never validates the
//  legacy shape; only the post-migration v2 shape.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const storedCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  path: z.string(),
  expires: z.number(), // unix seconds; -1 = session cookie
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

export const cookieProfileSchema = z.object({
  cookies: z.array(storedCookieSchema),
  label: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
  // Phase 2 additive (05 §3): optional notes string on profiles.
  notes: z.string().optional(),
});

// One domain's full set of profiles, keyed by profile name. zod's record
// type accepts any string key, so profile names round-trip untouched by
// default (no strict key set).
export const domainProfilesSchema = z.record(z.string(), cookieProfileSchema);

// Top-level document: hostname keys map to DomainProfiles; one optional
// `schemaVersion` sibling field. Hostnames are passthrough.
export const cookieStoreDocumentSchema = z
  .object({
    schemaVersion: z.number().optional(),
  })
  .passthrough();

export const COOKIE_STORE_SCHEMA_VERSION = 2;

export type StoredCookieParsed = z.output<typeof storedCookieSchema>;
export type CookieProfileParsed = z.output<typeof cookieProfileSchema>;
export type DomainProfilesParsed = z.output<typeof domainProfilesSchema>;
