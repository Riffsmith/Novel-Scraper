// ─────────────────────────────────────────────────────────────────────────────
//  format - deterministic 80-column chrome / table / tag renderers.
//
//  Per ADR-P3-B + readme §2.8: every box drawing, table, tag column, and
//  truncation lives here as a PURE STRING FUNCTION at a given width. Screen
//  tests snapshot these outputs at width 80 rather than clack's terminal
//  pixels, keeping tests deterministic.
//
//  NO_COLOR and 8-color degradation (03-tui-design §8) is handled by passing
//  `colors=false`; with `colors=true` (default) we use chalk - already a
//  dependency. The screen always displays via PromptProvider.log, never via
//  a direct console.log, so the chrome rendering (banner/section/tags) is
//  reusable both as snapshot input and as a string passed to log().
//
//  Box-drawing characters preferred (not emojis); fixed-width tags `[INFO]`/
//  `[OK]`/`[WARN]`/`[ERROR]` so columns line up in any monospace font.
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";

export interface FormatOpts {
  width?: number;
  colors?: boolean;
}

const DEFAULT_WIDTH = 80;

function w(opts: FormatOpts | undefined): number {
  return opts?.width ?? DEFAULT_WIDTH;
}

function c(opts: FormatOpts | undefined): boolean {
  return opts?.colors ?? true;
}

// ── Banner / section header ───────────────────────────────────────────────────

export function banner(opts?: FormatOpts): string {
  const width = w(opts);
  const inner = Math.max(2, width - 2); // two border chars
  const padTo = (s: string): string => s + " ".repeat(Math.max(0, inner - s.length));
  const top = "═".repeat(inner);
  return [
    `╔${top}╗`,
    `║${padTo("   WebNovel Scraper  ·  v2.0 (Phase 3)")}║`,
    `║${padTo("   Web Novel to EPUB Packager")}║`,
    `╚${top}╝`,
  ].join("\n");
}

export function section(title: string, opts?: FormatOpts): string {
  const width = w(opts);
  const inner = width - 2;
  const bar = "─".repeat(inner);
  return `\n${bar}\n  ${title}\n${bar}`;
}

// ── Inline tags (fixed-width text columns) ─────────────────────────────────────

export type TagKind = "info" | "success" | "warn" | "error";

const TAG_TEXT: Record<TagKind, string> = {
  info: "[INFO]",
  success: "[OK]",
  warn: "[WARN]",
  error: "[ERROR]",
};

export function tag(kind: TagKind, msg: string, opts?: FormatOpts): string {
  const colorsOn = c(opts);
  const label = TAG_TEXT[kind].padEnd(7);
  if (!colorsOn) return `${label} ${msg}`;
  const colorFn =
    kind === "info"
      ? chalk.cyan
      : kind === "success"
        ? chalk.green
        : kind === "warn"
          ? chalk.yellow
          : chalk.red;
  return `${colorFn(label)} ${chalk.white(msg)}`;
}

export function dim(msg: string, opts?: FormatOpts): string {
  return c(opts) ? chalk.dim(msg) : msg;
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, maxLen);
  return s.slice(0, maxLen - 1) + "…";
}

// ── Cookie table (v1 cookies/cookieManager.ts printCookieTable) ────────────────

import type { StoredCookie } from "../../core/domain/Cookie.js";

