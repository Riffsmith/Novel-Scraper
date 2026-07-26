// ─────────────────────────────────────────────────────────────────────────────
//  Cookie Manager TUI
//
//  Domain → named cookie profile → cookies. Provides an interactive terminal
//  UI to:
//    • List domains, then profiles within a domain
//    • Inspect / add / update / delete cookies within a profile
//    • Add a profile via manual entry (k/v or raw Cookie: header) OR via a
//      real isolated browser login-capture session
//    • Rename / relabel, or delete, a profile
//    • Delete all profiles for a domain
//    • Resolve which profile to use at scrape time (auto when unambiguous)
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";
import type { Cookie } from "playwright";
import * as disp from "./display.js";
import { reportError } from "./errors.js";
import { validateUrl } from "./prompts.js";
import { readConfig } from "../config/appConfig.js";
import {
  listDomains,
  listProfiles,
  getProfile,
  describeProfile,
  loadCookiesForProfile,
  saveProfileCookies,
  upsertProfileCookies,
  deleteProfileCookie,
  deleteProfile,
  deleteDomain,
  renameProfile,
  setProfileLabel,
  markProfileUsed,
  parseCookieHeader,
  normaliseDomain,
  COOKIE_FILE,
  type StoredCookie,
} from "../cookies/store.js";
import {
  beginCaptureSession,
  finishCaptureSession,
  abortCaptureSession,
} from "../cookies/capture.js";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require("enquirer");

async function prompt<T extends Record<string, unknown>>(
  questions: object | object[],
): Promise<T> {
  return _prompt(questions) as Promise<T>;
}

// ── Validators ─────────────────────────────────────────────────────────────────
function validateDomain(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "Domain cannot be empty";
  try {
    const h = trimmed.startsWith("http") ? new URL(trimmed).hostname : trimmed;
    if (h.includes(".") || h === "localhost") return true;
    return "Enter a valid hostname  e.g. novelupdates.com";
  } catch {
    return "Invalid domain / URL";
  }
}

// Profile names: [a-z0-9_-] only — unambiguous in menus and as JSON keys.
const PROFILE_NAME_RE = /^[a-z0-9_-]+$/;

function validateProfileNameChars(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "Profile name cannot be empty";
  return (
    PROFILE_NAME_RE.test(trimmed) ||
    "Only lowercase letters, numbers, _ and - are allowed"
  );
}

