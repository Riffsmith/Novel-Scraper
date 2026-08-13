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
  ScraperConfig,
  ScrapeError,
  ScrapeResult,
  JobConfig,
} from "../domain/JobConfig.js";
import type { ScrapeSession } from "../domain/Session.js";
import type { DomainCookie } from "../domain/Cookie.js";
import type { Volume } from "../domain/Volume.js";
import type {
  BrowserPort,
  BrowserHandle,
  ContextHandle,
} from "../../ports/BrowserPort.js";
import type { SessionStore } from "../../ports/SessionStore.js";
import type { EpubWriter } from "../../ports/EpubWriter.js";
import type { UIAdapter } from "../../ports/UIAdapter.js";
import type { Logger } from "../../ports/Logger.js";
import type { SiteAdapter } from "../domain/SiteAdapter.js";

const CHALLENGE_BACKOFF_MS = 45_000;
const CHECKPOINT_SAVE_INTERVAL_MS = 4_000;

// Sentinel rejection value carried by the internal abort promise so
// `cancelableDelay` can distinguish "aborted" from a real error without
// leaking the cancellation as an exception to its caller.
class CancelSymbol {
  // Marker class only - identity is what matters, never a payload.
}

export class ScrapeService {
  private abortFlag = false;
  // Resolves when cancel() is called so in-flight `cancelableDelay` awaits
  // (per-task pre-delay + retry backoffs) short-circuit immediately —
  // otherwise Ctrl+Q mid-scrape blocks on every queued task's full
  // delay/backoff before the queue drains. Drives flushOnQuit →
  // `cancelActive()` in app/tui.ts so a final checkpoint writes within
  // milliseconds instead of minutes.
  private abortPromise = new Promise<never>((_, reject) => {
    this.abortReject = reject;
  });
  private abortReject: ((e: unknown) => void) | undefined;

  constructor(
    private deps: {
      browser: BrowserPort;
      sessions: SessionStore;
      epub: EpubWriter;
      ui: UIAdapter;
      log: Logger;
      // Optional site-adapter hooks (ADR-P7-D + D5 deviation). When present,
      // forwarded to ChapterExtractor so its extract() call runs
      // adapter.collectFootnotes + adapter.processChapterContent after the
      // generic extraction (challenge wait-out, content-selector pull,
      // exclude-selector strip). Absent for site adapters that don't define
      // those hooks (WTR-Lab, NovelFire) - the generic sanitize-html path
      // keeps running. Injected via deps (not via run()) so the composition
      // root owns the adapter resolution (matching the runJob pattern for
      // every other adapter).
      siteAdapter?: Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">;
    },
  ) {}

  cancel(): void {
    this.abortFlag = true;
    // Resolve the abort promise with a sentinel rejection so any
    // `Promise.race([delay, abortPromise])` in `cancelableDelay` returns
    // immediately. The receiving `cancelableDelay` swallows this rejection so
    // callers see a clean `void` resolution, not an exception.
    if (this.abortReject) this.abortReject(new CancelSymbol());
  }

  /**
   * Delay that resolves immediately when `cancel()` fires. Used for every
   * per-task pre-delay and retry backoff in `processTask` so Ctrl+Q drops the
   * queue out within milliseconds instead of waiting `delayMax * retries`
   * (or `CHALLENGE_BACKOFF_MS * retries` for stuck-challenge backoffs). The
   * rejection from the internal abort promise is swallowed here so the
   * caller observes a normal `void` resolution.
   */
  private cancelableDelay(ms: number): Promise<void> {
    if (this.abortFlag) return Promise.resolve();
    return Promise.race<Promise<void>>([
      delay(ms),
      this.abortPromise.catch(() => {}),
    ]);
  }

