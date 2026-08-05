// ─────────────────────────────────────────────────────────────────────────────
//  JsonProfileStore - port of v1 src/config/siteProfiles.ts to the Phase 2
//  ProfileStore interface, with v2 schemaVersion stamping.
//
//  Behavior parity plan (per phase-2 §1.3):
//   - `load` returns the profile verbatim (with the v2 additive `lastUsedAt`
//     field defaulted-on-read = undefined).
//   - `save` preserves `savedAt`, refreshes `updatedAt` (v1 siteProfiles.ts:91-105).
//   - `delete` returns true if removed, false if absent.
//   - `list` returns the whole Record<hostname, SiteProfile> snapshot.
//   - v2 stamps `schemaVersion: 2` on the document root on next write;
//     legacy v1 files migrate in-memory with no immediate write-back (this
//     differs from the cookie case - the legacy-array wrap exception does
//     NOT apply here, since v1 site-profiles has no pre-shape to migrate
//     from).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";

import type { ProfileStore, SiteProfile } from "../../ports/ProfileStore.js";
import type { Logger } from "../../ports/Logger.js";

import { normaliseDomain } from "../../core/domain/Domain.js";
import { siteProfilesFilePath } from "./paths.js";
import { atomicWrite } from "./atomicWrite.js";
import {
  runMigrations,
  profilesMigrations,
} from "./migrations/index.js";
import { SITE_PROFILES_SCHEMA_VERSION } from "../../adapters/schemas/siteProfile.js";

interface ProfileDocument {
  schemaVersion?: number;
  profiles: Record<string, SiteProfile>;
}

export class JsonProfileStore implements ProfileStore {
  constructor(private log: Logger) {}

  // ── Read ─────────────────────────────────────────────────────────────────
  private loadDocument(): ProfileDocument {
    let parsed: unknown = {};
    try {
      const raw = fs.readFileSync(siteProfilesFilePath(), "utf8");
      parsed = JSON.parse(raw);
    } catch (e) {
      this.log.warn(
        `Failed to parse site-profiles - starting fresh: ${(e as Error).message}`,
      );
      parsed = {};
    }

    const { data } = runMigrations(parsed, profilesMigrations, SITE_PROFILES_SCHEMA_VERSION);
    const obj = (data ?? {}) as Record<string, unknown>;
    const profiles: Record<string, SiteProfile> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "schemaVersion") continue;
      if (v && typeof v === "object") {
        // v2 additive field defaulted on read (05 §4): lastUsedAt missing
        // is treated as undefined.  No mutation needed - it falls out of
        // the JSON.parse naturally.
        profiles[k] = v as SiteProfile;
      }
    }
    const schemaVersion =
      typeof obj.schemaVersion === "number" ? (obj.schemaVersion as number) : undefined;
    return { schemaVersion, profiles };
  }

  private async persist(doc: ProfileDocument): Promise<void> {
    const out: Record<string, unknown> = {
      ...doc.profiles,
      schemaVersion: doc.schemaVersion ?? SITE_PROFILES_SCHEMA_VERSION,
    };
    await atomicWrite(siteProfilesFilePath(), JSON.stringify(out, null, 2));
  }

  async load(domain: string): Promise<SiteProfile | null> {
    const { profiles } = this.loadDocument();
    return profiles[normaliseDomain(domain)] ?? null;
  }

  async save(domain: string, profile: SiteProfile): Promise<void> {
    const { profiles } = this.loadDocument();
    const key = normaliseDomain(domain);
    const now = new Date().toISOString();

    profiles[key] = {
      ...profile,
      domain: key,
      savedAt: profiles[key]?.savedAt ?? now,
      updatedAt: now,
    };

    await this.persist({ profiles, schemaVersion: SITE_PROFILES_SCHEMA_VERSION });
    this.log.info(`Site profile saved for ${key}`, { file: siteProfilesFilePath() });
  }

  async list(): Promise<Record<string, SiteProfile>> {
    const { profiles } = this.loadDocument();
    return profiles;
  }

  async delete(domain: string): Promise<boolean> {
    const { profiles } = this.loadDocument();
    const key = normaliseDomain(domain);
    if (!(key in profiles)) return false;
    delete profiles[key];
    await this.persist({ profiles, schemaVersion: SITE_PROFILES_SCHEMA_VERSION });
    this.log.info(`Site profile deleted for ${key}`);
    return true;
  }
}
