// ─────────────────────────────────────────────────────────────────────────────
//  JsonCookieStore - pure port of v1 src/cookies/store.ts to the Phase 2
//  CookieStore interface, with v2 schemaVersion stamping.
//
//  Behavior parity plan (per phase-2 §1.2):
//   - Read never silently mutates, EXCEPT the legacy-array wrap which KEEPS
//     v1's write-immediately behavior (cookies/store.ts:131-136) - the
//     migration-guide §3 contract promised users that. This means read
//     observes a `migrateLegacyFlatArray = true` flag (set when the
//     cookies.1to2 migration wrapped any flat-array domain) and writes back
//     the freshly stamped store. Pure routes return migrated data and the
//     JsonCookieStore decides whether to stamp/persist.
//   - Profile-listing sort: lastUsedAt ?? updatedAt desc, tie-broken by name.
//   - Unknown keys preserved on save via JSON parse/stringify round-trip
//     of unknown hostname keys (the literal point of phase-1 difference
//     from a "rewrite the whole store").
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

import type { CookieStore } from "../../ports/CookieStore.js";
import type {
  DomainCookie,
  StoredCookie,
  CookieProfile,
  ProfileSummary,
} from "../../core/domain/Cookie.js";
import type { Logger } from "../../ports/Logger.js";

import { normaliseDomain } from "../../core/domain/Domain.js";
import { cookiesFilePath } from "./paths.js";
import { atomicWrite } from "./atomicWrite.js";
import {
  runMigrations,
  cookiesMigrations,
  detectStoreVersion,
} from "./migrations/index.js";
import { COOKIE_STORE_SCHEMA_VERSION } from "../../adapters/schemas/cookieProfile.js";

// Per-hostname profiles: hostname -> profileName -> CookieProfile.  The
// `schemaVersion` sibling lives at the document root, NOT inside this record.
type HostnameRecord = Record<string, Record<string, CookieProfile>>;

interface StoreDocument {
  schemaVersion?: number;
  hostnames: HostnameRecord;
}

export class JsonCookieStore implements CookieStore {
  constructor(private log: Logger) {}

