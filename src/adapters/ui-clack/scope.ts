// ─────────────────────────────────────────────────────────────────────────────
//  scope - small pure + adapter-local scrape-orchestration helpers used by
//  the Phase 4 TaskScreen and the Auto probe (readme §2.1 / §2.9).
//
//  Two groups:
//    - launchOptionsForScrape: reads AppConfig + JobConfig into a
//      BrowserLaunchOpts (ADR-P4-C). Lives adapter-side because the
//      composition root assembles the actual opts; this is the pure read,
//      not the launch.
//    - resolveCookiesForScrape: the read-only 0/1/N cookie picker
//      (readme §2.9 / v1 cookieManager.ts selectCookieProfileForScrape).
//    - maybeSaveProfile: post-scrape "save extraction settings as a profile"
//      prompt (v1 configManager.ts promptSaveProfile). Only fires when
//      domain && isNewDomain && appCfg.askSaveProfile. Builds a partial
//      profile with the v1 "differs from global default" perf cutoff so the
//      site-profile store stays minimal.
//
//  No domain logic beyond the v1 parity surface; these are presentation +
//  reading-from-ports + writing-to-a-port, never the engine.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel, type PromptProvider } from "./PromptProvider.js";
import { profileMetaLine } from "./format.js";
import type { AppConfig } from "../../core/domain/AppConfig.js";
import type { DomainCookie, StoredCookie } from "../../core/domain/Cookie.js";
import type { JobConfig, ScraperConfig } from "../../core/domain/JobConfig.js";
import type { BrowserLaunchOpts } from "../../ports/BrowserPort.js";
import type { CookieStore } from "../../ports/CookieStore.js";
import type { ProfileStore, SiteProfile } from "../../ports/ProfileStore.js";

/** Build launch opts from AppConfig + JobConfig (ADR-P4-C). Honors user
 * humanize / humanPreset / fingerprintSeed / maxRetries plus JobConfig.headless. */
export function launchOptionsForScrape(appCfg: AppConfig, job: JobConfig): BrowserLaunchOpts {
  return {
    headless: job.headless,
    humanize: appCfg.humanize,
    humanPreset: appCfg.humanPreset,
    fingerprintSeed: appCfg.fingerprintSeed,
    timezone: "America/New_York",
    locale: appCfg.defaultLanguage === "en" ? "en-US" : appCfg.defaultLanguage,
  };
}

/** The locale resolution used at every bootstrap point (v1 index.ts:355). */
export function localeFor(appCfg: AppConfig): string {
  return appCfg.defaultLanguage === "en" ? "en-US" : appCfg.defaultLanguage;
}

/**
 * resolveCookiesForScrape - 0/1/N cookie picker, read-only port of v1's
 * selectCookieProfileForScrape (cookieManager.ts:712-753).
 *  - 0 profiles -> none.
 *  - 1 profile  -> auto-load + markUsed.
 *  - N profiles -> picker with cookie counts + lastUsed; "Don't use any" -> none.
 * Cancel at any prompt returns []. The caller treats cookies as best-effort.
 */
export async function resolveCookiesForScrape(
  prompt: PromptProvider,
  cookies: CookieStore,
  domain: string,
): Promise<DomainCookie[]> {
  const profiles = await cookies.listProfiles(domain);
  if (profiles.length === 0) {
    prompt.log("dim", `No stored cookies for ${domain}`);
    return [];
  }

  if (profiles.length === 1) {
    const only = profiles[0];
    const loaded = await cookies.load(domain, only);
    await cookies.markUsed(domain, only);
    if (loaded && loaded.length > 0) {
      prompt.log(
        "success",
        `Loaded ${loaded.length} saved cookie(s) - profile "${only}" for ${domain}`,
      );
    }
    return loaded ?? [];
  }

  const options = await Promise.all(
    profiles.map(async (name) => {
      const s = await cookies.describeProfile(domain, name);
      return { value: name, label: s ? profileMetaLine(s, name) : name };
    }),
  );
  options.push({ value: "__none__", label: "Don't use any saved cookies" });
  const picked = await prompt.select<string>({
    message: `Multiple saved cookie profiles found for ${domain} - which one?`,
    options,
  });
  if (picked === Cancel) return [];
  if (picked === "__none__") return [];
  const loaded = await cookies.load(domain, picked);
  await cookies.markUsed(domain, picked);
  if (loaded && loaded.length > 0) {
    prompt.log("success", `Loaded ${loaded.length} saved cookie(s) - profile "${picked}"`);
  }
  return loaded ?? [];
}

/**
 * Save the freshly-loaded cookies for a probing context (auto probe). v1
 * loads cookies once and applies them to the probe context; v2 has the
 * adapter caller inject the same DomainCookie[]. The store side has nothing
 * seed-special going on; the cookie resolver below is its only producer.
 */
export function transformStoredToDomain(stored: StoredCookie[], domain: string): DomainCookie[] {
  return stored.map((c) => ({ ...c, domain }));
}

/**
 * maybeSaveProfile - post-scrape save-profile prompt (v1
 * configManager.ts:654-698). Honors `appCfg.askSaveProfile && isNewDomain`
 * exactly; on "yes" reads an optional label and persists a partial profile
 * with the v1 "differs from global default" perf cutoff (concurrency /
 * delayMin / delayMax are omitted when equal to the global defaults).
 */
export async function maybeSaveProfile(
  prompt: PromptProvider,
  profiles: ProfileStore,
  domain: string,
  isNewDomain: boolean,
  appCfg: AppConfig,
  config: ScraperConfig,
): Promise<void> {
  if (!domain || !isNewDomain || !appCfg.askSaveProfile) return;

  prompt.log("info", `This is the first time this project has scraped ${domain}.`);
  prompt.log(
    "dim",
    "Saving these extraction settings as a profile means the same selectors, exclusions, and performance settings will be pre-filled automatically the next time you scrape a novel from this domain.",
  );

  const save = await prompt.confirm({
    message: `Save extraction settings for ${domain} as a reusable profile?`,
    initial: true,
  });
  if (save === Cancel || save === false) return;

  const label = await prompt.text({
    message: "Short label for this site (optional):",
    hint: "e.g.  Royal Road  |  WebNovel.com  |  ScribbleHub",
  });
  if (label === Cancel) return;

  const now = new Date().toISOString();
  const profile: SiteProfile = {
    domain,
    label: label.trim() || undefined,
    method: config.method,
    contentSelector: config.contentSelector,
    separateTitle: config.separateTitle,
    titleSelector: config.titleSelector,
    excludeSelectors: config.excludeSelectors,
    nextButtonLocators: config.nextButtonLocators,
    concurrency: config.concurrency !== appCfg.defaultConcurrency ? config.concurrency : undefined,
    delayMin: config.delayMin !== appCfg.defaultDelayMin ? config.delayMin : undefined,
    delayMax: config.delayMax !== appCfg.defaultDelayMax ? config.delayMax : undefined,
    savedAt: now,
    updatedAt: now,
  };
  await profiles.save(domain, profile);
  prompt.log(
    "success",
    `Profile saved - selectors and settings will be pre-filled automatically next time you scrape ${domain}`,
  );
}
