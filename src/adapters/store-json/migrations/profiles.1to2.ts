// ─────────────────────────────────────────────────────────────────────────────
//  profiles.1to2 - migration from implicit-v1 site-profiles store to v2.
//
//  v1 shape: Record<hostname, SiteProfile> with no schemaVersion field.
//  v2 additions (05 §4): optional `schemaVersion` sibling of the existing
//  fields, plus optional `lastUsedAt` on each SiteProfile (mirrors cookie
//  profiles for consistency). Both default on read - never a rename or
//  retype.
//
//  This migration is purely additive: stamp schemaVersion, leave the rest.
// ─────────────────────────────────────────────────────────────────────────────

import type { StoreMigration } from "./chain.js";

export const profiles1to2: StoreMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate(rawOnEntry: unknown): unknown {
    if (!rawOnEntry || typeof rawOnEntry !== "object") {
      return { schemaVersion: 2 };
    }
    const raw = rawOnEntry as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "schemaVersion") continue;
      out[k] = v;
    }
    out.schemaVersion = 2;
    return out;
  },
};

export const profilesMigrations: ReadonlyArray<StoreMigration> = [profiles1to2];
