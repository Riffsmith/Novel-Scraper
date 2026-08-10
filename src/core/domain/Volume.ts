// ─────────────────────────────────────────────────────────────────────────────
//  Volume + AutoNovelVolume - core domain shape for chapter-grouped catalog
//  walks (ADR-P7-A/B/C).
//
//  Two intentionally-aliased types:
//    - AutoNovelVolume: emitted by a SiteAdapter's scrapeVolumes() during
//      discovery (the "freshly scraped" shape).
//    - Volume: persisted on JobConfig / ScrapeSession and forwarded to
//      EpubWriter.write() at build time (the "stored / job-level" shape).
//
//  They are byte-identical today; kept as separate type names so a future
//  persisted-only field (id / order / createdAt) can land on `Volume`
//  without touching the scraped shape and the type boundary is already
//  in place (AGENTS.md "When adding a new cross-boundary type ... define it
//  in core/domain/, not inline in an adapter.").
//
//  Lives in core/domain per the v2 layout rules: the same shape is consumed
//  by adapters (browser, epub) and the app root, so the type boundary is
//  the domain layer - never an inline adapter type.
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoNovelVolume {
  name: string;
  chapterUrls: string[];
}

export type Volume = AutoNovelVolume;
