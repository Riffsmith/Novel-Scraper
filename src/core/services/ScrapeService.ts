// ─────────────────────────────────────────────────────────────────────────────
//  ScrapeService — the queue, ported from src/queue/index.ts.
//
//  Same slot-seeding, p-queue, retry math, 45 s challenge multiplier,
//  4 s checkpoint throttle, context pool. Three deliberate changes only:
//    1. cancel() is first-class.
//    2. Checkpoint callback is sessions.save().
//    3. Context pool is behind BrowserPort.
// ─────────────────────────────────────────────────────────────────────────────

import PQueue from "p-queue";
import { SecurityChallengeError } from "../errors.js";
import { ChapterExtractor } from "./ChapterExtractor.js";

import type { Chapter } from "../domain/Chapter.js";
import type {
  ScrapeError,
  ScrapeResult,
  JobConfig,
} from "../domain/JobConfig.js";
import type { ScrapeSession } from "../domain/Session.js";
import type { DomainCookie } from "../domain/Cookie.js";
import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
} from "../../ports/BrowserPort.js";
import type { SessionStore } from "../../ports/SessionStore.js";
import type { EpubWriter } from "../../ports/EpubWriter.js";
import type { UIAdapter } from "../../ports/UIAdapter.js";
import type { Logger } from "../../ports/Logger.js";

const CHALLENGE_BACKOFF_MS = 45_000;
const CHECKPOINT_SAVE_INTERVAL_MS = 4_000;

export class ScrapeService {
  private abortFlag = false;

  constructor(
    private deps: {
      browser: BrowserPort;
      sessions: SessionStore;
      epub: EpubWriter;
      ui: UIAdapter;
      log: Logger;
    },
  ) {}

  cancel(): void {
    this.abortFlag = true;
  }

