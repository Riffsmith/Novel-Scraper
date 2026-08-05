// ─────────────────────────────────────────────────────────────────────────────
//  SettingsScreen - port of v1 tui/configManager.ts (readme §1.2).
//
//  Two sub-flows: global settings (AppConfig) and site profiles
//  (SiteProfile[]). Config is read/written via `ConfigStore` port (Phase 2),
//  not `readConfig()` - the screen writes back through `write()` and reset()
//  (ADR-P3-D). Site profiles go through `ProfileStore` port (Phase 2).
//
//  `promptSaveProfile` is a Phase 4 deliverable: not ported here.
//  `formatLocator` is already in core/services/SelectorService.ts (Phase 1);
//  imported from there, not from v1's scraper/selectors.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import * as fmt from "../format.js";
import { formatLocator } from "../../../core/services/SelectorService.js";
import { DEFAULT_CONFIG, type AppConfig } from "../../../core/domain/AppConfig.js";
import type { SiteProfile } from "../../../ports/ProfileStore.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";
import type { NextLocator } from "../../../core/domain/Locator.js";

export class SettingsScreen implements Screen {
  readonly id = "settings";

  async render(ctx: ShellContext): Promise<ScreenResult> {
    while (true) {
      const choice = await ctx.prompt.select<"global" | "profiles" | "back">({
        message: "What would you like to configure?",
        options: [
          { value: "global", label: "Global settings - browser behaviour, delays, and metadata defaults" },
          { value: "profiles", label: "Site profiles - saved per-domain extraction presets" },
          { value: "back", label: "Back" },
        ],
      });
      if (choice === Cancel || choice === "back") return { action: "pop" };
      if (choice === "global") await this.editGlobalSettings(ctx);
      if (choice === "profiles") await this.manageSiteProfiles(ctx);
    }
  }

  // ── A) Global settings ─────────────────────────────────────────────────
  private async editGlobalSettings(ctx: ShellContext): Promise<void> {
    const cfg = await ctx.config.read();
    this.printConfig(ctx, cfg);

    while (true) {
      type Group = "output" | "browser" | "perf" | "metadata" | "ux" | "reset" | "back";
      const group = await ctx.prompt.select<Group>({
        message: "Which group of settings do you want to edit?",
        options: [
          { value: "output", label: "Output - where finished EPUBs are saved" },
          { value: "browser", label: "Browser and navigation - headless, wait strategy, timeouts" },
          { value: "perf", label: "Performance and stealth - concurrency, delays, humanize" },
          { value: "metadata", label: "Metadata defaults - language, author, publisher" },
          { value: "ux", label: "Interface behaviour - profile prompts, log verbosity" },
          { value: "reset", label: "Reset all settings to their built-in defaults" },
          { value: "back", label: "Back" },
        ],
      });
      if (group === Cancel || group === "back") return;

      if (group === "reset") {
        const ok = await ctx.prompt.confirm({
          message: "Reset all settings to their built-in defaults? This cannot be undone.",
          initial: false,
        });
        if (ok === Cancel || ok === false) continue;
        await ctx.config.reset();
        ctx.prompt.log("success", "Settings reset to defaults");
        return;
      }

      const latest = await ctx.config.read();
      const updates = await this.editGroup(ctx, group, latest);
      if (updates && Object.keys(updates).length > 0) {
        await ctx.config.write(updates);
        ctx.prompt.log("success", "Settings saved");
        this.printConfig(ctx, await ctx.config.read());
      }
    }
  }

  private async editGroup(
    ctx: ShellContext,
    group: string,
    cfg: AppConfig,
  ): Promise<Partial<AppConfig> | null> {
    if (group === "output") {
      const r = await ctx.prompt.text({
        message: "Default output directory:",
        initial: cfg.defaultOutputDir,
      });
      if (r === Cancel) return null;
      return { defaultOutputDir: r.trim() || cfg.defaultOutputDir };
    }

    if (group === "browser") {
      const headless = await ctx.prompt.confirm({
        message: "Run the browser in headless mode? (false to watch)",
        initial: cfg.headless,
      });
      if (headless === Cancel) return null;

      const waitUntil = await ctx.prompt.select<AppConfig["waitUntil"]>({
        message: "Wait for this event before extracting content:",
        options: [
          { value: "domcontentloaded", label: "domcontentloaded - fastest, works for most static / SSR sites" },
          { value: "load", label: "load - waits for all sub-resources" },
          { value: "networkidle", label: "networkidle - waits until network settles; best for heavy JS / SPA sites" },
        ],
        initial: cfg.waitUntil,
      });
      if (waitUntil === Cancel) return null;

      const navTimeoutStr = await ctx.prompt.text({
        message: "Navigation timeout in milliseconds:",
        initial: String(cfg.navigationTimeoutMs),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 5_000) || "Must be at least 5000 ms";
        },
      });
      if (navTimeoutStr === Cancel) return null;

