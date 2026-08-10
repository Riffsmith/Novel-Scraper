// ─────────────────────────────────────────────────────────────────────────────
//  Footnote - core domain shape for in-chapter footnote entries emitted by a
//  SiteAdapter's processChapterContent() post-hook (ADR-P7-D).
//
//  Lives in core/domain so both the SiteAdapter port (core/domain/SiteAdapter.ts)
//  and the EPUB writer's per-chapter processing can share the shape without
//  one depending on the other (AGENTS.md "When adding a new cross-boundary
//  type ... define it in core/domain/, not inline in an adapter.").
//
//  The webnovel adapter populates this from the live-page `<anno data-
//  annotation-id>` popup interaction; other adapters leave it unset
//  (processChapterContent itself is optional on SiteAdapter).
// ─────────────────────────────────────────────────────────────────────────────

export interface Footnote {
  ref: string;
  title: string;
  content: string;
}