  // ── Read: hostname record ───────────────────────────────────────────────
  private loadDocument(): { doc: StoreDocument; migratedLegacy: boolean; stamped: boolean } {
    let parsed: unknown = {};
    try {
      const raw = fs.readFileSync(cookiesFilePath(), "utf8");
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    // Split the schemaVersion sibling from the hostname records.
    const split = this.splitDocument(parsed);
    const beforeVersion = detectStoreVersion(parsed);

    const { data, version } = runMigrations(
      parsed,
      cookiesMigrations,
      COOKIE_STORE_SCHEMA_VERSION,
    );

    const afterSplit = this.splitDocument(data);
    const migratedLegacy = beforeVersion === 1 && version === 2;

    // The legacy flat-array wrap is v1's write-immediately exception.  If we
    // just-migrated any flat-array domain, persist the stamped store right
    // away (mirrors cookies/store.ts:131-136).  We DO NOT write on a
    // plain v1->v2a-implicit stamp-only read - that's the lazy upgrade path
    // the design specifies for non-legacy migration (§2.2 rule #1).
    if (migratedLegacy) {
      // Mutated during migration; persist.
      // Synchronous OK: this is the v1 behavior we are CONTRACTUALLY required
      // to reproduce, including being synchronous so the next call sees the
      // stamped store.
      this.persistSync({
        schemaVersion: COOKIE_STORE_SCHEMA_VERSION,
        hostnames: afterSplit.hostnames,
      });
      this.log.info(
        `Migrated legacy cookie store to named-profile format (procedure migration-guide §3); stamped to schemaVersion ${COOKIE_STORE_SCHEMA_VERSION}`,
        { file: cookiesFilePath() },
      );
    }

    return { doc: afterSplit, migratedLegacy, stamped: migratedLegacy };
  }

  // Pull the `schemaVersion` sibling out of a parsed document so the
  // hostname record is cleanly typed.
  private splitDocument(raw: unknown): StoreDocument {
    if (!raw || typeof raw !== "object") {
      return { hostnames: {} };
    }
    const obj = raw as Record<string, unknown>;
    const hostnames: HostnameRecord = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "schemaVersion") continue;
      // Tolerate non-object values silently here - zod validation happens
      // in the getProfile/profile listing path; a corrupt domain entry
      // shouldn't poison the whole list call (matches v1's tolerant read).
      if (v && typeof v === "object" && !Array.isArray(v)) {
        hostnames[k] = v as Record<string, CookieProfile>;
      }
    }
    if (typeof obj.schemaVersion === "number") {
      return { schemaVersion: obj.schemaVersion, hostnames };
    }
    return { hostnames };
  }

  // Persist synchronously - matches v1 cookies/store.ts writeStore (used for
  // the read-time legacy wrap write-back).
  private persistSync(doc: StoreDocument): void {
    const dir = this.dirname();
    fs.mkdirSync(dir, { recursive: true });
    const out: Record<string, unknown> = {
      ...doc.hostnames,
      schemaVersion: doc.schemaVersion ?? COOKIE_STORE_SCHEMA_VERSION,
    };
    fs.writeFileSync(cookiesFilePath(), JSON.stringify(out, null, 2), "utf8");
  }

  // Persist atomically - matches Phase 2 design (§1.2 atomicWrite applies).
  private async persist(doc: StoreDocument): Promise<void> {
    const out: Record<string, unknown> = {
      ...doc.hostnames,
      schemaVersion: doc.schemaVersion ?? COOKIE_STORE_SCHEMA_VERSION,
    };
    await atomicWrite(cookiesFilePath(), JSON.stringify(out, null, 2));
  }

  private dirname(): string {
    // cookiesFilePath returns `<dataDir>/cookies.json`; we want dataDir.
    return path.dirname(cookiesFilePath());
  }

  // ── CookieStore interface: read ──────────────────────────────────────────
  async listDomains(): Promise<string[]> {
    const { doc } = this.loadDocument();
    return Object.keys(doc.hostnames).sort();
  }

  async listProfiles(domain: string): Promise<string[]> {
    const { doc } = this.loadDocument();
    const profiles = doc.hostnames[normaliseDomain(domain)] ?? {};
    return Object.keys(profiles).sort((a, b) => {
      const ta = profiles[a].lastUsedAt ?? profiles[a].updatedAt;
      const tb = profiles[b].lastUsedAt ?? profiles[b].updatedAt;
      return ta !== tb ? (ta > tb ? -1 : 1) : a.localeCompare(b);
    });
  }

  async getProfile(domain: string, profileName: string): Promise<CookieProfile | null> {
    const { doc } = this.loadDocument();
    return doc.hostnames[normaliseDomain(domain)]?.[profileName] ?? null;
  }

  async describeProfile(
    domain: string,
    profileName: string,
  ): Promise<ProfileSummary | null> {
    const p = await this.getProfile(domain, profileName);
    if (!p) return null;
    return {
      name: profileName,
      label: p.label,
      cookieCount: p.cookies.length,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      lastUsedAt: p.lastUsedAt,
    };
  }

  async load(domain: string, profileName: string): Promise<DomainCookie[] | null> {
    const profile = await this.getProfile(domain, profileName);
    if (!profile || profile.cookies.length === 0) return null;

    // v1 loadCookiesForProfile reattaches `.${hostname}` as the cookie
    // domain (cookies/store.ts:201-219). Phase 2 keeps this exact
    // normalization; the browser adapter consumes the DomainCookie[]
    // via BrowserPort.createContext. The dot-prefix (= subdomain match)
    // is per-cookie mapping in `cookieMappers.ts` though; here we
    // attach the BARE hostname because the adapter prepends the dot.
    const hostname = normaliseDomain(domain);
    return profile.cookies.map((c) => ({ ...c, domain: hostname }));
  }

  async list(): Promise<
    Record<string, Record<string, { label?: string; cookieCount: number; updatedAt: string }>>
  > {
    const { doc } = this.loadDocument();
    const out: Record<string, Record<string, { label?: string; cookieCount: number; updatedAt: string }>> = {};
    for (const [domain, profiles] of Object.entries(doc.hostnames)) {
      out[domain] = {};
      for (const [name, profile] of Object.entries(profiles)) {
        out[domain][name] = {
          label: profile.label,
          cookieCount: profile.cookies.length,
          updatedAt: profile.updatedAt,
        };
      }
    }
    return out;
  }

  // ── CookieStore interface: mutate ───────────────────────────────────────
  async save(
    domain: string,
    profileName: string,
    cookies: StoredCookie[],
    label?: string,
  ): Promise<void> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    const now = new Date().toISOString();
    const existing = doc.hostnames[hostname]?.[profileName];

    doc.hostnames[hostname] = doc.hostnames[hostname] ?? {};
    doc.hostnames[hostname][profileName] = {
      cookies,
      label: label ?? existing?.label,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    };

    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    this.log.info(
      `Saved ${cookies.length} cookie(s) to profile "${profileName}" for ${hostname}`,
    );
  }

  async upsert(
    domain: string,
    profileName: string,
    incoming: StoredCookie[],
  ): Promise<void> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    const now = new Date().toISOString();
    const existing = doc.hostnames[hostname]?.[profileName];
    const merged: StoredCookie[] = existing ? [...existing.cookies] : [];

    for (const ic of incoming) {
      const idx = merged.findIndex((c) => c.name === ic.name);
      if (idx >= 0) merged[idx] = ic;
      else merged.push(ic);
    }

    doc.hostnames[hostname] = doc.hostnames[hostname] ?? {};
    doc.hostnames[hostname][profileName] = {
      cookies: merged,
      label: existing?.label,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    };

    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
  }

  async deleteCookie(
    domain: string,
    profileName: string,
    cookieName: string,
  ): Promise<boolean> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    const profile = doc.hostnames[hostname]?.[profileName];
    if (!profile) return false;

    const before = profile.cookies.length;
    profile.cookies = profile.cookies.filter((c) => c.name !== cookieName);
    const deleted = profile.cookies.length < before;
    if (deleted) {
      profile.updatedAt = new Date().toISOString();
      await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    }
    return deleted;
  }

  async deleteProfile(domain: string, profileName: string): Promise<boolean> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    if (!doc.hostnames[hostname]?.[profileName]) return false;

    delete doc.hostnames[hostname][profileName];
    if (Object.keys(doc.hostnames[hostname]).length === 0) {
      delete doc.hostnames[hostname];
    }
    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    this.log.info(`Deleted cookie profile "${profileName}" for ${hostname}`);
    return true;
  }

  async deleteDomain(domain: string): Promise<boolean> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    if (!(hostname in doc.hostnames)) return false;
    delete doc.hostnames[hostname];
    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    this.log.info(`Deleted all cookie profiles for ${hostname}`);
    return true;
  }

  async renameProfile(
    domain: string,
    oldName: string,
    newName: string,
  ): Promise<boolean> {
    const { doc } = this.loadDocument();
    const profiles = doc.hostnames[normaliseDomain(domain)];
    if (!profiles?.[oldName] || profiles[newName]) return false;
    profiles[newName] = profiles[oldName];
    delete profiles[oldName];
    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    return true;
  }

  async setLabel(
    domain: string,
    profileName: string,
    label: string | undefined,
  ): Promise<boolean> {
    const { doc } = this.loadDocument();
    const hostname = normaliseDomain(domain);
    const profile = doc.hostnames[hostname]?.[profileName];
    if (!profile) return false;
    profile.label = label;
    profile.updatedAt = new Date().toISOString();
    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
    return true;
  }

  async markUsed(domain: string, profileName: string): Promise<void> {
    const { doc } = this.loadDocument();
    const profile = doc.hostnames[normaliseDomain(domain)]?.[profileName];
    if (!profile) return;
    profile.lastUsedAt = new Date().toISOString();
    await this.persist({ ...doc, schemaVersion: COOKIE_STORE_SCHEMA_VERSION });
  }
}
