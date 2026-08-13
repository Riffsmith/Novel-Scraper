// ─────────────────────────────────────────────────────────────────────────────
//  NovelRegistry — registry of scraped novels for tracking/history.
//  Inspired by inkbinder's novel_registry.json format.
// ─────────────────────────────────────────────────────────────────────────────

export interface NovelRegistryEntry {
  id: string;
  title: string;
  author: string;
  url: string;
  totalChapters: number;
  downloadedChapters: number;
  lastScraped: string; // ISO timestamp
  epubPath: string;
  firstScraped: string; // ISO timestamp
  status: "ongoing" | "completed" | "hiatus" | "dropped";
}

export interface NovelRegistry {
  version: string;
  created: string; // ISO timestamp
  lastUpdated: string; // ISO timestamp
  novels: Record<string, NovelRegistryEntry>;
}

export function generateRegistryId(title: string, author: string): string {
  const base = `${title}_${author}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = Math.random().toString(36).substring(2, 10);
  return `${base}_${suffix}`;
}

export const REGISTRY_SCHEMA_VERSION = "1.0.0";

export function createEmptyRegistry(): NovelRegistry {
  const now = new Date().toISOString();
  return {
    version: REGISTRY_SCHEMA_VERSION,
    created: now,
    lastUpdated: now,
    novels: {},
  };
}