// ─────────────────────────────────────────────────────────────────────────────
//  NewScrapeScreen - the Auto vs Manual + entry-URL + resume-offer screen
//  (readme §2.3).
//
//  Pushed by MainScreen's "Start a new scrape". Captures the entry URL up
//  front (used for profile lookup, resume-offer matching, and domain
//  derivation - readme §1.1), offers to resume a matching in-progress
//  session if one exists, else routes to ManualWizardScreen or
//  AutoProbeScreen with `{ entryUrl, domain, profile, isNewDomain }` params.
//
//  Cancellation at any prompt returns `{ action: "pop" }` (back to main),
//  respecting ADR-P3-H. The screen returns `{ action: "replace", screen: <chosen> }`
//  so MainScreen stays "under" the stack and a single pop from the wizard
//  returns to Main (not to this screen) - matching v1's startScrape /
//  startAutoScrape one-shot entry.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import { validateUrl, normalizeUrl } from "../validation.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { ScrapeSession } from "../../../core/domain/Session.js";
import type { SiteProfile } from "../../../ports/ProfileStore.js";

type Mode = "auto" | "manual";

export interface NewScrapeCommonParams {
  entryUrl: string;
  domain: string;
  profile: SiteProfile | null;
  isNewDomain: boolean;
}

function hostnameFrom(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export class NewScrapeScreen implements Screen {
  readonly id = "new";

  async render(ctx: ShellContext): Promise<ScreenResult> {
    const mode = await ctx.prompt.select<Mode>({
      message: "How do you want to set this scrape up?",
      options: [
        {
          value: "auto",
          label: "Auto - paste a novel URL; on a supported site this usually takes just two confirmations",
        },
        {
          value: "manual",
          label: "Manual - configure every selector and setting yourself",
        },
      ],
    });
    if (mode === Cancel) return { action: "pop" };

    const rawUrl = await ctx.prompt.text({
      message: "Entry URL:",
      hint:
        mode === "auto"
          ? "Paste the URL of the novel's main page (not the chapter list)."
          : "Either the table-of-contents page or the first chapter.",
      validate: validateUrl,
    });
    if (rawUrl === Cancel) return { action: "pop" };

    const entryUrl = normalizeUrl(rawUrl);
    const domain = hostnameFrom(entryUrl);
    const profile = domain ? await ctx.profiles.load(domain) : null;
    const isNewDomain = domain ? !profile : false;

    if (profile) {
      ctx.log.info(`Site profile matched for ${domain}`);
    }

    // §1.6 resume-offer: same seam as the v1 path's findResumableSessionByUrl.
    const existing = domain ? await ctx.sessions.findByEntryUrl(entryUrl) : null;
    if (existing) {
      ctx.prompt.log(
        "info",
        `A previous incomplete scrape was found for this URL: "${existing.novelTitle}" ` +
          `(${existing.completedChapters.length}/${existing.chapterUrls.length} chapters done).`,
      );
      const resume = await ctx.prompt.confirm({
        message: "Resume it instead of starting a new configuration?",
        initial: true,
      });
      if (resume === Cancel) return { action: "pop" };
      if (resume) {
        return { action: "replace", screen: "task", params: mkResumeParams(existing) };
      }
      const discard = await ctx.prompt.confirm({
        message: "Discard the old incomplete session so it stops being offered?",
        initial: false,
      });
      if (discard === Cancel) return { action: "pop" };
      if (discard) await ctx.sessions.delete(existing.id);
    }

    const params: NewScrapeCommonParams = { entryUrl, domain, profile, isNewDomain };
    if (mode === "auto") {
      return { action: "replace", screen: "auto-probe", params };
    }
    return { action: "replace", screen: "manual-wizard", params };
  }
}

/** Build TaskScreen params to resume a session - mirroring v1 resumeSession
 *  which uses the stored ScraperConfig + chapterUrls directly.  */
export function mkResumeParams(session: ScrapeSession): {
  job: import("../../../core/domain/JobConfig.js").JobConfig;
  chapterUrls: string[];
  resumeSession: ScrapeSession;
  domain: string;
  isNewDomain: boolean;
} {
  return {
    job: { ...session.config, output: { epub: true } },
    chapterUrls: session.chapterUrls,
    resumeSession: session,
    domain: session.domain,
    isNewDomain: false,
  };
}
