// ─────────────────────────────────────────────────────────────────────────────
//  sessions.1to2 - migration from implicit-v1 session file to v2.
//
//  v1 shape: ScrapeSession (src/types.ts:188-203). Phase 1 wrote files with
//  NO schemaVersion field (side-by-side safety guarantee, phase-1 §4). Phase 2
//  stamps schemaVersion: 2 on NEXT WRITE only - the reader must treat absent
//  as implicit v1 (migration-guide §5).
//
//  This migration is purely additive: stamp schemaVersion, leave every
//  other field untouched.
// ─────────────────────────────────────────────────────────────────────────────

import type { StoreMigration } from "./chain.js";
import { sessions2to3 } from "./sessions.2to3.js";

export const sessions1to2: StoreMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate(rawOnEntry: unknown): unknown {
    if (!rawOnEntry || typeof rawOnEntry !== "object") {
      return { schemaVersion: 2 };
    }
    // Copy verbatim so unknown sibling fields round-trip (phase-1 D6
    // invariant: a session file with an unknown config key is preserved).
    return { ...(rawOnEntry as Record<string, unknown>), schemaVersion: 2 };
  },
};

// Chain assembly point (per docs/05-migration-guide.md §9). One entry per
// schema bump; applied in order by runMigrations. Phase 7 Scaffold adds
// sessions2to3 as the additive-optional `volumes` step.
export const sessionsMigrations: ReadonlyArray<StoreMigration> = [
  sessions1to2,
  sessions2to3,
];
