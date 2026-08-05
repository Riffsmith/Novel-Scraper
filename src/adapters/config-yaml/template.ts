// ─────────────────────────────────────────────────────────────────────────────
//  template - render an AppConfig as commented YAML exactly per
//  `docs/05-migration-guide.md` §2 example.
//
//  Migration guide §2 says "that layout is already published to users -
//  treat it as a spec, not a sketch": every section header, comment string,
//  and key ordering below MUST stay byte-stable across releases.  Comments
//  are not incidental: they explain what each key does to a human reader,
//  and migration-guide §2 promises users see them on first run.
//
//  Unknown keys are appended under a single `# -- Custom (preserved) --`
//  section so a user's third-party edits round-trip a write (phase-2 §2.3).
// ─────────────────────────────────────────────────────────────────────────────

import YAML from "yaml";

import type { AppConfig } from "../../core/domain/AppConfig.js";

// Known-key set, anything else is treated as custom.
const KNOWN_KEYS = new Set<string>([
  "defaultOutputDir",
  "defaultConcurrency",
  "defaultDelayMin",
  "defaultDelayMax",
  "headless",
  "waitUntil",
  "navigationTimeoutMs",
  "humanize",
  "humanPreset",
  "fingerprintSeed",
  "maxRetries",
  "defaultLanguage",
  "defaultAuthor",
  "defaultPublisher",
  "logLevel",
  "askSaveProfile",
  // The schemaVersion field is a v2 invariant, NOT a user key.
  "schemaVersion",
]);

function sectionComment(line: string): string {
  return `# -- ${line} ${"-".repeat(Math.max(0, 60 - line.length - 4))}`;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    // Quote strings with special characters, otherwise bare.
    if (/^[A-Za-z0-9_./-]+$/.test(v) && !/^(true|false|null|yes|no)$/.test(v)) {
      return v;
    }
    return JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Fall through to YAML library scalar rendering for complex values -
  // includes nested objects/arrays appearing in the "Custom (preserved)"
  // section.  We do NOT use createNode(n)!.toString() because the return
  // value TS infers is a narrowing of Node | null; stringify() handles
  // both shapes safely.
  return YAML.stringify(v).trimEnd();
}

/**
 * Render an AppConfig doc as a commented YAML string per docs/05 §2.
 * `customKeys` carries pre-filtered unknown keys with their raw values - they
 * are appended verbatim under a preserved section so third-party edits
 * survive an app settings edit.
 */
export function renderConfigYaml(
  cfg: AppConfig,
  customKeys: Record<string, unknown> = {},
): string {
  const lines: string[] = [];

  lines.push(sectionComment("Output"));
  lines.push(`defaultOutputDir: ${yamlScalar(cfg.defaultOutputDir)}`);
  lines.push("");
  lines.push(sectionComment("Performance"));
  lines.push(`defaultConcurrency: ${cfg.defaultConcurrency}`);
  lines.push(`defaultDelayMin: ${cfg.defaultDelayMin}`);
  lines.push(`defaultDelayMax: ${cfg.defaultDelayMax}`);
  lines.push("");
  lines.push(sectionComment("Browser"));
  lines.push(`headless: ${cfg.headless}`);
  lines.push(`waitUntil: ${cfg.waitUntil}  # domcontentloaded | load | networkidle`);
  lines.push(`navigationTimeoutMs: ${cfg.navigationTimeoutMs}`);
  lines.push("");
  lines.push(sectionComment("Stealth (CloakBrowser)"));
  lines.push(`humanize: ${cfg.humanize}`);
  lines.push(`humanPreset: ${cfg.humanPreset}           # default | careful`);
  lines.push(`fingerprintSeed: ${cfg.fingerprintSeed === null ? "null" : cfg.fingerprintSeed}            # null = random every launch`);
  lines.push("");
  lines.push(sectionComment("Scraping"));
  lines.push(`maxRetries: ${cfg.maxRetries}`);
  lines.push("");
  lines.push(sectionComment("Metadata defaults"));
  lines.push(`defaultLanguage: ${yamlScalar(cfg.defaultLanguage)}`);
  lines.push(`defaultAuthor: ${yamlScalar(cfg.defaultAuthor)}`);
  lines.push(`defaultPublisher: ${yamlScalar(cfg.defaultPublisher)}`);
  lines.push("");
  lines.push(sectionComment("Logging"));
  lines.push(`logLevel: ${cfg.logLevel}                 # error | warn | info | debug`);
  lines.push("");
  lines.push(sectionComment("UX"));
  lines.push(`askSaveProfile: ${cfg.askSaveProfile}`);

  const customEntries = Object.entries(customKeys);
  if (customEntries.length > 0) {
    lines.push("");
    lines.push(sectionComment("Custom (preserved)"));
    for (const [k, v] of customEntries) {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }

  // Trailing newline so file ends cleanly.
  return lines.join("\n") + "\n";
}

/** Detect keys in a parsed config object that are NOT in the known set. */
export function splitKnownCustom(
  raw: Record<string, unknown>,
): { known: Record<string, unknown>; custom: Record<string, unknown> } {
  const known: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(k)) {
      known[k] = v;
    } else {
      custom[k] = v;
    }
  }
  return { known, custom };
}
