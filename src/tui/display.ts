import chalk        from 'chalk';
import cliProgress  from 'cli-progress';
import ora          from 'ora';
import type { Ora } from 'ora';

// ── Banner ──────────────────────────────────────────────────────────────────
export function banner(): void {
  console.clear();
  console.log(chalk.cyan.bold(`
  ╔══════════════════════════════════════════════════════╗
  ║   📖  WebNovel Scraper  ·  v1.0.0                   ║
  ║   Elite TUI-based Web Novel → EPUB Packager          ║
  ╚══════════════════════════════════════════════════════╝
`));
}

// ── Section header ──────────────────────────────────────────────────────────
export function section(title: string): void {
  console.log(`\n${chalk.cyan('─'.repeat(56))}`);
  console.log(chalk.white.bold(`  ${title}`));
  console.log(chalk.cyan('─'.repeat(56)));
}

// ── Inline status messages ──────────────────────────────────────────────────
export const info    = (msg: string) => console.log(chalk.cyan('  ℹ ') + chalk.white(msg));
export const success = (msg: string) => console.log(chalk.green('  ✔ ') + chalk.white(msg));
export const warn    = (msg: string) => console.log(chalk.yellow('  ⚠ ') + chalk.white(msg));
export const err     = (msg: string) => console.log(chalk.red('  ✖ ') + chalk.white(msg));
export const dim     = (msg: string) => console.log(chalk.dim('    ' + msg));

// ── Spinner ─────────────────────────────────────────────────────────────────
export function spinner(text: string): Ora {
  return ora({
    text,
    color  : 'cyan',
    spinner: 'dots12',
    indent : 2,
  }).start();
}

// ── Progress bar ─────────────────────────────────────────────────────────────
export function createProgressBar(total: number): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format       : `  ${chalk.cyan('{bar}')} ${chalk.white('{percentage}%')} | {value}/{total} | ETA {eta}s | {chapter}`,
      barCompleteChar  : '█',
      barIncompleteChar: '░',
      hideCursor   : true,
      barsize      : 32,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_grey,
  );
  bar.start(total, 0, { chapter: chalk.dim('starting…') });
  return bar;
}

// ── Chapter link list preview ────────────────────────────────────────────────
export function printChapterList(links: string[], maxDisplay = 30): void {
  const show = links.slice(0, maxDisplay);
  show.forEach((link, i) =>
    console.log(
      chalk.dim(`  ${(i + 1).toString().padStart(5)}.  `) + chalk.white(truncate(link, 80)),
    ),
  );
  if (links.length > maxDisplay) {
    console.log(chalk.dim(`         … and ${links.length - maxDisplay} more`));
  }
}

// ── Final summary card ────────────────────────────────────────────────────────
export function summary(data: {
  title:    string;
  chapters: number;
  words:    number;
  timeMs:   number;
  output:   string;
  errors:   number;
}): void {
  const line = '═'.repeat(56);
  console.log(`\n${chalk.green.bold(line)}`);
  console.log(chalk.green.bold('  ✨  Scraping Complete!'));
  console.log(chalk.green.bold(line));
  console.log(chalk.white(`  📖  Novel    : ${chalk.cyan(data.title)}`));
  console.log(chalk.white(`  📚  Chapters : ${chalk.cyan(String(data.chapters))}`));
  console.log(chalk.white(`  📝  Words    : ${chalk.cyan(data.words.toLocaleString())}`));
  console.log(chalk.white(`  ⏱   Time     : ${chalk.cyan((data.timeMs / 1000).toFixed(1) + 's')}`));
  console.log(chalk.white(`  📁  Output   : ${chalk.cyan(data.output)}`));
  if (data.errors > 0)
    console.log(chalk.yellow(`  ⚠   Errors   : ${data.errors} chapter(s) could not be scraped`));
  console.log(chalk.green.bold(line + '\n'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '…' : s;
}
