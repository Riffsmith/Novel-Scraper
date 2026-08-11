// ─────────────────────────────────────────────────────────────────────────────
//  CookieManagerScreen - port of v1 tui/cookieManager.ts (readme §1.1).
//
//  Domain -> profile -> cookie drill-down with the same six profile actions:
//  add kv, paste header, browser capture, relabel, delete one, delete profile.
//  All v1 synchronous store calls become async `CookieStore` port calls.
//
//  `parseCookieHeader` lives in core/domain/Cookie.ts (Phase 2 ADR-P2-D);
//  imported from there, not from a store adapter (readme §1.1).
// ─────────────────────────────────────────────────────────────────────────────

import { Cancel } from "../PromptProvider.js";
import * as fmt from "../format.js";
import {
  beginCapture,
  finishCapture,
  abortCapture,
  type CaptureDeps,
} from "../cookieCapture.js";
import type { StoredCookie } from "../../../core/domain/Cookie.js";
import { parseCookieHeader } from "../../../core/domain/Cookie.js";
import {
  validateDomain,
  validateProfileNameChars,
  validateUrl,
  normalizeUrl,
} from "../validation.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";

export class CookieManagerScreen implements Screen {
  readonly id = "cookies";

  async render(ctx: ShellContext): Promise<ScreenResult> {
    return this.manageDomains(ctx);
  }

  private async manageDomains(ctx: ShellContext): Promise<ScreenResult> {
    while (true) {
      const domains = await ctx.cookies.listDomains();
      // Resolve profile counts up-front for the v1 "(N cookie profile(s))" badge.
      const labelled: { value: string; label: string }[] = [
        ...(await Promise.all(
          domains.map(async (d) => {
            const profiles = await ctx.cookies.listProfiles(d);
            const plural = profiles.length === 1 ? "" : "s";
            return { value: `domain:${d}`, label: `${d}  (${profiles.length} cookie profile${plural})` };
          }),
        )),
        { value: "__add__", label: "Add cookies for a new domain" },
        { value: "__back__", label: "Back" },
      ];

      const message =
        domains.length > 0
          ? "Select a domain to manage, or add a new one:"
          : "No cookie profiles stored yet. Add some?";
      const choice = await ctx.prompt.select<string>({ message, options: labelled });
      if (choice === Cancel) return { action: "pop" };
      if (choice === "__back__") return { action: "pop" };
      if (choice === "__add__") {
        await this.addDomainFlow(ctx, null);
        continue;
      }
      if (choice.startsWith("domain:")) {
        const domain = choice.slice("domain:".length);
        const r = await this.manageDomainFlow(ctx, domain);
        if (r === "pop") return { action: "pop" };
        continue;
      }
      ctx.prompt.log("warn", `Unknown choice: ${choice}`);
      continue;
    }
  }

  private async addDomainFlow(ctx: ShellContext, prefill: string | null): Promise<void> {
    const domain = await ctx.prompt.text({
      message: "Domain (e.g. novelupdates.com):",
      initial: prefill ?? "",
      validate: validateDomain,
    });
    if (domain === Cancel) return;
    await this.manageDomainFlow(ctx, domain.trim());
  }

  private async manageDomainFlow(ctx: ShellContext, domain: string): Promise<"pop" | void> {
    while (true) {
      const profiles = await ctx.cookies.listProfiles(domain);

      // Zero-profile fast path - skip straight to "add a new profile".
      if (profiles.length === 0) {
        const added = await this.addProfileFlow(ctx, domain, []);
        if (!added) return;
        continue;
      }

      const options = [
        ...(await Promise.all(
          profiles.map(async (name) => {
            const s = await ctx.cookies.describeProfile(domain, name);
            return s
              ? { value: `profile:${name}`, label: fmt.profileMetaLine(s, name) }
              : { value: `profile:${name}`, label: name };
          }),
        )),
        { value: "__add__", label: "Add a new cookie profile" },
        { value: "__delete_all__", label: "Delete ALL profiles for this domain" },
        { value: "__back__", label: "Back" },
      ];
      const choice = await ctx.prompt.select<string>({
        message: "Select a profile to manage:",
        options,
      });
      if (choice === Cancel || choice === "__back__") return;

      if (choice === "__add__") {
        await this.addProfileFlow(ctx, domain, profiles);
        continue;
      }
      if (choice === "__delete_all__") {
        const ok = await ctx.prompt.confirm({
          message: `Delete all ${profiles.length} cookie profile(s) for ${domain}? This cannot be undone.`,
          initial: false,
        });
        if (ok === Cancel || ok === false) continue;
        const removed = await ctx.cookies.deleteDomain(domain);
        if (removed) ctx.prompt.log("success", `All cookie profiles for ${domain} deleted`);
        return;
      }
      if (choice.startsWith("profile:")) {
        const name = choice.slice("profile:".length);
        await this.manageProfileFlow(ctx, domain, name);
        continue;
      }
      ctx.prompt.log("warn", `Unknown choice: ${choice}`);
      continue;
    }
  }

