// ─────────────────────────────────────────────────────────────────────────────
//  ProfileStore — persistent site-profile storage.
//  Interface only; implementation lands in Phase 2.
// ─────────────────────────────────────────────────────────────────────────────

import type { NextLocator } from "../core/domain/Locator.js";

export interface SiteProfile {
  domain: string;
  label?: string;
  method: "toc" | "sequential";
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
}

export interface ProfileStore {
  load(domain: string): Promise<SiteProfile | null>;
  save(domain: string, profile: SiteProfile): Promise<void>;
  list(): Promise<Record<string, SiteProfile>>;
}