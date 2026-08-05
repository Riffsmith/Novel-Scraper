// ─────────────────────────────────────────────────────────────────────────────
//  YamlConfigStore - ConfigStore adapter that reads/writes config.yaml.
//
//  Implements the v1 behavior surface (phase-2 §1.1):
//   - Defaults-first read: `{ ...DEFAULT_CONFIG, ...disk }`.  Missing keys
//     fall back; an unreadable file logs a warning and returns pure
//     defaults (never throws).
//   - Unknown-key preservation on write: `write()` deep-merges over the
//     existing raw file so unknown third-party keys survive a settings edit.
//     This is v1's most-important invariant (cookies/store.ts:134-146 +
//     appConfig.ts:134-146).
//   - `reset()` writes DEFAULT_CONFIG (overwrites everything).
//   - The JSON -> YAML one-shot migration runs transparently on the first
//     `read()` call.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import YAML from "yaml";

import type { ConfigStore } from "../../ports/ConfigStore.js";
import type { AppConfig } from "../../core/domain/AppConfig.js";
import { DEFAULT_CONFIG } from "../../core/domain/AppConfig.js";
import type { Logger } from "../../ports/Logger.js";

import { atomicWrite } from "../store-json/atomicWrite.js";
import {
  configYamlPath,
  configJsonPath,
  configJsonBakPath,
} from "../store-json/paths.js";
import {
  migrateJsonConfig,
  readYamlConfigOrNull,
} from "./migrateJsonConfig.js";
import { renderConfigYaml, splitKnownCustom } from "./template.js";
import { appConfigSchema } from "../schemas/appConfig.js";

export class YamlConfigStore implements ConfigStore {
  private migrationPromise: Promise<unknown> | null = null;

  constructor(private log: Logger) {}

  /** Ensure the one-shot migration has run; idempotent. */
  private async ensureMigrated(): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = migrateJsonConfig(this.log);
    }
    await this.migrationPromise;
  }

  async read(): Promise<AppConfig> {
    await this.ensureMigrated();

    // If yaml exists -> parse + merge over defaults (defaults-first per phase-2 §1.1).
    // If neither yaml nor json existed (impossible after ensureMigrated) - returns defaults.
    const yaml = readYamlConfigOrNull();
    if (yaml === null) {
      // Migration either failed validation or yaml doesn't exist - return defaults.
      // This matches v1's "unreadable file -> returns defaults" path
      // (appConfig.ts:125-130).
      const jsonFallback = this.readJsonOrDefaults();
      // Validate + merge over defaults.
      return { ...DEFAULT_CONFIG, ...jsonFallback };
    }
    return { ...DEFAULT_CONFIG, ...yaml };
  }

  async write(updates: Partial<AppConfig>): Promise<void> {
    await this.ensureMigrated();

    // Read existing raw YAML to preserve unknown keys (the deep-merge over
    // raw rule - phase-2 §2.3 #3 / appConfig.ts:134-145).
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configYamlPath())) {
      try {
        const raw = YAML.parse(fs.readFileSync(configYamlPath(), "utf8"));
        if (raw && typeof raw === "object") {
          existing = raw as Record<string, unknown>;
        }
      } catch (e) {
        this.log.warn(`Failed to parse existing config.yaml for merge: ${(e as Error).message}`);
      }
    }

    // Merge: existing raw fields overridden by updates (which carry known
    // schema keys).  Unknown keys (anything not in KNOWN_KEYS) survive via
    // splitKnownCustom - the renderConfigYaml template appends them in the
    // "Custom (preserved)" section.
    const merged: Record<string, unknown> = { ...existing, ...updates };
    // Drop schemaVersion anyway - the YAML file is re-rendered from defaults
    // + the merged keys; if the user added schemaVersion manually it should
    // round-trip with the unknown-keys path (splitKnownCustom sees schemaVersion
    // and treats it as known, sees nothing custom).
    const { known, custom } = splitKnownCustom(merged);

    // Build an AppConfig: DEFAULT_CONFIG overridden by the known fields.
    const cfg: AppConfig = { ...DEFAULT_CONFIG, ...(known as unknown as Partial<AppConfig>) };
    const yamlText = renderConfigYaml(cfg, custom);
    await atomicWrite(configYamlPath(), yamlText);
    this.log.info("Config saved", { file: configYamlPath() });
  }

  async reset(): Promise<void> {
    await this.ensureMigrated();
    const yamlText = renderConfigYaml(DEFAULT_CONFIG);
    await atomicWrite(configYamlPath(), yamlText);
    this.log.info("Config reset to defaults");
  }

  // Read a v1 config.json used as a fallback for the brief window when the
  // migration hasn't run yet but `read()` was called - actually unreachable
  // because `ensureMigrated` blocks first, but kept for parity with v1's
  // defensive shape.
  private readJsonOrDefaults(): Partial<AppConfig> {
    try {
      if (!fs.existsSync(configJsonPath())) return {};
      const raw = JSON.parse(fs.readFileSync(configJsonPath(), "utf8"));
      const parsed = appConfigSchema.partial().safeParse(raw);
      if (!parsed.success) return {};
      return parsed.data as Partial<AppConfig>;
    } catch {
      return {};
    }
  }

  // Expose migration paths for Phase 5 doctor() - via composition only.
  static get _paths() {
    return {
      yaml: configYamlPath(),
      json: configJsonPath(),
      bak: configJsonBakPath(),
    };
  }
}
