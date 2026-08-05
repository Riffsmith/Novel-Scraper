// ─────────────────────────────────────────────────────────────────────────────
//  Domain - pure domain helper for normalising hostname keys.
//
//  v1 duplicated `normaliseDomain` verbatim in two stores (cookies/store.ts
//  and config/siteProfiles.ts) with identical rules: strip protocol, strip
//  leading www., drop path, drop port, lowercase, trim. The migration guide
//  (§4 / phase-2 §1.3) requires v2 to port this ONCE into core/domain and
//  have both stores import it - the ports make the shared util safe.
//
//  Rule set is byte-identical to v1's cookies/store.ts:409-417 (also
//  config/siteProfiles.ts:69-77). Changing the order or removing a step is a
//  silent v1 regression: a profile keyed under one form of the hostname but
//  looked-up under another would disappear.
// ─────────────────────────────────────────────────────────────────────────────

export function normaliseDomain(raw: string): string {
  // Strip protocol, www., trailing slashes, port
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase()
    .trim();
}
