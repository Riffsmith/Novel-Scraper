// ─────────────────────────────────────────────────────────────────────────────
//  NullStores — stand-in CookieStore and ProfileStore implementations for
//  Phase 1 tests (and any Phase 1 CL run that doesn't require cookies).
//  Phase 2 replaces these with the real store-json adapters.
// ─────────────────────────────────────────────────────────────────────────────

import type { CookieStore } from "../../ports/CookieStore.js";
import type { ProfileStore, SiteProfile } from "../../ports/ProfileStore.js";

export class NullCookieStore implements CookieStore {
  async load(_domain: string, _profileName: string) { return null; }
  async save(_domain: string, _profileName: string, _cookies: any[]) {}
  async list() { return {}; }
}

export class NullProfileStore implements ProfileStore {
  async load(_domain: string) { return null; }
  async save(_domain: string, _profile: SiteProfile) {}
  async list() { return {}; }
}