      const humanize = await ctx.prompt.confirm({
        message: "Humanize mouse, keyboard, and scroll behaviour? (slower, less detectable)",
        initial: cfg.humanize,
      });
      if (humanize === Cancel) return null;

      const humanPreset = await ctx.prompt.select<AppConfig["humanPreset"]>({
        message: "Human behaviour preset:",
        options: [
          { value: "default", label: "default - normal speed, natural movement" },
          { value: "careful", label: "careful - slower and more deliberate" },
        ],
        initial: cfg.humanPreset,
      });
      if (humanPreset === Cancel) return null;

      const seedStr = await ctx.prompt.text({
        message: "Fingerprint seed (an integer for a fixed identity, or blank for random):",
        initial: cfg.fingerprintSeed !== null ? String(cfg.fingerprintSeed) : "",
        validate: (v: string) => {
          if (v.trim() === "") return true;
          const n = parseInt(v.trim(), 10);
          return (!isNaN(n) && n > 0) || "Must be a positive integer or blank";
        },
      });
      if (seedStr === Cancel) return null;

      return {
        headless,
        waitUntil,
        navigationTimeoutMs: parseInt(navTimeoutStr, 10),
        humanize,
        humanPreset,
        fingerprintSeed: seedStr.trim() ? parseInt(seedStr.trim(), 10) : null,
      };
    }

    if (group === "perf") {
      const concurrencyStr = await ctx.prompt.text({
        message: "Default concurrent browser pages (1 to 5):",
        initial: String(cfg.defaultConcurrency),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 1 && n <= 5) || "Must be between 1 and 5";
        },
      });
      if (concurrencyStr === Cancel) return null;

      const delayRange = await ctx.prompt.text({
        message: "Default delay range between requests, in milliseconds (min-max):",
        initial: `${cfg.defaultDelayMin}-${cfg.defaultDelayMax}`,
        validate: (v: string) => {
          const [a, b] = v.split("-").map(Number);
          return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || "Format: min-max";
        },
      });
      if (delayRange === Cancel) return null;

      const retriesStr = await ctx.prompt.text({
        message: "Maximum retries for a chapter that fails to scrape:",
        initial: String(cfg.maxRetries),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 0 && n <= 10) || "Must be between 0 and 10";
        },
      });
      if (retriesStr === Cancel) return null;

      const [min, max] = delayRange.split("-").map(Number);
      return {
        defaultConcurrency: parseInt(concurrencyStr, 10),
        defaultDelayMin: min,
        defaultDelayMax: max,
        maxRetries: parseInt(retriesStr, 10),
      };
    }

    if (group === "metadata") {
      const language = await ctx.prompt.text({
        message: "Default language (ISO 639-1 code, e.g. en):",
        initial: cfg.defaultLanguage,
      });
      if (language === Cancel) return null;
      const author = await ctx.prompt.text({
        message: "Default author name (used when a site does not report one):",
        initial: cfg.defaultAuthor,
      });
      if (author === Cancel) return null;
      const publisher = await ctx.prompt.text({
        message: "Default publisher or source label:",
        initial: cfg.defaultPublisher,
      });
      if (publisher === Cancel) return null;
      return {
        defaultLanguage: language.trim() || cfg.defaultLanguage,
        defaultAuthor: author.trim() || cfg.defaultAuthor,
        defaultPublisher: publisher.trim() || cfg.defaultPublisher,
      };
    }

    if (group === "ux") {
      const askSaveProfile = await ctx.prompt.confirm({
        message:
          "After scraping a new domain, offer to save its extraction settings as a reusable profile?",
        initial: cfg.askSaveProfile,
      });
      if (askSaveProfile === Cancel) return null;
      const logLevel = await ctx.prompt.select<AppConfig["logLevel"]>({
        message: "Console log verbosity:",
        options: [
          { value: "error", label: "error" },
          { value: "warn", label: "warn" },
          { value: "info", label: "info" },
          { value: "debug", label: "debug" },
        ],
        initial: cfg.logLevel,
      });
      if (logLevel === Cancel) return null;
      return { askSaveProfile, logLevel };
    }

    return {};
  }

  private printConfig(ctx: ShellContext, cfg: AppConfig): void {
    const def = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const cur = cfg as unknown as Record<string, unknown>;
    const rows: [string, string, boolean][] = [
      ["defaultOutputDir", cur.defaultOutputDir as string, true],
      ["defaultConcurrency", String(cur.defaultConcurrency), true],
      ["defaultDelayMin/Max", `${cur.defaultDelayMin}-${cur.defaultDelayMax} ms`, true],
      ["headless", String(cur.headless), true],
      ["waitUntil", cur.waitUntil as string, true],
      ["navigationTimeoutMs", `${cur.navigationTimeoutMs} ms`, true],
      ["humanize", String(cur.humanize), true],
      ["humanPreset", cur.humanPreset as string, true],
      ["fingerprintSeed", cur.fingerprintSeed !== null ? String(cur.fingerprintSeed) : "random", true],
      ["maxRetries", String(cur.maxRetries), true],
      ["defaultLanguage", cur.defaultLanguage as string, true],
      ["defaultAuthor", cur.defaultAuthor as string, true],
      ["defaultPublisher", cur.defaultPublisher as string, true],
      ["logLevel", cur.logLevel as string, true],
      ["askSaveProfile", String(cur.askSaveProfile), true],
    ];
    ctx.prompt.log("info", fmt.section("Global Settings"));
    for (const [key, val] of rows) {
      const isDefault = String(val) === String(def[key] ?? "");
      const label = isDefault ? val : `${val} *`;
      ctx.prompt.log(isDefault ? "dim" : "warn", `${key.padEnd(24)} ${label}`);
    }
    ctx.prompt.log("dim", "(* marks a value that differs from the built-in default)");
  }

  // ── B) Site profiles ────────────────────────────────────────────────────
  private async manageSiteProfiles(ctx: ShellContext): Promise<void> {
    while (true) {
      const all = await ctx.profiles.list();
      const domains = Object.keys(all).sort();

      const options = [
        ...domains.map((d) => {
          const p = all[d];
          const method = p.method === "toc" ? "toc" : "seq";
          return { value: `profile:${d}`, label: `${d.padEnd(32)} [${method}]  ${p.label ?? ""}` };
        }),
        { value: "__back__", label: "Back" },
      ];
      const message =
        domains.length > 0
          ? "Select a profile to view or edit:"
          : "No site profiles saved yet. They are created automatically after a scrape completes.";
      const choice = await ctx.prompt.select<string>({ message, options });
      if (choice === Cancel || choice === "__back__") return;
      if (choice.startsWith("profile:")) {
        const domain = choice.slice("profile:".length);
        await this.editSiteProfile(ctx, domain);
        continue;
      }
      ctx.prompt.log("warn", `Unknown choice: ${choice}`);
    }
  }

  private async editSiteProfile(ctx: ShellContext, domain: string): Promise<void> {
    const profile = (await ctx.profiles.list())[domain] as SiteProfile | undefined;
    if (!profile) {
      ctx.prompt.log("error", `Profile for ${domain} not found`);
      return;
    }
    this.printProfile(ctx, profile);

    while (true) {
      type Action = "edit_label" | "edit_selectors" | "edit_perf" | "delete" | "back";
      const action = await ctx.prompt.select<Action>({
        message: `Manage profile for ${domain}:`,
        options: [
          { value: "edit_label", label: "Edit label or notes" },
          { value: "edit_selectors", label: "Edit extraction selectors (content, title, exclusions)" },
          { value: "edit_perf", label: "Edit performance overrides for this site" },
          { value: "delete", label: "Delete this profile" },
          { value: "back", label: "Back" },
        ],
      });
      if (action === Cancel || action === "back") return;

      if (action === "edit_label") {
        const label = await ctx.prompt.text({
          message: "Human-friendly label:",
          initial: profile.label ?? "",
        });
        if (label === Cancel) continue;
        const notes = await ctx.prompt.text({
          message: "Notes (optional):",
          initial: profile.notes ?? "",
        });
        if (notes === Cancel) continue;
        profile.label = label.trim() || undefined;
        profile.notes = notes.trim() || undefined;
        await ctx.profiles.save(domain, profile);
        ctx.prompt.log("success", "Profile updated");
        this.printProfile(ctx, profile);
      }

      if (action === "edit_selectors") {
        const contentSelector = await ctx.prompt.text({
          message: "Content selector (CSS or XPath):",
          initial: profile.contentSelector,
          validate: (v: string) => v.trim().length > 0 || "Cannot be empty",
        });
        if (contentSelector === Cancel) continue;
        const separateTitle = await ctx.prompt.confirm({
          message: "Extract the chapter title from a separate element?",
          initial: profile.separateTitle,
        });
        if (separateTitle === Cancel) continue;
        const titleSelector = await ctx.prompt.text({
          message: "Title selector (leave blank to clear):",
          initial: profile.titleSelector ?? "",
        });
        if (titleSelector === Cancel) continue;
        const exclusionList = await ctx.prompt.text({
          message: "Selectors to exclude, comma-separated (blank = none):",
          initial: profile.excludeSelectors.join(", "),
        });
        if (exclusionList === Cancel) continue;

        profile.contentSelector = contentSelector.trim();
        profile.separateTitle = separateTitle;
        profile.titleSelector = titleSelector.trim() || undefined;
        profile.excludeSelectors = exclusionList
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        await ctx.profiles.save(domain, profile);
        ctx.prompt.log("success", "Profile updated");
        this.printProfile(ctx, profile);
      }

      if (action === "edit_perf") {
        const concurrency = await ctx.prompt.text({
          message: "Concurrency for this site (1-5, blank = global default):",
          initial: profile.concurrency != null ? String(profile.concurrency) : "",
          validate: (v: string) => {
            if (!v.trim()) return true;
            const n = parseInt(v, 10);
            return (!isNaN(n) && n >= 1 && n <= 5) || "Must be between 1 and 5";
          },
        });
        if (concurrency === Cancel) continue;
        const delayRange = await ctx.prompt.text({
          message: "Delay range for this site (min-max ms, blank = global default):",
          initial:
            profile.delayMin != null ? `${profile.delayMin}-${profile.delayMax}` : "",
          validate: (v: string) => {
            if (!v.trim()) return true;
            const [a, b] = v.split("-").map(Number);
            return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || "Format: min-max";
          },
        });
        if (delayRange === Cancel) continue;

        profile.concurrency = concurrency.trim()
          ? parseInt(concurrency, 10)
          : undefined;
        if (delayRange.trim()) {
          const [mn, mx] = delayRange.split("-").map(Number);
          profile.delayMin = mn;
          profile.delayMax = mx;
        } else {
          profile.delayMin = undefined;
          profile.delayMax = undefined;
        }
        await ctx.profiles.save(domain, profile);
        ctx.prompt.log("success", "Profile updated");
      }

      if (action === "delete") {
        const ok = await ctx.prompt.confirm({
          message: `Delete profile for ${domain}? This cannot be undone.`,
          initial: false,
        });
        if (ok === Cancel || ok === false) continue;
        const removed = await ctx.profiles.delete(domain);
        if (removed) ctx.prompt.log("success", `Profile for ${domain} deleted`);
        return;
      }
    }
  }

  private printProfile(ctx: ShellContext, p: SiteProfile): void {
    ctx.prompt.log("info", "");
    const row = (k: string, v: string) => ctx.prompt.log("info", `${k.padEnd(22)} ${v}`);
    row("Domain", p.domain);
    if (p.label) row("Label", p.label);
    row("Method", p.method);
    row("Content", p.contentSelector);
    row("Sep.title", String(p.separateTitle));
    if (p.titleSelector) row("Title sel.", p.titleSelector);
    if (p.excludeSelectors.length) row("Exclude", p.excludeSelectors.join(", "));
    if (p.nextButtonLocators?.length) {
      p.nextButtonLocators.forEach((l: NextLocator, i: number) => {
        row(i === 0 ? "Next (primary)" : `Next (fallback ${i})`, formatLocator(l));
      });
    }
    if (p.concurrency != null) row("Concurrency", String(p.concurrency));
    if (p.delayMin != null) row("Delay", `${p.delayMin}-${p.delayMax} ms`);
    if (p.notes) row("Notes", p.notes);
    row("Saved", p.savedAt.slice(0, 10));
    row("Updated", p.updatedAt.slice(0, 10));
  }
}
