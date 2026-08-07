// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/cookies.ts - `wnscrape cookies ls / add --file / rm`.
//
//  §2.4: the CLI owns only the `--file` input mode (the scriptable one).
//  paste-header / key-value / browser-capture stay TUI-only.
//
//  `loadCookiesFile` is the shared helper §2.8 puts here, reused by
//  `cliCommands/run.ts` for `--cookies-file` (v1 `cookiesFile` job field):
//    - v1 cookie-snippet JSON   { cookies: [{name,value,path,expires,httpOnly,secure,sameSite}] }
//    - `Cookie:` header string  "session=abc; theme=dark"
//  Shapes are auto-detected.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";

import type { Logger } from "../../ports/Logger.js";
import { JsonCookieStore } from "../../adapters/store-json/JsonCookieStore.js";
import { createWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import logger from "../../logger/index.js";
import { parseCookieHeader, type StoredCookie, type DomainCookie } from "../../core/domain/Cookie.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";

export interface GlobalCliOpts {
  json?: boolean;
  quiet?: boolean;
}

/** Snippet shape v1's `cookiesFile` job field reads, and the `<profile>/*` export. */
interface CookieSnippetFile {
  cookies: StoredCookie[];
}

function newCookieStore(log: Logger): JsonCookieStore {
  return new JsonCookieStore(log);
}

function newLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope - swap to a fully-silent Logger port so
  // the ONLY stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createWinstonLogger(logger);
}

/** Read a v1 cookie-snippet JSON file OR a `Cookie:` header string. Auto-detects shape. */
export function loadCookiesFile(filePath: string): DomainCookie[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const trimmed = raw.trim();
  // JSON snippet shape `{ cookies: [...] }` (an object) - the v1 round-trip.
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`cookies file ${filePath} is not valid JSON: ${(e as Error).message}`);
    }
    const obj = parsed as Partial<CookieSnippetFile>;
    if (!obj || !Array.isArray(obj.cookies)) {
      throw new Error(
        `cookies file ${filePath} is an object but missing a 'cookies' array (v1 snippet shape)`,
      );
    }
    // DomainCookie = StoredCookie + domain. The snippet never carries per-cookie
    // `domain`; the caller (run --cookies-file, or cookies add --domain) sets the
    // hostname. v1 left `domain: ""` here too; the adapter's addCookies sets
    // URL-scoped cookies at the context layer.
    return obj.cookies.map((c) => ({ ...c, domain: "" }));
  }
  // Otherwise treat the file as a `Cookie:` header string.
  const cookies = parseCookieHeader(trimmed);
  return cookies.map((c) => ({ ...c, domain: "" }));
}

// ── `cookies ls` ───────────────────────────────────────────────────────────

export async function cookiesLsCommand(opts: GlobalCliOpts): Promise<void> {
  const log = newLog(opts.json === true);
  const store = newCookieStore(log);
  const command = "cookies ls";
  try {
    const domains = await store.listDomains();
    const listing: Record<string, Record<string, unknown>> = {};
    for (const d of domains) {
      const profiles = await store.listProfiles(d);
      listing[d] = {};
      for (const p of profiles) {
        const summary = await store.describeProfile(d, p);
        listing[d][p] = summary ?? null;
      }
    }
    if (opts.json) {
      emitJson({ ok: true, command, data: listing } satisfies JsonResult);
      return;
    }
    // Human-readable.
    if (domains.length === 0) {
      console.log("No cookie profiles saved.");
      return;
    }
    for (const d of domains) {
      console.log(d);
      const profiles = await store.listProfiles(d);
      for (const p of profiles) {
        const summary = await store.describeProfile(d, p);
        const label = summary?.label ? ` (${summary.label})` : "";
        console.log(`  ${p}${label}  ${summary?.cookieCount ?? 0} cookies  ${summary?.updatedAt ?? ""}`);
      }
    }
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "COOKIES_LS_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── `cookies add --file <f> --domain <d> --profile <p> [--label <l>]` ────────

export async function cookiesAddCommand(opts: {
  file: string;
  domain: string;
  profile: string;
  label?: string;
} & GlobalCliOpts): Promise<void> {
  const command = "cookies add";
  const log = newLog(opts.json === true);
  const store = newCookieStore(log);
  try {
    if (!opts.file) {
      throw new Error("--file <path> is required");
    }
    if (!opts.domain) {
      throw new Error("--domain <d> is required");
    }
    if (!opts.profile) {
      throw new Error("--profile <p> is required");
    }
    const domainCookies = loadCookiesFile(opts.file);
    const stored: StoredCookie[] = domainCookies.map(({ domain: _domain, ...rest }) => rest);

    // v1 upsert preserves createdAt / lastUsedAt.
    await store.upsert(opts.domain, opts.profile, stored);
    if (opts.label) {
      await store.setLabel(opts.domain, opts.profile, opts.label);
    }

    const summary = await store.describeProfile(opts.domain, opts.profile);
    if (opts.json) {
      emitJson({ ok: true, command, data: { domain: opts.domain, profile: opts.profile, summary } } satisfies JsonResult);
      return;
    }
    console.log(`Upserted ${stored.length} cookie(s) into ${opts.domain}/${opts.profile}`);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "COOKIES_ADD_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── `cookies rm --domain <d> [--profile <p> | --all]` ─────────────────────────

export async function cookiesRmCommand(opts: {
  domain: string;
  profile?: string;
  all?: boolean;
} & GlobalCliOpts): Promise<void> {
  const command = "cookies rm";
  const log = newLog(opts.json === true);
  const store = newCookieStore(log);
  try {
    if (!opts.domain) {
      throw new Error("--domain <d> is required");
    }
    if (!opts.all && !opts.profile) {
      throw new Error("either --profile <p> or --all is required");
    }
    let removed: boolean;
    if (opts.all) {
      removed = await store.deleteDomain(opts.domain);
    } else {
      removed = await store.deleteProfile(opts.domain, opts.profile!);
    }
    if (opts.json) {
      emitJson({ ok: true, command, data: { domain: opts.domain, removed } } satisfies JsonResult);
    } else if (removed) {
      console.log(`Removed ${opts.all ? "domain" : "profile"} ${opts.domain}${opts.all ? "" : `/${opts.profile}`}`);
    } else {
      console.error(`Nothing to remove for ${opts.domain}${opts.all ? "" : `/${opts.profile}`}`);
    }
    if (!removed) process.exit(1);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "COOKIES_RM_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}
