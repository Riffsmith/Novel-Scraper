// ─────────────────────────────────────────────────────────────────────────────
//  ProfileStore - persistent site-profile storage port.
//
//  Phase 1 declared the minimal read/write/list surface; Phase 2 keeps the
//  interface but adds `delete` (parity with v1 src/config/siteProfiles.ts)
//  and an optional `markUsed` (mirrors cookie-profile lastUsedAt semantics
//  per migration-guide §4).
// ─────────────────────────────────────────────────────────────────────────────

import type { NextLocator } from "../core/domain/Locator.js";
import type { ScrapeMethod } from "../core/domain/JobConfig.js";

export interface SiteProfile {
  domain: string;
  label?: string;
  method: ScrapeMethod;
  contentSelector: string;
  separateTitle: boolean;
  titleSelector?: string;
  excludeSelectors: string[];
  nextButtonLocators?: NextLocator[];
  concurrency?: number;
  delayMin?: number;
  delayMax?: number;
  notes?: string;
  savedAt: string;
  updatedAt: string;
  // Phase 2 additive (05 §4): mirror cookie-profile lastUsedAt semantics.
  lastUsedAt?: string;
}

export interface ProfileStore {
  load(domain: string): Promise<SiteProfile | null>;
  save(domain: string, profile: SiteProfile): Promise<void>;
  list(): Promise<Record<string, SiteProfile>>;
  delete(domain: string): Promise<boolean>;
}
