import type { SiteAdapter } from './types.js';
import { wtrLabAdapter } from './wtrLab.js';

// ── Registry — add new site adapters here ──────────────────────────────
export const SITE_ADAPTERS: SiteAdapter[] = [
  wtrLabAdapter,
];

export function findSiteAdapter(url: string): SiteAdapter | null {
  return SITE_ADAPTERS.find(a => {
    try { return a.matches(url); } catch { return false; }
  }) ?? null;
}

export * from './types.js';
