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

// ── Metadata scraped automatically from a novel's landing page ────────────────
export interface AutoNovelMetadata {
  title: string;
  author: string;
  description: string;
  coverUrl?: string;
}

// ── Full result of an auto-scrape probe (metadata + chapter URLs) ───────────
export interface AutoScrapeResult {
  siteId: string;
  novelUrl: string;
  metadata: AutoNovelMetadata;
  chapterLinks: string[];
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

  // ── Defaults pre-filled into the auto-scrape review screen ─────────────
  // (the user can always override these before the scrape starts)
  defaultContentSelector: string;
  defaultTitleSelector?: string;
  defaultSeparateTitle: boolean;
  defaultExcludeSelectors: string[];
}
