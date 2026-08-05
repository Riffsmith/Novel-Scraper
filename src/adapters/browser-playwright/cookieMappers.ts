// ─────────────────────────────────────────────────────────────────────────────
//  cookieMappers - DomainCookie -> playwright-core Cookie shape conversion.
//
//  Owned by the browser-playwright adapter per phase-2 §1.2 (fix for audit
//  P7): the cookie store stays driver-agnostic by emitting DomainCookie
//  (bare-hostname domain key), and the adapter reattaches the leading dot
//  (= Playwright's convention for "valid for all subdomains").  v1 had this
//  same logic inline in cookies/store.ts:201-219; v2 moves it across the
//  port boundary so cookie files no longer bake-in Playwright semantics.
//
//  Three idempotent operations:
//   - `domainCookieToPlaywright(c: DomainCookie): PlaywrightCookieInput`
//   - `domainCookiesToPlaywright(cs: DomainCookie[]): PlaywrightCookieInput[]`
//   - `playwrightCookieToStored(c: PlaywrightCookieRead): StoredCookie`
//     (Phase 3 / ADR-P3-A: reverse direction for `BrowserPort.contextCookies`,
//      used by the cookie-capture flow.)
// ─────────────────────────────────────────────────────────────────────────────

import type { DomainCookie, StoredCookie } from "../../core/domain/Cookie.js";

// Playwright-core's `Cookie` type's sameSite union includes "Strict" | "Lax"
// | "None" - identical to our StoredCookie. We avoid importing the playwright
// type here so the file can be unit-tested with no DOM/Playwright present.
// PlaywrightBrowserPort.createContext passes the array straight to
// `context.addCookies(...)` which accepts this shape structurally.
export interface PlaywrightCookieInput {
  name: string;
  value: string;
  domain: string; // with leading dot - matches Playwright's expectation
  path: string;
  expires: number; // -1 = session cookie (Playwright's own sentinel)
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/**
 * Map a DomainCookie to Playwright's Cookie-addCookies input shape.
 * The `domain` field is reattached with a leading dot (`.${hostname}`)
 * so the cookie applies to all subdomains (v1 cookies/store.ts:209-218).
 */
export function domainCookieToPlaywright(c: DomainCookie): PlaywrightCookieInput {
  return {
    name: c.name,
    value: c.value,
    domain: `.${c.domain}`,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  };
}

export function domainCookiesToPlaywright(cs: DomainCookie[]): PlaywrightCookieInput[] {
  return cs.map(domainCookieToPlaywright);
}

// ── Reverse direction (Phase 3 / ADR-P3-A) ───────────────────────────────────
// Shape of `context.cookies()` minus the optional/extra fields the driver may
// emit (sameSite already typed; everything else we just discard). The fields
// we read are exactly what StoredCookie needs. `expires` semantics match:
// Playwright returns -1 for session cookies, identical to our sentinel.
export interface PlaywrightCookieRead {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None" | string;
}

export function playwrightCookieToStored(c: PlaywrightCookieRead): StoredCookie {
  return {
    name: c.name,
    value: c.value,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: ((c.sameSite ?? "Lax") as "Strict" | "Lax" | "None"),
  };
}

export function playwrightCookiesToStored(cs: PlaywrightCookieRead[]): StoredCookie[] {
  return cs.map(playwrightCookieToStored);
}
