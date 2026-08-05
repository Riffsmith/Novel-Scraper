// ─────────────────────────────────────────────────────────────────────────────
//  migrateJsonConfig - the one-shot config.json -> config.yaml migration
//  step-for-step with `docs/05-migration-guide.md` §2.  Owned by the
//  config-yaml adapter; called once on the first v2 run.
//
//  Steps (phase-2 §2.3):
//    1. If `config.yaml` exists -> do nothing. A stray v1 `config.json` is
//       NOT touched - the user might still roll back to v1 (delete YAML,
//       rename .bak back).
//    2. Read `config.json`; on parse failure, log + proceed from defaults
//       (v1 behavior).
//    3. Merge disk over `DEFAULT_CONFIG` (same merge rule as v1 readConfig).
//       Validate with the `appConfig` zod schema (.passthrough()).
//    4. Write `config.yaml` via `template.ts`: every key present, sectioned,
//       commented exactly as in docs/05 §2. Unknown keys appended under
//       `# -- Custom (preserved) --`.
//    5. fsync, then rename `config.json` -> `config.json.bak`. Rename happens
//       only AFTER the YAML write succeeds - a crash between 4 and 5 leaves
//       v1 fully functional (rollback path from §2).
//
//  Backward read:
//    - If only `config.yaml` exists -> use it.
//    - If neither exists (fresh install) -> write `config.yaml` from
//      defaults immediately (mirrors v1's `ensureFile`, appConfig.ts:106-116).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import YAML from "yaml";

import type { AppConfig } from "../../core/domain/AppConfig.js";
import { DEFAULT_CONFIG } from "../../core/domain/AppConfig.js";
import {
  configYamlPath,
  configJsonPath,
  configJsonBakPath,
} from "../store-json/paths.js";
import { atomicWrite } from "../store-json/atomicWrite.js";
import { renderConfigYaml, splitKnownCustom } from "./template.js";
import {
  appConfigSchema,
  APP_CONFIG_SCHEMA_VERSION,
} from "../schemas/appConfig.js";
import type { Logger } from "../../ports/Logger.js";

export type MigrationOutcome =
  | { kind: "noop-yaml-exists" }
  | { kind: "migrated"; yamlPath: string; bakPath: string | null }
  | { kind: "fresh"; yamlPath: string };

/**
 * Run the one-shot config migration.  Returns a descriptor useful for
 * logging and tests (T2 asserts `.bak` exists, byte-compares it to the
 * original).  Idempotent: a second call always reports `noop-yaml-exists`.
 */
export async function migrateJsonConfig(log: Logger): Promise<MigrationOutcome> {
  const yamlPath = configYamlPath();
  const jsonPath = configJsonPath();
  const bakPath = configJsonBakPath();

  // Step 1: yaml already exists -> we own the config.
  if (fs.existsSync(jsonPath) === false && fs.existsSync(yamlPath)) {
    return { kind: "noop-yaml-exists" };
  }
  // The "yaml exists" guard is checked AFTER the json-existence gate so that
  // we still attempt to migrate a stray json even if a yaml exists too.
  // (Per phase-2 §2.3 step 1: "If `config.yaml` exists -> do nothing"; we
  // follow that precisely - both files present => leave as-is.)
  if (fs.existsSync(yamlPath)) {
    return { kind: "noop-yaml-exists" };
  }

  // Step 2/3: read + merge.
  let merged: AppConfig = { ...DEFAULT_CONFIG };
  let customKeys: Record<string, unknown> = {};
  let hadJson = false;

  if (fs.existsSync(jsonPath)) {
    hadJson = true;
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      const diskSafe = appConfigSchema.passthrough().safeParse(raw);
      if (diskSafe.success) {
        const parsed = diskSafe.data as Record<string, unknown>;
        const { known, custom } = splitKnownCustom(parsed);
        // Merge known keys over defaults; carry custom keys for the YAML
        // custom-preserved section.
        merged = { ...DEFAULT_CONFIG, ...(known as unknown as Partial<AppConfig>) };
        customKeys = custom;
      } else {
        log.warn(
          `Failed to validate config.json - using defaults: ${diskSafe.error.message}`,
        );
      }
    } catch (e) {
      log.warn(
        `Failed to parse config.json - using defaults: ${(e as Error).message}`,
      );
    }
  }

  // Step 4: write the yaml via the commented template.
  const yamlText = renderConfigYaml(merged, customKeys);
  await atomicWrite(yamlPath, yamlText);
  log.info(`Config migrated to YAML: ${yamlPath}`);

  if (hadJson) {
    // Step 5: rename original to .bak.  Only after YAML write succeeds.
    try {
      if (fs.existsSync(bakPath)) {
        // Preserve an earlier backup instead of clobbering it - matches
        // manual user expectation and rule "v2 shouldn't touch v1 files".
        log.warn(
          `existing config.json.bak not overwritten; v1 config.json kept as-is at ${jsonPath}`,
        );
        return { kind: "migrated", yamlPath, bakPath: null };
      }
      fs.renameSync(jsonPath, bakPath);
      log.info(`v1 config.json backed up to ${bakPath}`);
      // Stamp schemaVersion on next write only - we did NOT stamp it as part
      // of the migration YAML, because the migrated content comes from a v1
      // JSON file with no schemaVersion (migration-guide §2 example output
      // has no schemaVersion field either; the example is the spec).
      void APP_CONFIG_SCHEMA_VERSION;
      return { kind: "migrated", yamlPath, bakPath };
    } catch (e) {
      log.warn(
        `config.json -> .bak rename failed (yaml already written): ${(e as Error).message}`,
      );
      return { kind: "migrated", yamlPath, bakPath: null };
    }
  }

  // Fresh install path: no json, no yaml at entry, we created yaml.
  return { kind: "fresh", yamlPath };
}

/** True if there is any config file on disk (yaml OR json). */
export function configExists(): boolean {
  return fs.existsSync(configYamlPath()) || fs.existsSync(configJsonPath());
}

/** Parse and validate a YAML config file. Returns null on parse failure. */
export function readYamlConfigOrNull(): AppConfig | null {
  try {
    if (!fs.existsSync(configYamlPath())) return null;
    const raw = YAML.parse(fs.readFileSync(configYamlPath(), "utf8"));
    if (raw === null || typeof raw !== "object") return null;
    const parsed = appConfigSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data as unknown as AppConfig;
  } catch {
    return null;
  }
}
