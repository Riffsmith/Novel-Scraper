// ─────────────────────────────────────────────────────────────────────────────
//  JsonNovelRegistryStore - persists the novel registry as JSON.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

import type { NovelRegistryStore } from "../../ports/NovelRegistryStore.js";
import type { NovelRegistry, NovelRegistryEntry } from "../../core/domain/NovelRegistry.js";
import type { Logger } from "../../ports/Logger.js";

import { novelRegistryFilePath } from "./paths.js";
import { atomicWrite } from "./atomicWrite.js";

export class JsonNovelRegistryStore implements NovelRegistryStore {
  constructor(private log: Logger) {}

  async load(): Promise<NovelRegistry> {
    try {
      const raw = fs.readFileSync(novelRegistryFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      return this.normalizeRegistry(parsed);
    } catch {
      const { createEmptyRegistry } = await import("../../core/domain/NovelRegistry.js");
      return createEmptyRegistry();
    }
  }

  async save(registry: NovelRegistry): Promise<void> {
    const toSave: NovelRegistry = {
      ...registry,
      lastUpdated: new Date().toISOString(),
    };
    await atomicWrite(novelRegistryFilePath(), JSON.stringify(toSave, null, 2));
  }

  async upsert(entry: NovelRegistryEntry): Promise<void> {
    const registry = await this.load();
    registry.novels[entry.id] = entry;
    await this.save(registry);
  }

  async get(id: string): Promise<NovelRegistryEntry | null> {
    const registry = await this.load();
    return registry.novels[id] ?? null;
  }

  async list(): Promise<NovelRegistryEntry[]> {
    const registry = await this.load();
    return Object.values(registry.novels).sort(
      (a, b) => (a.lastScraped < b.lastScraped ? 1 : -1),
    );
  }

  private normalizeRegistry(raw: unknown): NovelRegistry {
    const now = new Date().toISOString();
    const base: NovelRegistry = {
      version: "1.0.0",
      created: now,
      lastUpdated: now,
      novels: {},
    };

    if (!raw || typeof raw !== "object") return base;

    const r = raw as Record<string, unknown>;

    if (typeof r.version === "string") base.version = r.version;
    if (typeof r.created === "string") base.created = r.created;
    if (typeof r.lastUpdated === "string") base.lastUpdated = r.lastUpdated;

    if (r.novels && typeof r.novels === "object") {
      for (const [id, entry] of Object.entries(r.novels as Record<string, unknown>)) {
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          if (typeof e.id === "string" && typeof e.title === "string") {
            base.novels[id] = {
              id: e.id,
              title: e.title,
              author: typeof e.author === "string" ? e.author : "",
              url: typeof e.url === "string" ? e.url : "",
              totalChapters: typeof e.totalChapters === "number" ? e.totalChapters : 0,
              downloadedChapters: typeof e.downloadedChapters === "number" ? e.downloadedChapters : 0,
              lastScraped: typeof e.lastScraped === "string" ? e.lastScraped : now,
              epubPath: typeof e.epubPath === "string" ? e.epubPath : "",
              firstScraped: typeof e.firstScraped === "string" ? e.firstScraped : now,
              status:
                typeof e.status === "string" &&
                ["ongoing", "completed", "hiatus", "dropped"].includes(e.status)
                  ? (e.status as NovelRegistryEntry["status"])
                  : "ongoing",
            };
          }
        }
      }
    }

    return base;
  }
}