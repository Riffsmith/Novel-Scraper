// ─────────────────────────────────────────────────────────────────────────────
//  ConfigStore - read/write/reset global application config port (phase-2 §2.1).
//
//  Phase 1 didn't define this port because there was no v2 config store yet
//  - Phase 2 introduces the YamlConfigStore adapter and this interface
//  together. The signature mirrors v1 src/config/appConfig.ts:
//    readConfig() -> AppConfig
//    writeConfig(updates: Partial<AppConfig>) -> void
//    resetConfig() -> void
//
//  Crucial behaviours kept from v1:
//   - read() never throws for missing/unreadable file - returns defaults.
//   - write() preserves unknown keys (deep-merged over the existing raw
//     document), so third-party edits survive an app settings edit.
//   - reset() overwrites the config with DEFAULT_CONFIG.
//
//  Phase 2 uses YAML for the on-disk layout (ADR-004); the YamlConfigStore
//  adapter handles the JSON->YAML one-shot migration per migration-guide §2.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppConfig } from "../core/domain/AppConfig.js";

export interface ConfigStore {
  read(): Promise<AppConfig>;
  write(updates: Partial<AppConfig>): Promise<void>;
  reset(): Promise<void>;
}