// ── Display helpers ───────────────────────────────────────────────────────────
function printCookieTable(
  cookies: StoredCookie[],
  domain: string,
  profileName: string,
): void {
  console.log("");
  console.log(chalk.dim("  " + "─".repeat(70)));
  console.log(
    chalk.white.bold(`  Cookies for ${chalk.cyan(domain)}`) +
      chalk.dim(` · profile "${profileName}"`) +
      chalk.dim(` (${cookies.length} stored)`),
  );
  console.log(chalk.dim("  " + "─".repeat(70)));

  if (cookies.length === 0) {
    console.log(chalk.dim("  (no cookies stored)"));
  } else {
    cookies.forEach((c, i) => {
      const expiry =
        c.expires === -1
          ? chalk.dim("session")
          : chalk.dim(new Date(c.expires * 1000).toLocaleDateString());
      const flags = [
        c.httpOnly ? chalk.yellow("httpOnly") : "",
        c.secure ? chalk.green("secure") : "",
      ]
        .filter(Boolean)
        .join(" ");

      console.log(
        `  ${chalk.dim((i + 1).toString().padStart(3) + ".")}  ` +
          chalk.cyan(c.name.padEnd(32)) +
          chalk.white(truncate(c.value, 24).padEnd(26)) +
          expiry.padEnd(14) +
          flags,
      );
    });
  }
  console.log(chalk.dim("  " + "─".repeat(70)));
  console.log("");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function profileMetaLine(domain: string, name: string): string {
  const s = describeProfile(domain, name)!;
  const bits = [
    `${s.cookieCount} cookie${s.cookieCount !== 1 ? "s" : ""}`,
    s.lastUsedAt ? `last used ${s.lastUsedAt.slice(0, 10)}` : `never used`,
  ];
  return `${chalk.cyan(s.label ?? name)}  ${chalk.dim(`(${bits.join(", ")})`)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main cookie manager entry point
// ═══════════════════════════════════════════════════════════════════════════
export async function manageCookies(): Promise<void> {
  disp.section("Cookie Manager");
  console.log(chalk.dim(`  Store: ${COOKIE_FILE}`));
  console.log("");

  while (true) {
    const domains = listDomains();

    const domainChoices = [
      ...domains.map((d) => {
        const count = listProfiles(d).length;
        return {
          name: d,
          message: `${chalk.cyan(d)}  ${chalk.dim(`(${count} cookie profile${count !== 1 ? "s" : ""})`)}`,
        };
      }),
      { name: "__add__", message: chalk.green("Add cookies for a new domain") },
      { name: "__back__", message: chalk.dim("Back") },
    ];

    const { selectedDomain } = await prompt<{ selectedDomain: string }>({
      type: "select",
      name: "selectedDomain",
      message:
        domains.length > 0
          ? "Select a domain to manage, or add a new one:"
          : "No cookie profiles stored yet. Add some?",
      choices: domainChoices,
    });

    if (selectedDomain === "__back__") break;

    if (selectedDomain === "__add__") {
      await addDomainFlow(null);
      continue;
    }

    await manageDomainFlow(selectedDomain);
  }
}

// ── Add-domain flow (shared with "add from domain management screen") ─────────
async function addDomainFlow(prefillDomain: string | null): Promise<void> {
  const { domain } = await prompt<{ domain: string }>({
    type: "input",
    name: "domain",
    message: "Domain (e.g. novelupdates.com):",
    initial: prefillDomain ?? "",
    validate: validateDomain,
  });

  await manageDomainFlow(normaliseDomain(domain.trim()));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Domain screen — lists cookie profiles for one domain
// ═══════════════════════════════════════════════════════════════════════════
async function manageDomainFlow(domain: string): Promise<void> {
  while (true) {
    const profileNames = listProfiles(domain);

    // Zero profiles → skip straight to "add a new profile" instead of
    // showing an empty picker.
    if (profileNames.length === 0) {
      const added = await addProfileFlow(domain, []);
      if (!added) return; // user backed out with nothing added — return to domain list
      continue;
    }

    console.log("");
    console.log(
      chalk.white.bold(`  Cookie profiles for ${chalk.cyan(domain)}`),
    );
    console.log("");

    const { selected } = await prompt<{ selected: string }>({
      type: "select",
      name: "selected",
      message: "Select a profile to manage:",
      choices: [
        ...profileNames.map((name) => ({
          name,
          message: profileMetaLine(domain, name),
        })),
        { name: "__add__", message: chalk.green("Add a new cookie profile") },
        {
          name: "__delete_all__",
          message: chalk.red("Delete ALL profiles for this domain"),
        },
        { name: "__back__", message: chalk.dim("Back") },
      ],
    });

    if (selected === "__back__") break;

    if (selected === "__add__") {
      await addProfileFlow(domain, profileNames);
      continue;
    }

    if (selected === "__delete_all__") {
      const { confirmed } = await prompt<{ confirmed: boolean }>({
        type: "confirm",
        name: "confirmed",
        message: chalk.red(
          `Delete all ${profileNames.length} cookie profile(s) for ${domain}? This cannot be undone.`,
        ),
        initial: false,
      });
      if (confirmed) {
        deleteDomain(domain);
        disp.success(`All cookie profiles for ${domain} deleted`);
        break; // domain is gone — return to the domain list
      }
      continue;
    }

    await manageProfileFlow(domain, selected);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Per-profile action menu
// ═══════════════════════════════════════════════════════════════════════════
async function manageProfileFlow(
  domain: string,
  profileName: string,
): Promise<void> {
  while (true) {
    const profile = getProfile(domain, profileName);
    if (!profile) return; // deleted from elsewhere mid-session

    printCookieTable(profile.cookies, domain, profileName);

    const { action } = await prompt<{ action: string }>({
      type: "select",
      name: "action",
      message: `Manage profile "${chalk.cyan(profileName)}" for ${chalk.cyan(domain)}:`,
      choices: [
        {
          name: "add_kv",
          message: "Add or update a cookie (enter name and value)",
        },
        { name: "add_header", message: "Paste a raw Cookie: header string" },
        {
          name: "capture",
          message:
            "Log in via browser and capture cookies (replaces this profile)",
        },
        { name: "relabel", message: "Rename or relabel this profile" },
        {
          name: "delete_one",
          message: "Delete a single cookie by name",
          disabled: profile.cookies.length === 0,
        },
        { name: "delete_profile", message: chalk.red("Delete this profile") },
        { name: "back", message: chalk.dim("Back") },
      ],
    });

    if (action === "back") break;

    if (action === "add_kv") {
      await addCookiesFlow(domain, profileName);
    } else if (action === "add_header") {
      await pasteHeaderFlow(domain, profileName);
    } else if (action === "capture") {
      await captureViaLoginFlow(domain, profileName);
    } else if (action === "relabel") {
      const renamedTo = await relabelFlow(domain, profileName);
      if (renamedTo !== profileName) profileName = renamedTo;
    } else if (action === "delete_one") {
      const { cookieName } = await prompt<{ cookieName: string }>({
        type: "select",
        name: "cookieName",
        message: "Which cookie to delete?",
        choices: profile.cookies.map((c) => ({
          name: c.name,
          message: `${chalk.cyan(c.name)}  ${chalk.dim(truncate(c.value, 40))}`,
        })),
      });
      const deleted = deleteProfileCookie(domain, profileName, cookieName);
      deleted
        ? disp.success(`Deleted "${cookieName}"`)
        : disp.warn(`"${cookieName}" was not found`);
    } else if (action === "delete_profile") {
      const { confirmed } = await prompt<{ confirmed: boolean }>({
        type: "confirm",
        name: "confirmed",
        message: chalk.red(
          `Delete profile "${profileName}" for ${domain}? This cannot be undone.`,
        ),
        initial: false,
      });
      if (confirmed) {
        deleteProfile(domain, profileName);
        disp.success(`Profile "${profileName}" deleted`);
        break; // return to the domain's profile list
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Add a new profile — name prompt, then choose an entry method
//  Returns true if a profile was actually created, false if the user backed
//  out (used by manageDomainFlow's zero-profile fast path to know whether to
//  loop again or fall back to the domain list).
// ═══════════════════════════════════════════════════════════════════════════
async function addProfileFlow(
  domain: string,
  existingNames: string[],
): Promise<boolean> {
  const profileName = await promptProfileName(domain, existingNames);
  if (profileName === null) return false; // user cancelled

  const { method } = await prompt<{ method: string }>({
    type: "select",
    name: "method",
    message: `How do you want to populate profile "${chalk.cyan(profileName)}"?`,
    choices: [
      { name: "capture", message: "Log in via browser (recommended)" },
      { name: "header", message: "Paste a raw Cookie: header string" },
      { name: "kv", message: "Enter cookies manually (name/value pairs)" },
      { name: "cancel", message: chalk.dim("Cancel") },
    ],
  });

  if (method === "cancel") return false;

  if (method === "capture") await captureViaLoginFlow(domain, profileName);
  else if (method === "header") await pasteHeaderFlow(domain, profileName);
  else await addCookiesFlow(domain, profileName);

  // Whether the sub-flow actually saved anything, the profile *name* has
  // been claimed as far as the caller's loop is concerned — re-check.
  return getProfile(domain, profileName) !== null;
}

// ── Validated profile-name prompt: charset (D5) + no duplicates ──────────────
// First profile for a domain suggests "default"; subsequent ones get no
// pre-fill, forcing a deliberate, meaningful name.
async function promptProfileName(
  domain: string,
  existingNames: string[],
): Promise<string | null> {
  const suggestion = existingNames.length === 0 ? "default" : "";

  const { name } = await prompt<{ name: string }>({
    type: "input",
    name: "name",
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

  return name.trim() || null;
}

// ── Rename and/or relabel a profile (D6 — one combined action) ───────────────
// Returns the profile's name after the operation (possibly renamed), or the
// original name if nothing changed. Label is applied via setProfileLabel —
// NOT saveProfileCookies — so that leaving the label field blank actually
// clears an existing label instead of silently keeping it (saveProfileCookies
// treats a missing label as "leave whatever was there," which is right for
// the login-capture path but wrong for an explicit relabel).
async function relabelFlow(
  domain: string,
  profileName: string,
): Promise<string> {
  const profile = getProfile(domain, profileName);
  if (!profile) return profileName;

  const existingNames = listProfiles(domain);

  const r = await prompt<{ newKey: string; newLabel: string }>([
    {
      type: "input",
      name: "newKey",
      message: "Profile key (used in menus and storage):",
      initial: profileName,
      validate: (v: string) => {
        const trimmed = v.trim();
        if (trimmed === profileName) return true; // unchanged is always fine
        const charCheck = validateProfileNameChars(trimmed);
        if (charCheck !== true) return charCheck;
        if (existingNames.includes(trimmed))
          return `A profile named "${trimmed}" already exists`;
        return true;
      },
    },
    {
      type: "input",
      name: "newLabel",
      message: "Free-text label (leave blank to clear):",
      initial: profile.label ?? "",
    },
  ]);

  const newKey = r.newKey.trim();
  const newLabel = r.newLabel.trim() || undefined; // undefined here means "clear it"

  if (newKey !== profileName) {
    const renamed = renameProfile(domain, profileName, newKey);
    if (!renamed) {
      disp.err(
        `Could not rename to "${newKey}" — the name may already be taken`,
      );
      return profileName;
    }
  }

  setProfileLabel(domain, newKey, newLabel);

  disp.success(
    `Profile updated${newKey !== profileName ? ` — now "${newKey}"` : ""}`,
  );
  return newKey;
}

// ── Interactive key-value cookie entry ────────────────────────────────────────
async function addCookiesFlow(
  domain: string,
  profileName: string,
): Promise<void> {
  disp.info(
    "Enter cookie name/value pairs one at a time. Leave the name blank when you are done.",
  );
  disp.dim("Press Enter on the name prompt with nothing typed to stop.");

  const added: StoredCookie[] = [];

  while (true) {
    const { name } = await prompt<{ name: string }>({
      type: "input",
      name: "name",
      message: `Cookie name  (blank = done):`,
    });

    if (!name.trim()) break;

    const { value } = await prompt<{ value: string }>({
      type: "input",
      name: "value",
      message: `Value for "${name.trim()}":`,
    });

    const { wantAdvanced } = await prompt<{ wantAdvanced: boolean }>({
      type: "confirm",
      name: "wantAdvanced",
      message:
        "Set advanced options (path / secure / httpOnly / sameSite / expiry)?",
      initial: false,
    });

    let path = "/";
    let secure = false;
    let httpOnly = false;
    let sameSite: "Strict" | "Lax" | "None" = "Lax";
    let expires = -1;

    if (wantAdvanced) {
      const adv = await prompt<{
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite: string;
        expiryDays: string;
      }>([
        { type: "input", name: "path", message: "Path:", initial: "/" },
        { type: "confirm", name: "secure", message: "Secure?", initial: false },
        {
          type: "confirm",
          name: "httpOnly",
          message: "HttpOnly?",
          initial: false,
        },
        {
          type: "select",
          name: "sameSite",
          message: "SameSite:",
          choices: ["Lax", "Strict", "None"],
          initial: "Lax",
        },
        {
          type: "input",
          name: "expiryDays",
          message:
            "Expire after N days (-1 = session cookie, cleared when the browser closes):",
          initial: "-1",
          validate: (v: string) => {
            const n = parseInt(v, 10);
            return (
              (!isNaN(n) && (n === -1 || n > 0)) ||
              "Enter a positive integer or -1"
            );
          },
        },
      ]);

      path = adv.path || "/";
      secure = adv.secure;
      httpOnly = adv.httpOnly;
      sameSite = adv.sameSite as "Strict" | "Lax" | "None";
      const days = parseInt(adv.expiryDays, 10);
      expires =
        days === -1 ? -1 : Math.floor(Date.now() / 1000) + days * 86_400;
    }

    added.push({
      name: name.trim(),
      value: value.trim(),
      path,
      secure,
      httpOnly,
      sameSite,
      expires,
    });
    disp.success(
      `Queued "${name.trim()}" — continue adding or leave the name blank to save`,
    );
  }

  if (added.length > 0) {
    upsertProfileCookies(domain, profileName, added);
    disp.success(
      `Saved ${added.length} cookie(s) to profile "${chalk.cyan(profileName)}" for ${chalk.cyan(domain)}`,
    );
  } else {
    disp.dim("No cookies added.");
  }
}

// ── Paste raw Cookie: header string ──────────────────────────────────────────
async function pasteHeaderFlow(
  domain: string,
  profileName: string,
): Promise<void> {
  disp.info(
    "Paste the value of the Cookie: request header copied from your browser.",
  );
  disp.dim("Example:  session=abc123; theme=dark; _ga=GA1.2.0.000");
  disp.dim(
    "Tip: open DevTools, go to the Network tab, click any request, then look under Headers for Cookie.",
  );
  console.log("");

  const { raw } = await prompt<{ raw: string }>({
    type: "input",
    name: "raw",
    message: "Paste Cookie: header value:",
    validate: (v: string) =>
      v.trim().includes("=") || "Doesn't look like a valid Cookie header",
  });

  const parsed = parseCookieHeader(raw.trim());
  if (parsed.length === 0) {
    disp.warn("Could not parse any cookies from that string.");
    return;
  }

  disp.info(`Parsed ${parsed.length} cookie(s):`);
  parsed.forEach((c) => {
    console.log(
      `  ${chalk.cyan(c.name)} = ${chalk.dim(truncate(c.value, 60))}`,
    );
  });
  console.log("");

  const { confirmed } = await prompt<{ confirmed: boolean }>({
    type: "confirm",
    name: "confirmed",
    message: `Save these ${parsed.length} cookie(s) to profile "${chalk.cyan(profileName)}" for ${chalk.cyan(domain)}?`,
    initial: true,
  });

  if (confirmed) {
    upsertProfileCookies(domain, profileName, parsed);
    disp.success(
      `Saved ${parsed.length} cookie(s) to profile "${chalk.cyan(profileName)}" for ${chalk.cyan(domain)}`,
    );
  }
}

// ── Browser login capture ─────────────────────────────────────────────────────
// Deliberately reuses appCfg.fingerprintSeed — if it's a fixed value, a
// mismatch between "the device that logged in" and "the device that later
// scrapes" is a signal some anti-bot systems catch. With the default null
// (random per launch) this is moot. See cookies/capture.ts for detail.
async function captureViaLoginFlow(
  domain: string,
  profileName: string,
): Promise<void> {
  disp.info(`Opening an isolated browser window for ${chalk.cyan(domain)}.`);
  disp.dim(
    "Log in as you normally would. Nothing from your regular scraping session is affected.",
  );
  console.log("");

  const { loginUrl } = await prompt<{ loginUrl: string }>({
    type: "input",
    name: "loginUrl",
    message: "Page to open first:",
    initial: `https://${domain}`,
    validate: validateUrl,
  });

  const appCfg = readConfig();
  const spin = disp.spinner("Launching browser…");

  let session;
  try {
    session = await beginCaptureSession(loginUrl.trim(), appCfg);
  } catch (e) {
    spin.fail("Failed to launch browser or open the login page.");
    await reportError("Browser login capture failed", e);
    return;
  }
  spin.succeed("Browser window opened.");

  try {
    await prompt<{ ack: string }>({
      type: "input",
      name: "ack",
      message:
        "Log in in the browser window, then press Enter here to capture cookies…",
    });

    const result = await finishCaptureSession(session);
    if (result.cookies.length === 0) {
      disp.warn(
        "No cookies were captured — the login may not have completed, or the site sets none.",
      );
      return;
    }

    disp.success(
      `Captured ${chalk.cyan(String(result.cookies.length))} cookie(s) across ${result.siteCount} site(s).`,
    );
    const { confirmed } = await prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message: `Save as profile "${chalk.cyan(profileName)}" for ${chalk.cyan(domain)}? This replaces any cookies already stored in this profile.`,
      initial: true,
    });

    if (confirmed) {
      saveProfileCookies(domain, profileName, result.cookies);
      disp.success(`Profile "${profileName}" saved.`);
    } else {
      disp.dim("Discarded — nothing was saved.");
    }
  } catch (e) {
    await abortCaptureSession(session);
    await reportError("Browser login capture failed", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Scrape-time profile selection
//
//  Zero profiles → nothing to do. One profile → auto-load, zero prompts
//  (matches today's zero-friction behavior). 2+ profiles → asks which one,
//  with a "don't use any" escape hatch.
// ═══════════════════════════════════════════════════════════════════════════
export async function selectCookieProfileForScrape(
  domain: string,
): Promise<{ profileName: string | null; cookies: Cookie[] }> {
  const profiles = listProfiles(domain);

  if (profiles.length === 0) {
    disp.dim(`No stored cookies for ${domain}`);
    return { profileName: null, cookies: [] };
  }

  if (profiles.length === 1) {
    const only = profiles[0];
    const cookies = loadCookiesForProfile(domain, only);
    markProfileUsed(domain, only);
    disp.success(
      `Loaded ${chalk.cyan(String(cookies.length))} saved cookie(s) — profile "${chalk.cyan(only)}" for ${chalk.cyan(domain)}`,
    );
    return { profileName: only, cookies };
  }

  const { chosen } = await prompt<{ chosen: string }>({
    type: "select",
    name: "chosen",
    message: `Multiple saved cookie profiles found for ${chalk.cyan(domain)} — which one?`,
    choices: [
      ...profiles.map((name) => ({
        name,
        message: profileMetaLine(domain, name),
      })),
      { name: "__none__", message: chalk.dim("Don't use any saved cookies") },
    ],
  });

  if (chosen === "__none__") return { profileName: null, cookies: [] };

  const cookies = loadCookiesForProfile(domain, chosen);
  markProfileUsed(domain, chosen);
  disp.success(
    `Loaded ${chalk.cyan(String(cookies.length))} saved cookie(s) — profile "${chalk.cyan(chosen)}"`,
  );
  return { profileName: chosen, cookies };
}
