// ─────────────────────────────────────────────────────────────────────────────
//  NullStores - in-memory stand-in CookieStore and ProfileStore for tests
//  that don't exercise persistence. Also used by Phase 1's runJob-based
//  tests where cookies aren't required.
//
//  Phase 1 had a 3-method CookieStore stub; Phase 2 expanded the port to the
//  full v1 surface (phase-2 §1.2), so the Noop store grew accordingly.
//  The implementation is uniformly empty / no-op - tests can subclass and
//  override the few methods they care about.
// ─────────────────────────────────────────────────────────────────────────────

import type { CookieStore } from "../../ports/CookieStore.js";
import type { ProfileStore, SiteProfile } from "../../ports/ProfileStore.js";
import type {
  DomainCookie,
  StoredCookie,
  CookieProfile,
  ProfileSummary,
} from "../../core/domain/Cookie.js";

export class NullCookieStore implements CookieStore {
  async listDomains(): Promise<string[]> {
    return [];
  }
  async listProfiles(_domain: string): Promise<string[]> {
    return [];
  }
  async getProfile(_domain: string, _profileName: string): Promise<CookieProfile | null> {
    return null;
  }
  async describeProfile(_domain: string, _profileName: string): Promise<ProfileSummary | null> {
    return null;
  }
  async load(_domain: string, _profileName: string): Promise<DomainCookie[] | null> {
    return null;
  }
  async list(): Promise<
    Record<string, Record<string, { label?: string; cookieCount: number; updatedAt: string }>>
  > {
    return {};
  }
  async save(
    _domain: string,
    _profileName: string,
    _cookies: StoredCookie[],
    _label?: string,
  ): Promise<void> {}
  async upsert(
    _domain: string,
    _profileName: string,
    _incoming: StoredCookie[],
  ): Promise<void> {}
  async deleteCookie(
    _domain: string,
    _profileName: string,
    _cookieName: string,
  ): Promise<boolean> {
    return false;
  }
  async deleteProfile(_domain: string, _profileName: string): Promise<boolean> {
    return false;
  }
  async deleteDomain(_domain: string): Promise<boolean> {
    return false;
  }
  async renameProfile(
    _domain: string,
    _oldName: string,
    _newName: string,
  ): Promise<boolean> {
    return false;
  }
  async setLabel(
    _domain: string,
    _profileName: string,
    _label: string | undefined,
  ): Promise<boolean> {
    return false;
  }
  async markUsed(_domain: string, _profileName: string): Promise<void> {}
}

export class NullProfileStore implements ProfileStore {
  async load(_domain: string) {
    return null;
  }
  async save(_domain: string, _profile: SiteProfile) {}
  async list(): Promise<Record<string, SiteProfile>> {
    return {};
  }
  async delete(_domain: string): Promise<boolean> {
    return false;
  }
}
