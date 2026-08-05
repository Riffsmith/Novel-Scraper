// ─────────────────────────────────────────────────────────────────────────────
//  CookieStore - persistent cookie-profile storage port.
//
//  Phase 1 declared a MINIMAL subset of the v1 cookie-store surface; Phase 2
//  fills out the FULL v1 surface (phase-2 §1.2 / T5). The port's job is to
//  preserve every method the Phase 3 TUI needs to call - exposing only a
//  minimal CRUD subset would stall Phase 3.
//
//  Semantics are documented per v1 src/cookies/store.ts (the reference
//  oracle); the JsonCookieStore adapter is the port of v1 behavior. No
//  method on this interface is "new" - every one is the v1 surface behind
//  a port.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DomainCookie,
  StoredCookie,
  CookieProfile,
  ProfileSummary,
} from "../core/domain/Cookie.js";

export interface CookieStore {
  // ── Read ────────────────────────────────────────────────────────────────────
  listDomains(): Promise<string[]>;
  listProfiles(domain: string): Promise<string[]>;
  getProfile(domain: string, profileName: string): Promise<CookieProfile | null>;
  describeProfile(domain: string, profileName: string): Promise<ProfileSummary | null>;

  /**
   * Load cookies for a profile, reattached as DomainCookie[] (cookie.domain
   * = `.${hostname}` so the browser context applies them to all subdomains).
   * Phase 1's port already had this method; behaviour is identical.
   * Returns null if the profile is missing or empty.
   */
  load(domain: string, profileName: string): Promise<DomainCookie[] | null>;

  /**
   * Live profile map for the cookie manager UI: hostname -> { profileName ->
   * { label?, cookieCount, updatedAt } }. Used by Phase 3.
   */
  list(): Promise<
    Record<string, Record<string, { label?: string; cookieCount: number; updatedAt: string }>>
  >;

  // ── Mutate ──────────────────────────────────────────────────────────────────
  /**
   * Replace a profile's full cookie set (used by browser-login capture - a
   * fresh login is authoritative). `createdAt` and `lastUsedAt` are preserved
   * across an overwrite. The `label` arg here means "use this label OR keep
   * the existing one if absent" - distinct from `setLabel`.
   */
  save(
    domain: string,
    profileName: string,
    cookies: StoredCookie[],
    label?: string,
  ): Promise<void>;

  /** Merge-by-name. Upsert each incoming cookie into the profile. */
  upsert(domain: string, profileName: string, incoming: StoredCookie[]): Promise<void>;

  /** Delete one cookie by name. Returns true if removed. */
  deleteCookie(domain: string, profileName: string, cookieName: string): Promise<boolean>;

  /**
   * Delete a single profile. If it was the domain's last remaining profile,
   * the domain key is removed too (a domain with zero profiles is
   * indistinguishable from one never added).
   */
  deleteProfile(domain: string, profileName: string): Promise<boolean>;

  /** Delete every profile for a domain. Returns true if anything was removed. */
  deleteDomain(domain: string): Promise<boolean>;

  /**
   * Rename a profile's key, leaving cookies and label untouched. Returns
   * false (no clobber) if the source doesn't exist or the target name is
   * already taken.
   */
  renameProfile(domain: string, oldName: string, newName: string): Promise<boolean>;

  /**
   * Set (or clear, with undefined) a profile's label without touching
   * cookies. ALWAYS applies the given label, distinguishing it from
   * `save`'s "keep if absent" semantics.
   */
  setLabel(
    domain: string,
    profileName: string,
    label: string | undefined,
  ): Promise<boolean>;

  /** Bump a profile's lastUsedAt - called when the profile is loaded for a scrape. */
  markUsed(domain: string, profileName: string): Promise<void>;
}
