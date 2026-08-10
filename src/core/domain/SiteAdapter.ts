// ─────────────────────────────────────────────────────────────────────────────
//  SiteAdapter + AutoScrapeResult - core domain shapes for the v2 site-adapter
//  registry (ADR-P4-A).
//
//  Why this lives in core/domain and not in src/sites/: AGENTS.md pins v1's
//  src/sites/ as oracle territory until Phase 6 (the v2 ported adapters live
//  under src/adapters/site-*/ and the registry under src/adapters/site-registry/).
//  Both the TUI screens and the (Phase 5) CLI need to share these shapes, so
//  they belong in core - exactly like JobConfig / NovelMetadata live here.
//
//  The v2 SiteAdapter references `PageHandle` (from ports/BrowserPort.ts) - a
//  pure interface, type-only import. Core depends on the port, which is the
//  correct hexagonal direction: the port defines an adapter protocol, the
//  adapter implementer (wtr-lab / novelfire / a future 3rd site) plugs in.
//
//  There is deliberately no `ports/SiteAdapter.ts` entry, because the registry
//  is *a pluggable set*, wired in the composition root (`app/tui.ts` and,
//  later, `app/cli.ts`) alongside the other adapters - not a single injected
//  port (design §2.1).
//
//  Ported from v1 src/sites/types.ts:1-50 byte-for-byte on the
//  default*Selector surface (the review screens pre-fill from these); only the
//  Playwright `Page` import becomes `PageHandle` (ADR-P4-A).
// ─────────────────────────────────────────────────────────────────────────────

import type { PageHandle } from "../../ports/BrowserPort.js";
import type { WaitUntil } from "./AppConfig.js";
import type { AutoNovelVolume } from "./Volume.js";
import type { Footnote } from "./Footnote.js";

// ── Metadata scraped automatically from a novel's landing page ────────────────
export interface AutoNovelMetadata {
  title: string;
  author: string;
  description: string;
  coverUrl?: string;
}

// ── Full result of an auto-scrape probe (metadata + chapter URLs) ───────────
//
// `volumes?` is additive-optional (ADR-P7-B): site adapters that walk a
// volume-grouped catalog (webnovel) populate it; flat-catalog adapters
// (wtr-lab, novelfire) leave it `undefined` and the EPUB writer falls through
// its existing no-volumes path. Callers resolve volumes via
// `result.volumes ?? job.volumes ?? undefined`.
export interface AutoScrapeResult {
  siteId: string;
  novelUrl: string;
  metadata: AutoNovelMetadata;
  chapterLinks: string[];
  volumes?: AutoNovelVolume[];
}

// ── SiteAdapter - one per supported site. Add new sites by implementing this
// interface and registering them in src/adapters/site-registry/index.ts.
export interface SiteAdapter {
  id: string; // stable machine key, e.g. 'wtr-lab'
  label: string; // human-friendly name shown in the TUI

  /** Does this adapter know how to handle the given entry URL? */
  matches(url: string): boolean;

  /** Build the table-of-contents URL for a given novel URL. */
  getTocUrl(novelUrl: string): string;

  /** Scrape novel-level metadata (title, author, description, cover). */
  scrapeMetadata(page: PageHandle, novelUrl: string): Promise<AutoNovelMetadata>;

  /** Scrape every chapter URL, returned in correct reading order. */
  scrapeChapterLinks(
    page: PageHandle,
    novelUrl: string,
    opts: { waitUntil: WaitUntil; navTimeoutMs: number },
  ): Promise<string[]>;

  /**
   * Optional catalog-volume walk (ADR-P7-B). Site adapters that walk a
   * volume-grouped catalog return one `AutoNovelVolume` per visible volume
   * group (name + ordered chapter URLs). Flat-catalog adapters leave this
   * unset; callers check `result.volumes ?? job.volumes ?? undefined`.
   *
   * The adapter is the single DOM-knowledge authority for volume grouping;
   * the EPUB writer is the single index authority (resolves URL -> Chapter
   * at build time per ADR-P7-C).
   */
  scrapeVolumes?(
    page: PageHandle,
    novelUrl: string,
    opts: { waitUntil: WaitUntil; navTimeoutMs: number },
  ): Promise<AutoNovelVolume[] | undefined>;

  /**
   * Optional per-chapter content post-hook (ADR-P7-D). Runs AFTER the
   * generic `ChapterExtractor` extraction (challenge wait-out, content-
   * selector pull, exclude-selector strip) and BEFORE the EPUB writer's
   * `toXhtml()` post-process. The hook's returned `htmlContent` BYPASSES
   * `sanitize-html` (the webnovel adapter applies its own allow-list via
   * the reference's blacklist). Adapters that don't define this hook keep
   * the existing `sanitize-html` path.
   *
   * `footnotes` (when present on the return) are appended to the chapter's
   * `htmlContent` by the hook itself - the EPUB writer needs no separate
   * footnote handling. The `Chapter` domain shape is unchanged.
   */
  processChapterContent?(input: {
    rawHtml: string;
    title: string;
    footnotes?: Footnote[];
  }): { htmlContent: string; footnotes?: Footnote[] };

  // ── Defaults pre-filled into the auto-scrape review screen ─────────────
  // (the user can always override these before the scrape starts)
  defaultContentSelector: string;
  defaultTitleSelector?: string;
  defaultSeparateTitle: boolean;
  defaultExcludeSelectors: string[];
}
