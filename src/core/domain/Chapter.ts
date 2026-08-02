// ─────────────────────────────────────────────────────────────────────────────
//  Chapter — one scraped chapter of a web novel.
//  Ported VERBATIM from src/types.ts:144-150 (v1). Kept byte-identical so v1
//  session files (which embed full Chapter objects) remain readable by v2.
// ─────────────────────────────────────────────────────────────────────────────

export interface Chapter {
  index: number; // 1-based sequential index
  title: string;
  url: string;
  htmlContent: string; // sanitised XHTML-safe HTML
  wordCount: number;
}
