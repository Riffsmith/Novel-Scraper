// ─────────────────────────────────────────────────────────────────────────────
//  paths - single source of truth for XDG data/config directory resolution.
//
//  This is the one duplication the migration guide (§1 note) allows us to
//  delete: v1 duplicated this exact resolution logic verbatim in three files
//  (config/appConfig.ts, cookies/store.ts, sessions/store.ts, plus
//  config/siteProfiles.ts). Getting it wrong means v2 writes to a different
//  directory than v1 reads - the worst possible migration bug. So every v2
//  store, both data and config, imports from here.
//
//  Resolution order is identical to v1:
//    $XDG_DATA_HOME    / $XDG_CONFIG_HOME    (Linux standard)
//    ~/Library/Application Support/… or %APPDATA%/… (macOS / Windows fallback)
//    ~/.local/share/…  / ~/.config/…         (Linux XDG fallback)
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import os from "os";

function platformBase(useConfig: boolean): string {
  // useConfig=true  -> ~/.config on Linux (XDG_CONFIG_HOME default)
  // useConfig=false -> ~/.local/share on Linux (XDG_DATA_HOME default)
  const xdg = process.env[useConfig ? "XDG_CONFIG_HOME" : "XDG_DATA_HOME"];
  if (xdg) return path.join(xdg, "webnovel-scraper");

  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "webnovel-scraper",
      );
    case "darwin":
      return path.join(home, "Library", "Application Support", "webnovel-scraper");
    default:
      return useConfig
        ? path.join(home, ".config", "webnovel-scraper")
        : path.join(home, ".local", "share", "webnovel-scraper");
  }
}

export function resolveConfigDir(): string {
  return platformBase(true);
}

export function resolveDataDir(): string {
  return platformBase(false);
}

// Normalise a directory path so callers don't have to special-case Windows
// separators in unit tests. joinWith(x) is still fine; this is strictly for
// comparison/display.
export function normalisePath(p: string): string {
  return p.split(path.sep).join("/");
}

export function sessionsDirPath(): string {
  return path.join(resolveDataDir(), "sessions");
}

export function cookiesFilePath(): string {
  return path.join(resolveDataDir(), "cookies.json");
}

export function siteProfilesFilePath(): string {
  return path.join(resolveDataDir(), "site-profiles.json");
}

export function configYamlPath(): string {
  return path.join(resolveConfigDir(), "config.yaml");
}

export function configJsonPath(): string {
  return path.join(resolveConfigDir(), "config.json");
}

export function configJsonBakPath(): string {
  return path.join(resolveConfigDir(), "config.json.bak");
}
