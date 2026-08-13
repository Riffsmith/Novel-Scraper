// ─────────────────────────────────────────────────────────────────────────────
//  TaskScreen - live progress + cancel + summary tail (readme §2.7).
//
//  A thin *renderer* over `ScrapeService.run`. ScrapeService owns browser
//  lifecycle + context pool + checkpoints + EPUB + session deletion; the
//  TaskScreen:
//    - resolves cookies for the scrape domain (resolveCookiesForScrape)
//    - starts a task on ctx.tasks with the total chapterUrls length
//    - wires a UIAdapter (ClackUIAdapter behind ctx.prompt) so each
//      `chapter.done`/`checkpoint.saved` ScrapeEvent bumps the task progress
//      and the screen's renderable progress line
//    - runs ScrapeService.run with the resume session (if any)
//    - logs the post-scrape summary card + failed chapter list
//    - calls `maybeSaveProfile` at the tail when domain/new-domain/askSaveProfile
//    - resets the registry and pops
//
//  The `q`-quit-during-scrape key is handled by the Shell's existing Ctrl+Q
//  listener (readme §2.7); the Shell's `flushOnQuit` (wired in app/tui.ts)
//  awaits `tasks.cancelActive()` -> `ScrapeService.cancel()` so a final
//  checkpoint lands before `browser.closeAll()`.
// ─────────────────────────────────────────────────────────────────────────────

import * as fmt from "../format.js";
import { maybeSaveProfile, resolveCookiesForScrape } from "../scope.js";
import { ScrapeService } from "../../../core/services/ScrapeService.js";
import { ArchiverEpubWriter } from "../../epub-archiver/ArchiverEpubWriter.js";
import { ClackUIAdapter } from "../ClackUIAdapter.js";
import { JsonSessionStore } from "../../store-json/JsonSessionStore.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type {
  JobConfig,
  ScrapeResult,
} from "../../../core/domain/JobConfig.js";
import type { DomainCookie } from "../../../core/domain/Cookie.js";
import type { ScrapeSession } from "../../../core/domain/Session.js";
import type { SiteAdapter } from "../../../core/domain/SiteAdapter.js";
import type { LiveTaskRegistry, ScrapeTask } from "../TaskRegistry.js";

export interface TaskScreenParams {
  job: JobConfig;
  chapterUrls: string[];
  resumeSession?: ScrapeSession;
  domain?: string;
  isNewDomain?: boolean;
  /** Already-resolved cookies for the domain (manual flow passes them from
   * discovery; auto flow passes them from the probe context). Resume leaves
   * this undefined and TaskScreen resolves afresh - mirroring v1. */
  cookies?: DomainCookie[];
  /** Optional site adapter (Pipeline Phase 1 / 4) so ScrapeService can wire
   * `processChapterContent` + `collectFootnotes` into ChapterExtractor. The
   * auto flow (AutoProbeScreen -> AutoCustomizeScreen -> TaskScreen)
   * carries the matched adapter straight through; the manual flow leaves
   * this unset and the generic `sanitize-html` path keeps running. */
  siteAdapter?: Pick<SiteAdapter, "processChapterContent" | "collectFootnotes">;
}

export class TaskScreen implements Screen {
  readonly id = "task";

  async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
    const sp = params as TaskScreenParams;
    const appCfg = await ctx.config.read();
    const job = { ...sp.job, chapterLinks: sp.chapterUrls };
    const domain = sp.domain ?? "";
    const isNewDomain = sp.isNewDomain ?? false;

    let cookies: DomainCookie[] = sp.cookies ?? [];
    if (!sp.cookies && domain) {
      cookies = await resolveCookiesForScrape(ctx.prompt, ctx.cookies, domain);
    }

    // The live registry + task start. ctx.tasks is a LiveTaskRegistry at the
    // composition root; check before casting so tests can stub it.
    const registry = ctx.tasks as unknown as LiveTaskRegistry;
    const startMs = Date.now();
    const titleForTask = job.metadata.title || "Untitled";

    // ScrapeService with the cancelled-by-user bridge: cancel() flips
    // ScrapeService's abort flag; the service's finally path then writes the
    // final checkpoint via its sessions.save (if a session is in flight).
    const sessions = new JsonSessionStore(ctx.log);
    const epub = new ArchiverEpubWriter(ctx.log);
    const ui = new ClackUIAdapter(ctx.prompt);
    const scrapeService = new ScrapeService({
      browser: ctx.browser,
      sessions,
      epub,
      ui,
      log: ctx.log,
      siteAdapter: sp.siteAdapter,
    });