  private async manageProfileFlow(
    ctx: ShellContext,
    domain: string,
    initialName: string,
  ): Promise<void> {
    let profileName = initialName;
    while (true) {
      const profile = await ctx.cookies.getProfile(domain, profileName);
      if (!profile) return; // deleted from elsewhere mid-session

      ctx.prompt.log("info", fmt.cookieTable(profile.cookies, domain, profileName));

      type Action =
        | "add_kv"
        | "add_header"
        | "capture"
        | "relabel"
        | "delete_one"
        | "delete_profile"
        | "back";
      const action = await ctx.prompt.select<Action>({
        message: `Manage profile "${profileName}" for ${domain}:`,
        options: [
          { value: "add_kv", label: "Add or update a cookie (enter name and value)" },
          { value: "add_header", label: "Paste a raw Cookie: header string" },
          { value: "capture", label: "Log in via browser and capture cookies (replaces this profile)" },
          { value: "relabel", label: "Rename or relabel this profile" },
          { value: "delete_one", label: "Delete a single cookie by name" },
          { value: "delete_profile", label: "Delete this profile" },
          { value: "back", label: "Back" },
        ],
      });
      if (action === Cancel || action === "back") return;

      if (action === "add_kv") {
        await this.addCookiesFlow(ctx, domain, profileName);
      } else if (action === "add_header") {
        await this.pasteHeaderFlow(ctx, domain, profileName);
      } else if (action === "capture") {
        await this.captureViaLoginFlow(ctx, domain, profileName);
      } else if (action === "relabel") {
        const renamedTo = await this.relabelFlow(ctx, domain, profileName);
        if (renamedTo) profileName = renamedTo;
      } else if (action === "delete_one") {
        if (profile.cookies.length === 0) continue;
        const picked = await ctx.prompt.select<string>({
          message: "Which cookie to delete?",
          options: profile.cookies.map((c) => ({
            value: c.name,
            label: `${c.name}  ${fmt.truncate(c.value, 40)}`,
          })),
        });
        if (picked === Cancel) continue;
        const ok = await ctx.cookies.deleteCookie(domain, profileName, picked);
        if (ok) ctx.prompt.log("success", `Deleted "${picked}"`);
        else ctx.prompt.log("warn", `"${picked}" was not found`);
      } else if (action === "delete_profile") {
        const ok = await ctx.prompt.confirm({
          message: `Delete profile "${profileName}" for ${domain}? This cannot be undone.`,
          initial: false,
        });
        if (ok === Cancel || ok === false) continue;
        await ctx.cookies.deleteProfile(domain, profileName);
        ctx.prompt.log("success", `Profile "${profileName}" deleted`);
        return;
      }
    }
  }

