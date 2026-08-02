// ─────────────────────────────────────────────────────────────────────────────
//  Cookie — domain-level cookie types (NO playwright import; fixes audit P7).
//
//  StoredCookie mirrors v1 src/cookies/store.ts:56-64 exactly (Playwright's
//  Cookie minus `domain`, which is the store key). DomainCookie is the
//  cross-port in-memory shape: StoredCookie + `domain` reattached so the
//  browser adapter can hand it to context.addCookies() without a cast.
//
//  JSON cookie/session files stay v1-shaped — only the in-memory type differs.
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
