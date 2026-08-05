// ─────────────────────────────────────────────────────────────────────────────
//  Cookie - domain-level cookie types (NO playwright import; fixes audit P7).
//
//  StoredCookie mirrors v1 src/cookies/store.ts:56-64 exactly (Playwright's
//  Cookie minus `domain`, which is the store key). DomainCookie is the
//  cross-port in-memory shape: StoredCookie + `domain` reattached so the
//  browser adapter can hand it to context.addCookies() without a cast.
//
//  JSON cookie/session files stay v1-shaped - only the in-memory type differs.
//
//  Phase 2 additions (port of v1 cookie-store surface, phase-2 §1.2 / T5):
//    - CookieProfile (verbatim v1 cookies/store.ts:68-74) - so the port can
//      return profile metadata without forcing the caller to know the
//      on-disk JSON layout.
//    - ProfileSummary - lightweight listing shape (v1 cookies/store.ts:83-90)
//      used by TUI pickers.
//    - parseCookieHeader - pure function (v1 cookies/store.ts:386-406),
//      moved into core so neither the port adapter nor the (future) TUI
//      re-implement the cookie-string parser.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expires: number; // unix seconds; -1 = session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface DomainCookie extends StoredCookie {
  domain: string; // bare hostname, e.g. "wtr-lab.com"
}

// ── One named profile's full cookie jar plus light metadata ──────────────────
// Ported verbatim from v1 src/cookies/store.ts:68-74. Phase 2 adds an
// optional `notes` field per migration guide §3 (additive-optional only).
export interface CookieProfile {
  cookies: StoredCookie[];
  label?: string; // free-text, e.g. "Alt account via VPN"
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastUsedAt?: string; // ISO 8601 - set only when actually loaded for a scrape
  // Phase 2 additive (05 §3).
  notes?: string;
}

// Lightweight summary for TUI pickers - verbatim from v1 cookies/store.ts:83-90.
export interface ProfileSummary {
  name: string;
  label?: string;
  cookieCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

// ── Parse a raw "Cookie:" header string into StoredCookie entries ─────────────
// Verbatim port of v1 src/cookies/store.ts:386-406 - pure, no I/O, lives in
// core so neither the JsonCookieStore adapter nor the (Phase 3) TUI parser
// re-implements it.
export function parseCookieHeader(raw: string): StoredCookie[] {
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      const name = eqIdx >= 0 ? pair.slice(0, eqIdx).trim() : pair.trim();
      const value = eqIdx >= 0 ? pair.slice(eqIdx + 1).trim() : "";
      return {
        name,
        value,
        path: "/",
        expires: -1, // session cookie
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      };
    })
    .filter((c) => c.name.length > 0);
}
