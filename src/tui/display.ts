import chalk from "chalk";
import cliProgress from "cli-progress";
import ora from "ora";
import type { Ora } from "ora";

// ── Banner ──────────────────────────────────────────────────────────────────
export function banner(): void {
  console.clear();
  console.log(
    chalk.cyan.bold(`
  ╔══════════════════════════════════════════════════════╗
  ║   WebNovel Scraper  ·  v1.0.0                         ║
  ║   Web Novel to EPUB Packager                          ║
  ╚══════════════════════════════════════════════════════╝
`),
  );
}

// ── Section header ──────────────────────────────────────────────────────────
export function section(title: string): void {
  console.log(`\n${chalk.cyan("─".repeat(56))}`);
  console.log(chalk.white.bold(`  ${title}`));
  console.log(chalk.cyan("─".repeat(56)));
}

// ── Inline status messages ──────────────────────────────────────────────────
// Fixed-width text tags instead of icon glyphs, so columns still line up
// regardless of terminal font/emoji support.
function tag(text: string, colorFn: (s: string) => string): string {
  return colorFn(`  ${text.padEnd(7)}`);
}

export const info = (msg: string) =>
  console.log(tag("[INFO]", chalk.cyan) + chalk.white(msg));
export const success = (msg: string) =>
  console.log(tag("[OK]", chalk.green) + chalk.white(msg));
export const warn = (msg: string) =>
  console.log(tag("[WARN]", chalk.yellow) + chalk.white(msg));
export const err = (msg: string) =>
  console.log(tag("[ERROR]", chalk.red) + chalk.white(msg));
export const dim = (msg: string) => console.log(chalk.dim("    " + msg));

// ── Spinner ─────────────────────────────────────────────────────────────────
export function spinner(text: string): Ora {
  return ora({
    text,
    color: "cyan",
    spinner: "dots12",
    indent: 2,
  }).start();
}

// ── Progress bar ─────────────────────────────────────────────────────────────
export function createProgressBar(total: number): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format: `  ${chalk.cyan("{bar}")} ${chalk.white("{percentage}%")} | {value}/{total} | ETA {eta}s | {chapter}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      barsize: 32,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_grey,
  );
  bar.start(total, 0, { chapter: chalk.dim("starting…") });
  return bar;
}

// ── Print multi-paragraph text with blank lines between paragraphs ────────
export function printParagraphs(text: string, indent = "  "): void {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  paragraphs.forEach((p, i) => {
    p.split("\n").forEach((line) =>
      console.log(chalk.dim(indent) + chalk.white(line)),
    );
    if (i < paragraphs.length - 1) console.log("");
  });
}

// ── Chapter link list preview ────────────────────────────────────────────────
export function printChapterList(links: string[], maxDisplay = 50): void {
  const show = links.slice(0, maxDisplay);
  show.forEach((link, i) =>
    console.log(
      chalk.dim(`  ${(i + 1).toString().padStart(5)}.  `) +
        chalk.white(truncate(link, 80)),
    ),
  );
  if (links.length > maxDisplay) {
    console.log(chalk.dim(`         … and ${links.length - maxDisplay} more`));
  }
}

// ── Final summary card ────────────────────────────────────────────────────────
export function summary(data: {
  title: string;
  chapters: number;
  words: number;
  timeMs: number;
  output: string;
  errors: number;
}): void {
  const line = "═".repeat(56);
  console.log(`\n${chalk.green.bold(line)}`);
  console.log(chalk.green.bold("  Scraping Complete"));
  console.log(chalk.green.bold(line));
  console.log(chalk.white(`  Novel      : ${chalk.cyan(data.title)}`));
  console.log(
    chalk.white(`  Chapters   : ${chalk.cyan(String(data.chapters))}`),
  );
  console.log(
    chalk.white(`  Word count : ${chalk.cyan(data.words.toLocaleString())}`),
  );
  console.log(
    chalk.white(
      `  Duration   : ${chalk.cyan((data.timeMs / 1000).toFixed(1) + "s")}`,
    ),
  );
  console.log(chalk.white(`  Saved to   : ${chalk.cyan(data.output)}`));
  if (data.errors > 0)
    console.log(
      chalk.yellow(
        `  Note       : ${data.errors} chapter(s) could not be scraped — see logs/error.log for details`,
      ),
    );
  console.log(chalk.green.bold(line + "\n"));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "…" : s;
}
