// ─────────────────────────────────────────────────────────────────────────────
//  cookies.1to2 - migration from implicit-v1 cookie store to v2.
//
//  v1 flat-array format:  Record<hostname, StoredCookie[]>
//  v1 profile-named format (which arrived in v1's lifetime): the exact same
//  v2 shape but without `schemaVersion`.
//
//  Implicit-v1 documents are ambiguous: any document with no `schemaVersion`
//  is implicit v1, which may be EITHER the pre-profile flat-array shape OR
//  the v1 profile-named shape. The discriminator is `Array.isArray(domainValue)`:
//  - v1 profile-named (current): Record<hostname, Record<profile, CookieProfile>>
//  - legacy flat-array:        Record<hostname, StoredCookie[]>
//
//  `Array.isArray()` is airtight - the two shapes can NEVER be confused
//  (cookies/store.ts:101-105 v1 comment). The migration:
//   1. Wraps any flat-array domain into a "default" profile with synthesised
//      createdAt/updatedAt (mirrors v1 cookies/store.ts:118-124 exactly).
//   2. Stamps `schemaVersion: 2` at the document root.
//
//  IMPORTANT: this migration is PURE. Per phase-2 §2.2 rule #1, JsonCookieStore
//  owns the "write-back immediately after the legacy flat-array wrap" exception
//  (matching v1 cookies/store.ts:131-136) - that side effect lives in the
//  store adapter, not here.
// ─────────────────────────────────────────────────────────────────────────────

import type { StoreMigration } from "./chain.js";

interface StoredCookieV1 {
  name: string;
  value: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export const cookies1to2: StoreMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate(rawOnEntry: unknown): unknown {
    if (!rawOnEntry || typeof rawOnEntry !== "object") {
      // An empty / null store is still a v1 store; stamp and return.
      return { schemaVersion: 2 };
    }
    const raw = rawOnEntry as Record<string, unknown>;

    // Pre-split the schemaVersion sibling so we can rebuild the document
    // with hostname keys plus the stamped schemaVersion in deterministic
    // object-key order (alphabetically stable enough for JSON.stringify).
    const out: Record<string, unknown> = {};

    // Re-add schemaVersion FIRST so writers that iterate keys see it first,
    // matching v1 cookies/store.ts which treats the document as
    // Record<hostname, ...> with no sibling fields (we are additive).
    // Actually - to match v1 on-disk byte layout as closely as possible
    // (hostname keys first, schemaVersion appended at the end), we walk
    // existing hostname entries first, then stamp schemaVersion last.
    const now = new Date().toISOString();

    for (const [domain, value] of Object.entries(raw)) {
      if (domain === "schemaVersion") continue;
      if (Array.isArray(value)) {
        // Legacy flat-array format: wrap into a "default" profile.
        out[domain] = {
          default: {
            cookies: value as StoredCookieV1[],
            createdAt: now,
            updatedAt: now,
          },
        };
      } else {
        // Already profile-named: pass through untouched.
        out[domain] = value;
      }
    }

    out.schemaVersion = 2;
    return out;
  },
};

export const cookiesMigrations: ReadonlyArray<StoreMigration> = [cookies1to2];