  private async addProfileFlow(
    ctx: ShellContext,
    domain: string,
    existingNames: string[],
  ): Promise<boolean> {
    const profileName = await this.promptProfileName(ctx, existingNames);
    if (profileName === null) return false;

    type Method = "capture" | "header" | "kv" | "cancel";
    const method = await ctx.prompt.select<Method>({
      message: `How do you want to populate profile "${profileName}"?`,
      options: [
        { value: "capture", label: "Log in via browser (recommended)" },
        { value: "header", label: "Paste a raw Cookie: header string" },
        { value: "kv", label: "Enter cookies manually (name/value pairs)" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (method === Cancel || method === "cancel") return false;

    if (method === "capture") await this.captureViaLoginFlow(ctx, domain, profileName);
    else if (method === "header") await this.pasteHeaderFlow(ctx, domain, profileName);
    else await this.addCookiesFlow(ctx, domain, profileName);

    return (await ctx.cookies.getProfile(domain, profileName)) !== null;
  }

  private async promptProfileName(
    ctx: ShellContext,
    existingNames: string[],
  ): Promise<string | null> {
    const suggestion = existingNames.length === 0 ? "default" : "";
    const name = await ctx.prompt.text({
      message: "Name for this cookie profile:",
      initial: suggestion,
      hint: "lowercase letters, numbers, _ and - only  e.g. default, alt-account",
      validate: (v: string) => {
        const charCheck = validateProfileNameChars(v);
        if (charCheck !== true) return charCheck;
        if (existingNames.includes(v.trim()))
          return `A profile named "${v.trim()}" already exists`;
        return true;
      },
    });
    if (name === Cancel) return null;
    return name.trim() || null;
  }

  private async relabelFlow(
    ctx: ShellContext,
    domain: string,
    profileName: string,
  ): Promise<string | null> {
    const profile = await ctx.cookies.getProfile(domain, profileName);
    if (!profile) return null;
    const existingNames = await ctx.cookies.listProfiles(domain);

    const newKey = await ctx.prompt.text({
      message: "Profile key (used in menus and storage):",
      initial: profileName,
      validate: (v: string) => {
        const trimmed = v.trim();
        if (trimmed === profileName) return true;
        const charCheck = validateProfileNameChars(trimmed);
        if (charCheck !== true) return charCheck;
        if (existingNames.includes(trimmed))
          return `A profile named "${trimmed}" already exists`;
        return true;
      },
    });
    if (newKey === Cancel) return null;

    const newLabel = await ctx.prompt.text({
      message: "Free-text label (leave blank to clear):",
      initial: profile.label ?? "",
    });
    if (newLabel === Cancel) return null;

    const trimmedKey = newKey.trim();
    const trimmedLabel = newLabel.trim() || undefined;

    if (trimmedKey !== profileName) {
      const renamed = await ctx.cookies.renameProfile(domain, profileName, trimmedKey);
      if (!renamed) {
        ctx.prompt.log("error", `Could not rename to "${trimmedKey}"; the name may already be taken`);
        return profileName;
      }
    }
    await ctx.cookies.setLabel(domain, trimmedKey, trimmedLabel);
    ctx.prompt.log(
      "success",
      `Profile updated${trimmedKey !== profileName ? ` - now "${trimmedKey}"` : ""}`,
    );
    return trimmedKey;
  }

  private async addCookiesFlow(
    ctx: ShellContext,
    domain: string,
    profileName: string,
  ): Promise<void> {
    ctx.prompt.log("info", "Enter cookie name/value pairs one at a time. Leave the name blank when you are done.");
    ctx.prompt.log("dim", "Press Enter on the name prompt with nothing typed to stop.");

    const added: StoredCookie[] = [];

    while (true) {
      const name = await ctx.prompt.text({ message: "Cookie name  (blank = done):" });
      if (name === Cancel) return;
      if (!name.trim()) break;

      const value = await ctx.prompt.text({ message: `Value for "${name.trim()}":` });
      if (value === Cancel) return;

      const wantAdvanced = await ctx.prompt.confirm({
        message: "Set advanced options (path / secure / httpOnly / sameSite / expiry)?",
        initial: false,
      });
      if (wantAdvanced === Cancel) return;

      let cPath = "/";
      let secure = false;
      let httpOnly = false;
      let sameSite: "Strict" | "Lax" | "None" = "Lax";
      let expires = -1;

      if (wantAdvanced) {
        const advPath = await ctx.prompt.text({ message: "Path:", initial: "/" });
        if (advPath === Cancel) return;
        cPath = advPath || "/";

        const advSecure = await ctx.prompt.confirm({ message: "Secure?", initial: false });
        if (advSecure === Cancel) return;
        secure = advSecure;

        const advHttpOnly = await ctx.prompt.confirm({ message: "HttpOnly?", initial: false });
        if (advHttpOnly === Cancel) return;
        httpOnly = advHttpOnly;

        const advSameSite = await ctx.prompt.select<"Lax" | "Strict" | "None">({
          message: "SameSite:",
          options: [
            { value: "Lax", label: "Lax" },
            { value: "Strict", label: "Strict" },
            { value: "None", label: "None" },
          ],
          initial: "Lax",
        });
        if (advSameSite === Cancel) return;
        sameSite = advSameSite;

        const advExpiry = await ctx.prompt.text({
          message: "Expire after N days (-1 = session cookie):",
          initial: "-1",
          validate: (v: string) => {
            const n = parseInt(v, 10);
            return (!isNaN(n) && (n === -1 || n > 0)) || "Enter a positive integer or -1";
          },
        });
        if (advExpiry === Cancel) return;
        const days = parseInt(advExpiry, 10);
        expires = days === -1 ? -1 : Math.floor(Date.now() / 1000) + days * 86_400;
      }

      added.push({
        name: name.trim(),
        value: value.trim(),
        path: cPath,
        secure,
        httpOnly,
        sameSite,
        expires,
      });
      ctx.prompt.log(
        "success",
        `Queued "${name.trim()}" - continue adding or leave the name blank to save`,
      );
    }

    if (added.length > 0) {
      await ctx.cookies.upsert(domain, profileName, added);
      ctx.prompt.log(
        "success",
        `Saved ${added.length} cookie(s) to profile "${profileName}" for ${domain}`,
      );
    } else {
      ctx.prompt.log("dim", "No cookies added.");
    }
  }

  private async pasteHeaderFlow(
    ctx: ShellContext,
    domain: string,
    profileName: string,
  ): Promise<void> {
    ctx.prompt.log("info", "Paste the value of the Cookie: request header copied from your browser.");
    ctx.prompt.log("dim", "Example:  session=abc123; theme=dark; _ga=GA1.2.0.000");

    const raw = await ctx.prompt.text({
      message: "Paste Cookie: header value:",
      validate: (v: string) => v.trim().includes("=") || "Doesn't look like a valid Cookie header",
    });
    if (raw === Cancel) return;

    const parsed = parseCookieHeader(raw.trim());
    if (parsed.length === 0) {
      ctx.prompt.log("warn", "Could not parse any cookies from that string.");
      return;
    }
    ctx.prompt.log("info", `Parsed ${parsed.length} cookie(s):`);
    parsed.forEach((c) => ctx.prompt.log("dim", `  ${c.name} = ${fmt.truncate(c.value, 60)}`));

    const confirm = await ctx.prompt.confirm({
      message: `Save these ${parsed.length} cookie(s) to profile "${profileName}" for ${domain}?`,
      initial: true,
    });
    if (confirm === Cancel || confirm === false) {
      ctx.prompt.log("warn", "Save cancelled.");
      return;
    }
    await ctx.cookies.upsert(domain, profileName, parsed);
    ctx.prompt.log(
      "success",
      `Saved ${parsed.length} cookie(s) to profile "${profileName}" for ${domain}`,
    );
  }

  private async captureViaLoginFlow(
    ctx: ShellContext,
    domain: string,
    profileName: string,
  ): Promise<void> {
    ctx.prompt.log("info", `Opening an isolated browser window for ${domain}.`);
    ctx.prompt.log("dim", "Log in as you normally would. Nothing from your regular scraping session is affected.");

    const loginUrl = await ctx.prompt.text({
      message: "Page to open first:",
      placeholder: `https://${domain}/login`,
      validate: validateUrl,
    });
    if (loginUrl === Cancel) return;

    const cfg = await ctx.config.read();
    const deps: CaptureDeps = {
      browser: ctx.browser,
      fingerprintSeed: cfg.fingerprintSeed,
      humanPreset: cfg.humanPreset,
      timezone: "America/New_York",
      locale: cfg.defaultLanguage === "en" ? "en-US" : cfg.defaultLanguage,
      navigationTimeoutMs: cfg.navigationTimeoutMs,
    };

    const spin = ctx.prompt.spinner();
    spin.start("Launching browser...");
    let session;
    try {
      session = await beginCapture(deps, normalizeUrl(loginUrl));
    } catch (e) {
      spin.fail("Failed to launch browser or open the login page.");
      ctx.prompt.log("error", `Browser login capture failed: ${(e as Error).message}`);
      return;
    }
    spin.succeed("Browser window opened.");

    try {
      const ack = await ctx.prompt.text({
        message: "Log in in the browser window, then press Enter here to capture cookies...",
      });
      if (ack === Cancel) {
        await abortCapture(deps, session);
        ctx.prompt.log("warn", "Capture cancelled; nothing was saved.");
        return;
      }

      const result = await finishCapture(deps, session);
      if (result.cookies.length === 0) {
        ctx.prompt.log(
          "warn",
          "No cookies were captured - the login may not have completed, or the site sets none.",
        );
        return;
      }
      ctx.prompt.log(
        "success",
        `Captured ${result.cookies.length} cookie(s) across ${result.siteCount} site(s).`,
      );
      const confirm = await ctx.prompt.confirm({
        message: `Save as profile "${profileName}" for ${domain}? This replaces any cookies already stored in this profile.`,
        initial: true,
      });
      if (confirm === Cancel || confirm === false) {
        ctx.prompt.log("warn", "Discarded - nothing was saved.");
        return;
      }
      await ctx.cookies.save(domain, profileName, result.cookies);
      ctx.prompt.log("success", `Profile "${profileName}" saved.`);
    } catch (e) {
      try {
        await abortCapture(deps, session);
      } catch {
        /* swallow */
      }
      ctx.prompt.log("error", `Browser login capture failed: ${(e as Error).message}`);
    }
  }
}