  async run(
    job: JobConfig,
    cookies?: DomainCookie[],
    resume?: { session: ScrapeSession },
    // Trailing-optional `volumes?` (ADR-P7-A) forwarded to EpubWriter at
    // build time. On resume, session.volumes (if set) overrides this. When
    // undefined the existing no-volumes EPUB output path runs
    // byte-identical (regression-guarded by tests/epub-archiver.test.ts).
    volumes?: Volume[],
  ): Promise<ScrapeResult> {
    const startedAt = Date.now();
    this.abortFlag = false;
    // Reset the abort promise so a follow-up run on the same ScrapeService
    // (e.g. the TUI starting a new scrape after a Ctrl+Q'd one) gets a fresh
    // cancellation handle. The previous one is already rejected; without a
    // reset, every subsequent `cancelableDelay` would short-circuit instantly
    // because `Promise.race([delay, abortPromise.catch(() => {})])` wins on
    // the already-resolved promise immediately.
    this.abortPromise = new Promise<never>((_, reject) => {
      this.abortReject = reject;
    });

    const extractor = new ChapterExtractor(this.deps.log, this.deps.siteAdapter);
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

      // Resolve the volume map for this run. On resume, session.volumes (if
      // set) overrides the caller-supplied `volumes?` because the session
      // is the resumption checkpoint (Pipeline Phase 2 spec). On a fresh
      // run, the caller-supplied `volumes?` (from AutoScrapeResult.volumes)
      // is used. When neither is set, `undefined` flows to EpubWriter -
      // its no-volumes path is byte-identical to today (regression-guarded
      // by tests/epub-archiver.test.ts).
      const resolvedVolumes =
        resume?.session?.volumes ?? volumes ?? job.volumes ?? undefined;

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

      // Always keep a sessionRef on disk so a crash, Ctrl+Q, network drop, or
      // any mid-run interruption leaves a resumable checkpoint behind. On a
      // resume pass this is the loaded `resume.session`; on a fresh run a
      // session is created up-front so the first checkpoint write succeeds
      // even if the scrape dies during the very first chapter (otherwise the
      // maybePersist() guard below is a silent no-op and nothing is saved).
      // Entry URL mirrors the TUI's `findByEntryUrl` match key: the TOC URL
      // for toc-method jobs, the first chapter URL for sequential, otherwise
      // the first discovered URL. Fields that already exist on `resume.session`
      // (completedChapters/errors/updated) are *carried over* unchanged on
      // resume; the fresh-run branch is the only one that constructs a new
      // object from scratch.
      const sessionRef: ScrapeSession =
        resume?.session ??
        (await (async () => {
          const derivedEntryUrl =
            job.tocUrl ||
            job.firstChapterUrl ||
            (urls.length > 0 ? urls[0] : "");
          const derivedDomain = (() => {
            try {
              return derivedEntryUrl
                ? new URL(derivedEntryUrl).hostname.replace(/^www\./i, "")
                : "";
            } catch {
              return "";
            }
          })();
          const nowIso = new Date().toISOString();
          const fresh: ScrapeSession = {
            id: crypto.randomUUID(),
            status: "in-progress",
            createdAt: nowIso,
            updatedAt: nowIso,
            domain: derivedDomain,
            entryUrl: derivedEntryUrl,
            novelTitle: job.metadata.title,
            config: job as unknown as ScraperConfig,
            chapterUrls: urls,
            completedChapters: [],
            errors: [],
            ...(job.volumes ? { volumes: job.volumes } : {}),
          };
          return fresh;
        })());

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

        this.deps.ui.emit({
          type: "chapter.start",
          index: task.index + 1,
          url: task.url,
        });

        try {
          await this.cancelableDelay(randomInt(job.delayMin, job.delayMax));

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
              await this.cancelableDelay(backoff);
              // Fire-and-forget the retry re-queue. Awaiting the recursive
              // `queue.add` here holds the original concurrency slot for the
              // full retry delay + retry attempt - with concurrency 1 that
              // freezes every other queued chapter for minutes (sticky
              // challenge = up to 3×45s of dead time per retry), so the user
              // sees the scrape "pause without skipping or retrying". A
              // re-queued task is still tracked by p-queue (`size`/`pending`
              // reflect it), so `queue.onIdle()` in the run path correctly
              // awaits every scheduled retry before resolving.
              void queue.add(() => processTask(task));
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
            await this.cancelableDelay(backoff);
            // Same fire-and-forget rationale as the null-content branch
            // above: don't hold the concurrency slot across the retry.
            void queue.add(() => processTask(task));
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
          resolvedVolumes,
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
