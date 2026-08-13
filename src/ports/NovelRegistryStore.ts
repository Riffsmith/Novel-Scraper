// ─────────────────────────────────────────────────────────────────────────────
//  NovelRegistryStore — persists the novel registry to disk.
// ─────────────────────────────────────────────────────────────────────────────

import type { NovelRegistry, NovelRegistryEntry } from "../core/domain/NovelRegistry.js";

export interface NovelRegistryStore {
  load(): Promise<NovelRegistry>;
  save(registry: NovelRegistry): Promise<void>;
  upsert(entry: NovelRegistryEntry): Promise<void>;
  get(id: string): Promise<NovelRegistryEntry | null>;
  list(): Promise<NovelRegistryEntry[]>;
}