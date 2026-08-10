// ─────────────────────────────────────────────────────────────────────────────
//  sessions.2to3 - additive migration from v2 session file to v3.
//
//  Phase 7 (Scaffold) additive-optional change: the ScrapeSession domain now
//  carries an optional top-level `volumes?: Volume[]` field (ADR-P7-A/B).
//  This migration normalizes a v2 file (no `volumes` key) into the v3 shape by
//  ensuring the key is present (set to `undefined` if absent). It does not
//  invent volume data - it only shapes the document for the v3 reader.
//
//  Rules followed (AGENTS.md / docs/05-migration-guide.md):
//    - Pure: the migration does NOT touch the on-disk file - the reader walks
//      the chain in memory, the writer stamps on next genuine save.
//    - Unknown keys round-trip untouched (matches phase-1 D6 + the v1
//      `writeConfig` preservation invariant).
//    - Additive-only: no existing field is renamed or retyped. The `volumes`
//      key is added to the session root only when missing; if it was
//      previously written (e.g. a session saved by a Phase 7 build with
//      volumes preserved on a resume), it is left exactly as-is.
// ─────────────────────────────────────────────────────────────────────────────

import type { StoreMigration } from "./chain.js";

export const sessions2to3: StoreMigration = {
  fromVersion: 2,
  toVersion: 3,
  migrate(rawOnEntry: unknown): unknown {
    if (!rawOnEntry || typeof rawOnEntry !== "object") {
      return { schemaVersion: 3, volumes: undefined };
    }
    const raw = rawOnEntry as Record<string, unknown>;
    // Preserve every key verbatim. Only add `volumes: undefined` if the key
    // is entirely missing - an existing explicit `undefined` or `null` keeps
    // round-tripping as-is (JSON.stringify drops `undefined` values, but the
    // in-memory shape is what the v3 reader validates against; the on-disk
    // result will be whatever the next genuine save produces).
    if (!("volumes" in raw)) {
      return { ...raw, schemaVersion: 3, volumes: undefined };
    }
    return { ...raw, schemaVersion: 3 };
  },
};
