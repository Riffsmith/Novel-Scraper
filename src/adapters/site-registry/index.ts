// ─────────────────────────────────────────────────────────────────────────────
//  site-registry - the v2 SiteAdapter registry (ADR-P4-A).
//
//  v1's `src/sites/index.ts` exports `SITE_ADAPTERS` + `findSiteAdapter(url)`.
//  Phase 4 ports the two adapters into v2 adapter dirs
//  (adapters/site-wtr-lab/, adapters/site-novelfire/) typed onto PageHandle.
//
//  This registry is the single `findSiteAdapter` seam the TUI (and the
//  Phase 5 CLI) call into. `matches()` is a hostname closure test (AGENTS.md
//  "match() as a hostname regex test, never a substring"), so an unsupported
//  site returns null and the caller offers the manual-setup fallback (readme
//  §2.5 / index.ts:605-616).
//
//  There is no `ports/SiteAdapter.ts` - the registry is a pluggable set, not
//  a single injected port (readme §2.1). The composition root registers the
//  adapters behind this seam (the order matches v1: wtr-lab, novelfire).
// ─────────────────────────────────────────────────────────────────────────────

import type { SiteAdapter } from "../../core/domain/SiteAdapter.js";
import { wtrLabAdapter } from "../site-wtr-lab/WtrLabAdapter.js";
import { novelFireAdapter } from "../site-novelfire/NovelFireAdapter.js";

export const SITE_ADAPTERS: SiteAdapter[] = [wtrLabAdapter, novelFireAdapter];

export function findSiteAdapter(url: string): SiteAdapter | null {
  return (
    SITE_ADAPTERS.find((a) => {
      try {
        return a.matches(url);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export { wtrLabAdapter, novelFireAdapter };
export type { SiteAdapter };
