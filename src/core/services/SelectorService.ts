// ─────────────────────────────────────────────────────────────────────────────
//  SelectorService — pure selector logic ported from src/scraper/selectors.ts.
//  Core-side: XPath detection, normalisation, regex pre-validation.
//  Browser-side evaluate operations (removeFromDom, findAnchorByRegex, etc.)
//  live in the browser-playwright adapter's PageObject.
// ─────────────────────────────────────────────────────────────────────────────

export function isXPath(sel: string): boolean {
  const s = sel.trim();
  return (
    s.startsWith("//") ||
    s.startsWith("(//") ||
    s.toLowerCase().startsWith("xpath=")
  );
}

export function toPlaywrightXPath(sel: string): string {
  const s = sel.trim();
  return s.toLowerCase().startsWith("xpath=") ? s : `xpath=${s}`;
}

export function formatLocator(loc: {
  kind: string;
  value: string;
  flags?: string;
}): string {
  switch (loc.kind) {
    case "css":
      return `[css]   ${loc.value}`;
    case "xpath":
      return `[xpath] ${loc.value}`;
    case "regex":
      return `[regex/${loc.flags ?? "i"}] ${loc.value}`;
    default:
      return `[?]     ${loc.value}`;
  }
}

export function validateRegex(pattern: string, flags: string = "i"): RegExp {
  return new RegExp(pattern, flags);
}