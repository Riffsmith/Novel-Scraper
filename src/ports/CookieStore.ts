// ─────────────────────────────────────────────────────────────────────────────
//  CookieStore — persistent cookie-profile storage.
//  Interface only; implementation lands in Phase 2.  Phase 1 provides a
//  NullStore stub in store-memory so the engine compiles and tests run.
// ─────────────────────────────────────────────────────────────────────────────

export interface CookieStore {
  load(domain: string, profileName: string): Promise<import("../core/domain/Cookie.js").DomainCookie[] | null>;
  save(domain: string, profileName: string, cookies: import("../core/domain/Cookie.js").StoredCookie[]): Promise<void>;
  list(): Promise<
    Record<string, Record<string, { label?: string; cookieCount: number; updatedAt: string }>>
  >;
}