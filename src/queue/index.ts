import PQueue            from 'p-queue';
import type { Browser, Cookie }  from 'playwright';
import type { Chapter, QueueTask, ScrapeError, ScraperConfig, AppConfig } from '../types.js';
import { createStealthContext, createPage, randomDelay } from '../scraper/browser.js';
import type { BrowserContext } from 'playwright';
import { scrapeChapter }   from '../scraper/chapter.js';
import logger              from '../logger/index.js';
import { createProgressBar } from '../tui/display.js';
import chalk               from 'chalk';

export interface QueueResult {
  chapters : Chapter[];
  errors   : ScrapeError[];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Task queue – manages N concurrent browser contexts, retries failed
//  tasks up to maxRetries, and streams progress to the TUI.
// ═══════════════════════════════════════════════════════════════════════════
export async function runScrapeQueue(
  browser : Browser,
  urls    : string[],
  config  : ScraperConfig,
  cookies?: Cookie[],   // pre-loaded from the cookie store for this domain
  appCfg? : AppConfig,  // global settings — maxRetries, waitUntil, navTimeout
): Promise<QueueResult> {
  const { concurrency, delayMin, delayMax } = config;
  const maxRetries   = appCfg?.maxRetries          ?? 3;
  const waitUntil    = appCfg?.waitUntil            ?? 'domcontentloaded';
  const navTimeoutMs = appCfg?.navigationTimeoutMs  ?? 30_000;

  // ── Pre-allocate result slots ──────────────────────────────────────────
  const slots: (Chapter | null)[] = new Array(urls.length).fill(null);
  const errors: ScrapeError[]     = [];
  let   completed                  = 0;

  const progressBar = createProgressBar(urls.length);

  // ── Context pool (one per concurrent slot) ────────────────────────────
  //  Each context gets the same cookie snapshot so every worker is
  //  authenticated from the very first request.
  const ctxPool: BrowserContext[] = [];
  for (let i = 0; i < concurrency; i++) {
    ctxPool.push(await createStealthContext(browser, cookies));
  }
  let ctxIdx = 0;
  const nextCtx = () => ctxPool[ctxIdx++ % ctxPool.length];

  // ── Queue ──────────────────────────────────────────────────────────────
  const queue = new PQueue({ concurrency });

  const processTask = async (task: QueueTask): Promise<void> => {
    const ctx  = nextCtx();
    const page = await createPage(ctx);

    try {
      // Jitter before each request
      await randomDelay(delayMin, delayMax);

      const chapter = await scrapeChapter(page, task.url, task.index + 1, {
        contentSelector  : config.contentSelector,
        titleSelector    : config.titleSelector,
        separateTitle    : config.separateTitle,
        excludeSelectors : config.excludeSelectors,
        delayMin,
        delayMax,
        waitUntil,
        navTimeoutMs,
      });

      if (chapter) {
        slots[task.index] = chapter;
      } else {
        // Retry
        if (task.retries < task.maxRetries) {
          task.retries++;
          const backoff = task.retries * delayMax;
          logger.warn(`Re-queuing ch.${task.index + 1} (attempt ${task.retries}/${task.maxRetries}) after ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          await queue.add(() => processTask(task));
          return;
        }
        errors.push({ url: task.url, error: 'No content extracted after max retries', retries: task.retries });
      }
    } catch (e) {
      if (task.retries < task.maxRetries) {
        task.retries++;
        const backoff = task.retries * delayMax;
        logger.warn(`Error ch.${task.index + 1} – retrying (${task.retries}/${task.maxRetries}): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, backoff));
        await queue.add(() => processTask(task));
        return;
      }
      errors.push({ url: task.url, error: (e as Error).message, retries: task.retries });
      logger.error(`Dropped ch.${task.index + 1}: ${(e as Error).message}`);
    } finally {
      await page.close().catch(() => {/* ignore if already closed */});
    }

    completed++;
    progressBar.update(completed, {
      chapter: chalk.dim(`ch.${task.index + 1}`),
    });
  };

  // ── Enqueue all tasks ─────────────────────────────────────────────────
  const tasks: QueueTask[] = urls.map((url, index) => ({
    url,
    index,
    retries   : 0,
    maxRetries,   // sourced from appCfg.maxRetries, default 3
  }));

  await queue.addAll(tasks.map(task => () => processTask(task)));
  await queue.onIdle();

  progressBar.stop();

  // ── Tear down context pool ────────────────────────────────────────────
  for (const ctx of ctxPool) {
    await ctx.close().catch(() => {});
  }

  // ── Collect valid chapters in index order ─────────────────────────────
  const chapters = slots
    .filter((c): c is Chapter => c !== null)
    .sort((a, b) => a.index - b.index);

  logger.info(`Queue complete: ${chapters.length} ok, ${errors.length} failed`);

  return { chapters, errors };
}
