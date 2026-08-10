// ─────────────────────────────────────────────────────────────────────────────
//  Webnovel URL helpers - pure ports of reference/webnovel/urlUtils.mjs.
//
//  Only the DOM-knowledge parts are ported: getCatalogUrl, normalizeChapterUrl,
//  normalizeWebnovelHost, resolveNovelUrl, resolveRedirect. The browser
//  stealth, the network retry, and the connectivity test in the reference stay
//  unported (CloakBrowser + ScrapeService already own those concerns; see
//  docs/sites/webnovel-port-plan.md §"Out of scope").
//
//  Every helper is pure (no Playwright import). The adapter's factory wires
//  these into the SiteAdapter methods. Would not import `got` at module top -
//  only inside resolveRedirect's lazy import to match ArchiverEpubWriter.ts:23
//  so the binary-clean path never pulls the HTTP dependency into memory.
// ─────────────────────────────────────────────────────────────────────────────

let gotMod: (typeof import("got"))["got"] | null = null;
async function lazyGot() {
  if (!gotMod) {
    const mod = await import("got");
    gotMod = mod.got;
  }
  return gotMod!;
}

// reference/webnovel/urlUtils.mjs:10-15 getCatalogUrl
export function getCatalogUrl(novelUrl: string): string {
  if (!novelUrl.endsWith("/catalog")) {
    return novelUrl.replace(/\/$/, "") + "/catalog";
  }
  return novelUrl;
}

// reference/webnovel/urlUtils.mjs:23-34 normalizeChapterUrl
export function normalizeChapterUrl(chapterUrl: string, pageUrl: string): string {
  if (chapterUrl.startsWith("//")) {
    return `https:${chapterUrl}`;
  }
  if (chapterUrl.startsWith("/")) {
    const baseUrl = pageUrl.split("//")[1].split("/")[0];
    return `https://${baseUrl}${chapterUrl}`;
  }
  return chapterUrl;
}

// reference/webnovel/urlUtils.mjs:110-135 normalizeWebnovelHost
// Strips m. mobile host and any /LOCALE/book/ segment so selectors land on
// the English desktop layout they were built against.
export function normalizeWebnovelHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("m.")) {
      u.hostname = u.hostname.replace(/^m\./, "www.");
    } else if (u.hostname === "webnovel.com") {
      u.hostname = "www.webnovel.com";
    }
    u.pathname = u.pathname.replace(/^\/([a-z]{2}(?:-[a-z]{2,4})?)\/book\//i, "/book/");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// reference/webnovel/urlUtils.mjs:87-100 resolveRedirect
// Follows shortlink redirects (e.g. wbnv.in) and returns the final URL.
// Network failures fall back to the original URL (matches reference behaviour).
// `redirect: "follow"` from the node-fetch reference is redundant in got: its
// `followRedirect` option defaults to `true` (read node_modules/got/.../options.d.ts).
async function resolveRedirect(url: string): Promise<string> {
  try {
    const g = await lazyGot();
    const res = await g(url, { method: "GET", throwHttpErrors: false, timeout: { request: 15_000 } });
    return (res.url as string) || url;
  } catch {
    return url;
  }
}

// reference/webnovel/urlUtils.mjs:144-158 resolveNovelUrl
// Single entry point: shortlink resolves first, then host normalisation.
export async function resolveNovelUrl(rawUrl: string): Promise<string> {
  let url = rawUrl.trim();
  if (!/webnovel\.com/i.test(url)) {
    const resolved = await resolveRedirect(url);
    url = resolved;
  }
  return normalizeWebnovelHost(url);
}