    const total = sp.chapterUrls.length;
    const spin = ctx.prompt.spinner();
    let done = sp.resumeSession?.completedChapters.length ?? 0;
    let task: ScrapeTask | undefined;
    if (typeof registry.start === "function") {
      task = registry.start({
        id: sp.resumeSession?.id ?? crypto.randomUUID(),
        title: titleForTask,
        total,
        onCancel: async () => {
          scrapeService.cancel();
        },
      });
    }
    // Chapter status drives the spinner's live in-place message instead of
    // scrolling the log region: chapter.start shows the current chapter (only
    // once), chapter.done bumps the bar + shows the just-finished title,
    // chapter.retry / challenge.waiting surface the in-flight retry as a
    // brief status line that the next event overwrites in place. Warnings and
    // one-time milestones (chapter.failed, discovery.done, epub.*) keep their
    // existing persistent clack log lines via ClackUIAdapter.emit; those are
    // not duplicated here.
    ui.onEvent((e) => {
      if (e.type === "chapter.start") {
        spin.message?.(
          `${fmt.taskBar(done, total)}  Scraping ch.${e.index}/${total}…`,
        );
      } else if (e.type === "chapter.done") {
        done++;
        if (typeof registry.publishProgress === "function")
          registry.publishProgress(done);
        spin.message?.(`${fmt.taskBar(done, total)}  ${e.title}`);
      } else if (e.type === "chapter.retry") {
        spin.message?.(
          `${fmt.taskBar(done, total)}  Retry ch.${e.index} (${e.attempt}/${e.max}${e.challenge ? ", challenge" : ""})…`,
        );
      } else if (e.type === "challenge.waiting") {
        spin.message?.(
          `${fmt.taskBar(done, total)}  Waiting out anti-bot challenge on ch.${e.url}…`,
        );
      } else if (e.type === "discovery.progress") {
        spin.message?.(
          `Discovering chapters… ${e.found} found across ${e.pages} pages`,
        );
      } else if (e.type === "epub.started") {
        spin.message?.(`${fmt.taskBar(done, total)}  Packaging EPUB…`);
      }
    });

    ctx.prompt.log("info", fmt.section("Scraping Chapters"));
    ctx.prompt.log(
      "dim",
      "Press Ctrl+Q at any time to stop and save progress for later.",
    );
    spin.start(`${fmt.taskBar(done, total)}  Starting…`);

    let result: ScrapeResult;
    try {
      result = await scrapeService.run(
        job,
        cookies,
        sp.resumeSession ? { session: sp.resumeSession } : undefined,
        job.volumes,
      );
    } catch (e) {
      spin.fail(`Scrape failed: ${(e as Error).message}`);
      if (task) task.status = "failed";
      if (typeof registry.reset === "function") registry.reset();
      await ctx.prompt
        .text({ message: "Press Enter to return..." })
        .catch(() => {});
      return { action: "pop" };
    }
    spin.succeed(`Scraped ${result.chapters.length}/${total} chapters`);
    if (typeof registry.finish === "function") registry.finish();

    if (result.chapters.length === 0 && result.errors.length === 0) {
      ctx.prompt.log("error", "No chapters were scraped successfully.");
      ctx.prompt.log(
        "dim",
        `Double-check the content selector - it did not match anything: "${job.contentSelector}"`,
      );
      if (typeof registry.reset === "function") registry.reset();
      await ctx.prompt
        .text({ message: "Press Enter to return..." })
        .catch(() => {});
      return { action: "pop" };
    }

    if (result.errors.length > 0) {
      ctx.prompt.log(
        "warn",
        `${result.errors.length} chapter(s) could not be scraped:`,
      );
      for (const err of result.errors) {
        ctx.prompt.log("dim", `  ${err.url}  ->  ${err.error}`);
      }
    }

    ctx.prompt.log(
      "info",
      fmt.summaryCard({
        title: job.metadata.title,
        chapters: result.chapters.length,
        words: result.totalWords,
        timeMs: Date.now() - startMs,
        output: job.outputDir + "/" + job.outputFilename,
        errors: result.errors.length,
      }),
    );

    if (result.chapters.length > 0) {
      await maybeSaveProfile(
        ctx.prompt,
        ctx.profiles,
        domain,
        isNewDomain,
        appCfg,
        job,
      );
    }

    if (typeof registry.reset === "function") registry.reset();
    await ctx.prompt
      .text({ message: "Press Enter to return..." })
      .catch(() => {});
    return { action: "pop" };
  }
}