  async run(
    job: JobConfig,
    cookies?: DomainCookie[],
    resume?: { session: ScrapeSession },
  ): Promise<ScrapeResult> {
    const startedAt = Date.now();
    this.abortFlag = false;

    const extractor = new ChapterExtractor(this.deps.log);
    const browser = await this.deps.browser.launch({
      headless: job.headless,
      humanize: false,
      humanPreset: "default",
      fingerprintSeed: null,
      timezone: "America/New_York",
      locale: "en-US",
    });
    try {
      const urls = resume?.session?.chapterUrls ?? job.chapterLinks ?? [];
      if (urls.length === 0) {
        throw new Error(
          "No chapter URLs — discovery must run before ScrapeService",
        );
      }

      const concurrency = job.concurrency;
      const maxRetries = 3;

      // Pre-allocate slots
      const slots: (Chapter | null)[] = new Array(urls.length).fill(null);
      const alreadyDone = new Set<number>();

      for (const ch of resume?.session?.completedChapters ?? []) {
        const slotIdx = ch.index - 1;
        if (slotIdx >= 0 && slotIdx < slots.length) {
          slots[slotIdx] = ch;
          alreadyDone.add(slotIdx);
        }
      }
      const errors: ScrapeError[] = [];
      let completed = alreadyDone.size;
      const sessionRef = resume?.session;

      // Context pool
      const ctxPool: ContextHandle[] = [];
      for (let i = 0; i < concurrency; i++) {
        ctxPool.push(await this.deps.browser.createContext(browser, cookies));
      }
      let ctxIdx = 0;
      const nextCtx = () => ctxPool[ctxIdx++ % ctxPool.length];

      // Throttled checkpoint
      let lastSaveAt = 0;
      const maybePersist = async (force = false) => {
        if (!sessionRef) return;
        const now = Date.now();
        if (!force && now - lastSaveAt < CHECKPOINT_SAVE_INTERVAL_MS) return;
        lastSaveAt = now;

        try {
          const updated: ScrapeSession = {
            ...sessionRef,
            updatedAt: new Date().toISOString(),
            completedChapters: slots.filter((c): c is Chapter => c !== null),
            errors: [...errors],
          };
          await this.deps.sessions.save(updated);
          this.deps.ui.emit({
            type: "checkpoint.saved",
            sessionId: sessionRef.id,
            done: completed,
          });
        } catch (e) {
          this.deps.log.warn(
            `Checkpoint persistence failed: ${(e as Error).message}`,
          );
        }
      };

      // Initial checkpoint
      await maybePersist(true);

      const queue = new PQueue({ concurrency });

      const processTask = async (task: {
        url: string;
        index: number;
        retries: number;
      }): Promise<void> => {
        if (this.abortFlag) return;

        const ctx = nextCtx();
        const page = await this.deps.browser.newPage(ctx);

        try {
          await delay(randomInt(job.delayMin, job.delayMax));

          const chapter = await extractor.extract(
            page,
            task.url,
            task.index + 1,
            {
              contentSelector: job.contentSelector,
              titleSelector: job.titleSelector,
              separateTitle: job.separateTitle,
              excludeSelectors: job.excludeSelectors,
              delayMin: job.delayMin,
              delayMax: job.delayMax,
              waitUntil: "domcontentloaded",
              navTimeoutMs: 30_000,
            },
          );

          if (chapter) {
            slots[task.index] = chapter;
            this.deps.ui.emit({
              type: "chapter.done",
              index: task.index + 1,
              title: chapter.title,
              words: chapter.wordCount,
            });
          } else {
            if (task.retries < maxRetries) {
              task.retries++;
              const backoff = task.retries * job.delayMax;
              this.deps.ui.emit({
                type: "chapter.retry",
                index: task.index + 1,
                attempt: task.retries,
                max: maxRetries,
                challenge: false,
                backoffMs: backoff,
              });
              await delay(backoff);
              await queue.add(() => processTask(task));
              return;
            }
            errors.push({
              url: task.url,
              error: "No content extracted after max retries",
              retries: task.retries,
            });
            this.deps.ui.emit({
              type: "chapter.failed",
              index: task.index + 1,
              url: task.url,
              error: "No content extracted after max retries",
            });
            slots[task.index] = makeFailedChapterPlaceholder(
              task.index,
              task.url,
            );
          }
        } catch (e) {
          const isChallenge = e instanceof SecurityChallengeError;
          if (isChallenge) {
            this.deps.ui.emit({ type: "challenge.waiting", url: task.url });
          }
          if (task.retries < maxRetries) {
            task.retries++;
            const backoff = isChallenge
              ? task.retries * CHALLENGE_BACKOFF_MS
              : task.retries * job.delayMax;
            this.deps.ui.emit({
              type: "chapter.retry",
              index: task.index + 1,
              attempt: task.retries,
              max: maxRetries,
              challenge: isChallenge,
              backoffMs: backoff,
            });
            this.deps.log.warn(
              `${isChallenge ? "Security challenge on" : "Error on"} ch.${task.index + 1} – retrying (${task.retries}/${maxRetries}) after ${backoff}ms: ${(e as Error).message}`,
            );
            await delay(backoff);
            await queue.add(() => processTask(task));
            return;
          }
          errors.push({
            url: task.url,
            error: (e as Error).message,
            retries: task.retries,
          });
          this.deps.ui.emit({
            type: "chapter.failed",
            index: task.index + 1,
            url: task.url,
            error: (e as Error).message,
          });
          this.deps.log.error(
            `Dropped ch.${task.index + 1}: ${(e as Error).message}`,
          );
          slots[task.index] = makeFailedChapterPlaceholder(
            task.index,
            task.url,
          );
        } finally {
          try {
            await page.close().catch(() => {});
          } catch {
            /* already closed */
          }
          completed++;
          await maybePersist();
        }
      };

      const tasks = urls
        .map((url, idx) => ({ url, index: idx, retries: 0 }))
        .filter((t) => !alreadyDone.has(t.index));

      await queue.addAll(tasks.map((task) => () => processTask(task)));
      await queue.onIdle();

      // Final checkpoint
      await maybePersist(true);

      // Context teardown
      for (const ctx of ctxPool) {
        await ctx.close().catch(() => {});
      }

      const chapters = slots
        .filter((c): c is Chapter => c !== null)
        .sort((a, b) => a.index - b.index);

      this.deps.log.info(
        `Queue complete: ${chapters.length} ok, ${errors.length} failed`,
      );

      // EPUB
      if (job.output.epub && chapters.length > 0) {
        this.deps.ui.emit({ type: "epub.started" });
        const { path: epubPath } = await this.deps.epub.write(
          chapters,
          job.metadata,
          job.outputDir,
          job.outputFilename,
        );
        this.deps.ui.emit({ type: "epub.done", path: epubPath });

        if (sessionRef) {
          await this.deps.sessions.delete(sessionRef.id);
        }
      }

      const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
      const scrapeMs = Date.now() - startedAt;

      return { chapters, errors, totalWords, scrapeMs };
    } finally {
      await this.deps.browser.closeAll().catch(() => {});
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeFailedChapterPlaceholder(index: number, url: string): Chapter {
  return {
    index: index + 1,
    title: `Chapter ${index + 1} (failed to scrape)`,
    url,
    htmlContent: "<p><em>This chapter could not be scraped.</em></p>",
    wordCount: 0,
  };
}
