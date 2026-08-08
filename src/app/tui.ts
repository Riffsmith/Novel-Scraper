// ─────────────────────────────────────────────────────────────────────────────
//  app/tui.ts - Phase 3/4 TUI composition root.
//
//  Wiring (mirrors runJob.ts as a sibling composition root - ADR-P3-G):
//    - YamlConfigStore, JsonCookieStore, JsonProfileStore, JsonSessionStore
//      (Phase 2 store adapters) over the shared XDG paths
//    - PlaywrightBrowserPort (real binary - production)
//    - WinstonLogger (production)
//    - clackPromptProvider - the only @clack/prompts import site
//    - Shell with every screen registered + a LIVE LiveTaskRegistry (readme
//      §2.2 / ADR-P3-D - the Phase 3 `{}` stub is replaced)
//
//  Phase 4 additions vs Phase 3:
//    - LiveTaskRegistry wired into ShellDeps.tasks + the flushOnQuit hook so
//      Ctrl+Q mid-scrape cancels the running ScrapeService (saving a final
//      checkpoint) before browser.closeAll() runs (readme §2.6 / §2.7).
//    - The five Phase 4 screens registered: new, manual-wizard,
//      manual-discovery, chapter-list, task, auto-probe, auto-customize.
//    - MainScreen "new" and ResumeScreen "resume" no longer stub - MainScreen
//      pushes "new" and ResumeScreen pushes "task" with mkResumeParams.
//
//  The bin repoint (wnscrape -> tui.ts) is deferred to Phase 5 (ADR-005);
//  Phase 3/4 only add `pnpm dev:tui`. WNS: running `pnpm dev:tui` boots the
//  shell under tsx without disturbing v1's `pnpm dev`.
// ─────────────────────────────────────────────────────────────────────────────

import { PlaywrightBrowserPort } from "../adapters/browser-playwright/PlaywrightBrowserPort.js";
import { YamlConfigStore } from "../adapters/config-yaml/YamlConfigStore.js";
import { JsonCookieStore } from "../adapters/store-json/JsonCookieStore.js";
import { JsonProfileStore } from "../adapters/store-json/JsonProfileStore.js";
import { JsonSessionStore } from "../adapters/store-json/JsonSessionStore.js";
import { createDefaultWinstonLogger } from "../adapters/logger-winston/WinstonLogger.js";
import { clackPromptProvider } from "../adapters/ui-clack/clackPrompts.js";
import { Shell } from "../adapters/ui-clack/Shell.js";
import { LiveTaskRegistry } from "../adapters/ui-clack/TaskRegistry.js";
import type { Screen } from "../adapters/ui-clack/ShellContext.js";
import { MainScreen } from "../adapters/ui-clack/screens/MainScreen.js";
import { ResumeScreen } from "../adapters/ui-clack/screens/ResumeScreen.js";
import { NewScrapeScreen } from "../adapters/ui-clack/screens/NewScrapeScreen.js";
import { ManualWizardScreen } from "../adapters/ui-clack/screens/ManualWizardScreen.js";
import { ManualDiscoveryScreen } from "../adapters/ui-clack/screens/ManualDiscoveryScreen.js";
import { ChapterListScreen } from "../adapters/ui-clack/screens/ChapterListScreen.js";
import { AutoProbeScreen } from "../adapters/ui-clack/screens/AutoProbeScreen.js";
import { AutoCustomizeScreen } from "../adapters/ui-clack/screens/AutoCustomizeScreen.js";
import { TaskScreen } from "../adapters/ui-clack/screens/TaskScreen.js";
import { CookieManagerScreen } from "../adapters/ui-clack/screens/CookieManagerScreen.js";
import { SettingsScreen } from "../adapters/ui-clack/screens/SettingsScreen.js";
import { LibraryScreen } from "../adapters/ui-clack/screens/LibraryScreen.js";
import { ErrorScreen } from "../adapters/ui-clack/screens/ErrorScreen.js";

import { fileURLToPath } from "url";

function buildRegistry(): Map<string, Screen> {
  const r = new Map<string, Screen>();
  r.set("main", new MainScreen());
  r.set("resume", new ResumeScreen());
  r.set("new", new NewScrapeScreen());
  r.set("manual-wizard", new ManualWizardScreen());
  r.set("manual-discovery", new ManualDiscoveryScreen());
  r.set("chapter-list", new ChapterListScreen());
  r.set("auto-probe", new AutoProbeScreen());
  r.set("auto-customize", new AutoCustomizeScreen());
  r.set("task", new TaskScreen());
  r.set("cookies", new CookieManagerScreen());
  r.set("settings", new SettingsScreen());
  r.set("library", new LibraryScreen());
  // ErrorScreen takes (context, e); instantiated lazily via push-only
  r.set("error", new ErrorScreen("(no context)", null, [
    "(no error message - ErrorScreen reached with no params)",
  ]));
  return r;
}

export async function main(): Promise<void> {
  const log = createDefaultWinstonLogger();
  const config = new YamlConfigStore(log);
  const cookies = new JsonCookieStore(log);
  const profiles = new JsonProfileStore(log);
  const sessions = new JsonSessionStore(log);
  const browser = new PlaywrightBrowserPort();
  const tasks = new LiveTaskRegistry();

  const shell = new Shell(buildRegistry(), {
    config,
    cookies,
    profiles,
    sessions,
    browser,
    log,
    prompt: clackPromptProvider,
    tasks,
    flushOnQuit: async () => {
      // Phase 4 wiring (readme §2.6): if a scrape is running, flip its
      // ScrapeService.abort via the registry's cancelActive() so a final
      // checkpoint lands before browser.closeAll() runs. Safe to await even
      // when no task is live (the registry no-ops).
      await tasks.cancelActive();
    },
  });

  await shell.run("main");
}

// Auto-boot only when invoked as the entry module (pnpm dev:tui); the v2
// `tui` subcommand in cli.ts imports this module for `main()` only, so the
// side-effect must not fire on import (Phase 5 §2.2).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error("Fatal error booting TUI:");
    console.error(e);
    process.exit(1);
  });
}