export function cookieTable(
  cookies: StoredCookie[],
  domain: string,
  profileName: string,
  opts?: FormatOpts,
): string {
  const width = w(opts);
  const padding = 2;
  const barWidth = Math.min(70, width - padding * 2);
  const bar = "─".repeat(barWidth);

  const top = `${" ".repeat(padding)}${dim(bar, opts)}`;
  const heading = `${" ".repeat(padding)}Cookies for ${domain} · profile "${profileName}" (${cookies.length} stored)`;
  const lines: string[] = ["", top, heading, top];

  if (cookies.length === 0) {
    lines.push(`${" ".repeat(padding)}${dim("(no cookies stored)", opts)}`);
  } else {
    cookies.forEach((ck, i) => {
      const expiry =
        ck.expires === -1 ? dim("session", opts) : new Date(ck.expires * 1000).toLocaleDateString();
      const flags = [
        ck.httpOnly ? "httpOnly" : "",
        ck.secure ? "secure" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const idx = (i + 1).toString().padStart(3) + ".";
      const nameCol = ck.name.padEnd(32);
      const valCol = truncate(ck.value, 24).padEnd(26);
      lines.push(
        `${" ".repeat(padding)}${dim(idx, opts)}  ${nameCol}${valCol}${expiry.padEnd(14)}${flags}`,
      );
    });
  }
  lines.push(top, "");
  return lines.join("\n");
}

// ── Profile summary line (used by CookieManager pickers) ───────────────────────
import type { ProfileSummary } from "../../core/domain/Cookie.js";

export function profileMetaLine(s: ProfileSummary, name: string, _opts?: FormatOpts): string {
  const bits = [
    `${s.cookieCount} cookie${s.cookieCount !== 1 ? "s" : ""}`,
    s.lastUsedAt ? `last used ${s.lastUsedAt.slice(0, 10)}` : "never used",
  ];
  return `${s.label ?? name}  (${bits.join(", ")})`;
}

// ── Session line (SessionSummary) ────────────────────────────────────────────
import type { SessionSummary } from "../../core/domain/Session.js";

function formatUpdatedAt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function sessionLine(s: SessionSummary, _opts?: FormatOpts): string {
  const progress = `${s.completedCount}/${s.totalChapters} chapters`;
  return `${s.novelTitle}  (${progress} · ${s.domain} · updated ${formatUpdatedAt(s.updatedAt)})`;
}

// ── Header strip (Shell chrome) ────────────────────────────────────────────────

export function headerStrip(taskSummary: string, opts?: FormatOpts): string {
  const width = w(opts);
  const label = " WebNovel Scraper ";
  const rest = `${taskSummary}`;
  const fill = Math.max(0, width - label.length - rest.length - 2);
  return `┌${label}${rest}${" ".repeat(fill)}┐`;
}

export function footerStrip(opts?: FormatOpts): string {
  const width = w(opts);
  const text = " output: ./output · logs: ./logs · : commands · Ctrl+Q quit ";
  const pad = Math.max(0, width - text.length - 2);
  return `├${"─".repeat(pad)}${text}┐`;
}

// ── Task progress + post-scrape summary (Phase 4, readme §1.9 / §2.7) ────────
//
// Pure deterministic renderers mirroring v1 src/tui/display.ts - kept off
// cli-progress (ADR-002: a renderable inside the shell body, not a library
// bar). The shell / TaskScreen redraws per `chapter.done`/`checkpoint.saved`
// ScrapeEvent.

/** progress bar: v1-shaped `█`/`░` block with percentage + done/total + ETA. */
export function taskBar(done: number, total: number, opts?: FormatOpts): string {
  const width = w(opts);
  const barSize = Math.min(32, Math.max(8, width - 40));
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const filled = total > 0 ? Math.round((done / total) * barSize) : 0;
  const bar = "█".repeat(filled) + "░".repeat(barSize - filled);
  return `  ${bar} ${pct.toString().padStart(3)}% | ${done}/${total} ch`;
}

/** Final summary card; v1 display.ts:99-131 fields rendered as a string each render. */
export function summaryCard(data: {
  title: string;
  chapters: number;
  words: number;
  timeMs: number;
  output: string;
  errors: number;
}): string {
  const line = "═".repeat(56);
  const lines: string[] = [
    "",
    line,
    "  Scraping Complete",
    line,
    `  Novel      : ${data.title}`,
    `  Chapters   : ${String(data.chapters)}`,
    `  Word count : ${data.words.toLocaleString()}`,
    `  Duration   : ${(data.timeMs / 1000).toFixed(1)}s`,
    `  Saved to   : ${data.output}`,
  ];
  if (data.errors > 0) {
    lines.push(`  Note       : ${data.errors} chapter(s) could not be scraped - see logs for details`);
  }
  lines.push(line, "");
  return lines.join("\n");
}

/** Header strip text for the running task:
 *  `task: title - done/total ch`. Empty when idle. */
export function taskHeader(task: { title: string; progress: { done: number; total: number } } | null): string {
  if (!task) return "";
  return `task: ${task.title} - ${task.progress.done}/${task.progress.total} ch`;
}
