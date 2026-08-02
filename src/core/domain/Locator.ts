// ─────────────────────────────────────────────────────────────────────────────
//  Next-button locators for sequential discovery.
//  Ported VERBATIM from src/types.ts:83-92 (v1) — LocatorKind + NextLocator.
// ─────────────────────────────────────────────────────────────────────────────

export type LocatorKind = "css" | "xpath" | "regex";

export interface NextLocator {
  kind: LocatorKind;
  // css   → CSS selector string,            e.g. ".btn-next"
  // xpath → XPath expression (no xpath= prefix), e.g. "//a[contains(@class,'next')]"
  // regex → RegExp pattern (no / delimiters),    e.g. ">>"  or  "Next Chapter"
  value: string;
  flags?: string; // regex only; defaults to 'i' if omitted
}
