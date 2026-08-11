// ─────────────────────────────────────────────────────────────────────────────
//  validation - presentation validators (originally ported from v1 tui, now
//  diverged where bug fixes required).
//
//  Lives in the adapter (not core) per readme §1.1 - these are presentation
//  helpers for the prompt seam, not domain logic. `validateDomain` and
//  `validateProfileNameChars` are byte-identical to v1's `prompts.ts` /
//  `cookieManager.ts`. `validateUrl` was tightened to reject scheme-doubled
//  URLs (e.g. `https://https://example.com`) and to accept bare hostnames
//  (the caller normalizes via `normalizeUrl`); see
//  docs/phase-3/adr.md ADR-P3-FIX-URL and docs/phase-3/deviation-log.md D10.
// ─────────────────────────────────────────────────────────────────────────────

export function validateDomain(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "Domain cannot be empty";
  try {
    const h = trimmed.startsWith("http") ? new URL(trimmed).hostname : trimmed;
    if (h.includes(".") || h === "localhost") return true;
    return "Enter a valid hostname  e.g. novelupdates.com";
  } catch {
    return "Invalid domain / URL";
  }
}

export const PROFILE_NAME_RE = /^[a-z0-9_-]+$/;

export function validateProfileNameChars(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "Profile name cannot be empty";
  return (
    PROFILE_NAME_RE.test(trimmed) ||
    "Only lowercase letters, numbers, _ and - are allowed"
  );
}

export function validateUrl(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "URL cannot be empty";
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "Please enter a valid URL (include https://)";
  }
  if (!parsed.hostname.includes(".")) {
    return "URL hostname looks invalid (no dot in hostname)";
  }
  return true;
}

/**
 * normalizeUrl - prepend `https://` to a bare hostname the user typed, so the
 * caller doesn't have to repeat the scheme-detection logic from `validateUrl`.
 * Used at every call site that previously did `r.trim()` after a `validateUrl`
 * prompt now that the validator accepts schemeless input.
 *
 * Returns the trimmed input unchanged when it already has a scheme; otherwise
 * returns `https://` + the trimmed input.
 */
export function normalizeUrl(val: string): string {
  const trimmed = val.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

// ── Wizard helpers (ported verbatim from v1 src/tui/prompts.ts) ──────────────
// Lives in the adapter (not core) per readme §1.2 - presentation helpers for
// the prompt seam. Phase 4 introduces them so ManualWizardScreen /
// AutoCustomizeScreen share one definition, not two copy-pasted versions.

export function validateNonEmpty(label: string): (val: string) => boolean | string {
  return (val: string) => val.trim().length > 0 || `${label} cannot be empty`;
}

export function validateRegex(val: string): boolean | string {
  try {
    new RegExp(val.trim());
    return true;
  } catch {
    return "Invalid regex pattern - check syntax";
  }
}

export function validateRegexFlags(v: string): boolean | string {
  try {
    new RegExp("", v.trim());
    return true;
  } catch {
    return "Invalid regex flags";
  }
}

export function validatePerfRange(v: string): boolean | string {
  const n = parseInt(v, 10);
  return (!isNaN(n) && n >= 1 && n <= 5) || "Must be between 1 and 5";
}

export function validateDelayRange(v: string): boolean | string {
  const [a, b] = v.split("-").map(Number);
  return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || "Format: min-max";
}

/**
 * Default EPUB filename - verbatim from src/tui/prompts.ts:270-278.
 * Strips every non [a-z0-9 space] grapheme, collapses whitespace to `_`,
 * lowercases, and appends `.epub`.
 */
export function defaultFilenameFor(title: string): string {
  return (
    title
      .replace(/[^a-z0-9\s]/gi, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase() + ".epub"
  );
}

/**
 * parseRanges - parse "5, 10-20, 99" into a set of 1-based indices.
 * Verbatim from v1 src/tui/prompts.ts:1279-1294.
 *
 * Out-of-range indices are clamped into [1, max]; the caller filters the
 * chapter array against the returned set. Returns the empty set on garbage
 * input (parse-error tolerance matching v1, so a typo never silently drops
 * chapters that the user did not intend to remove).
 */
export function parseRanges(input: string, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-").map(Number);
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = Math.max(1, a); i <= Math.min(max, b); i++) result.add(i);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= max) result.add(n);
    }
  }
  return result;
}

