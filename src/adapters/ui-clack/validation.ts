// ─────────────────────────────────────────────────────────────────────────────
//  validation - pure presentation validators ported verbatim from v1 tui.
//
//  Lives in the adapter (not core) per readme §1.1 - these are presentation
//  helpers for the prompt seam, not domain logic. Byte-identical behavior
//  to v1's `validateDomain` (cookieManager.ts:57-67), `PROFILE_NAME_RE`
//  (cookieManager.ts:70), `validateProfileNameChars` (cookieManager.ts:72-79),
//  and `validateUrl` (prompts.ts:16-23).
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
  try {
    new URL(val.trim());
    return true;
  } catch {
    return "Please enter a valid URL (include https://)";
  }
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

