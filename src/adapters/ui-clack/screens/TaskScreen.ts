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
    // Chapter completions and discovery progress drive the spinner's live
    // message instead of scrolling the log - the chapter name is visible
    // only for as long as it's the most-recently-completed one, then the
    // next update overwrites it in place.
    ui.onEvent((e) => {
      if (e.type === "chapter.done") {
        done++;
        if (typeof registry.publishProgress === "function")
          registry.publishProgress(done);
        spin.message?.(`${fmt.taskBar(done, total)}  ${e.title}`);
      } else if (e.type === "discovery.progress") {
        spin.message?.(
          `Discovering chapters… ${e.found} found across ${e.pages} pages`,
        );
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
