// ─────────────────────────────────────────────────────────────────────────────
//  Shell - the Clack-based screen-shell composition root (Phase 3).
//
//  - Owns the screen stack; render() returns a ScreenResult, the shell pushes
//    or pops, and re-renders the active screen. Replaces v1's recursive
//    mainMenu() loop (ADR-002: "stack of screens, not a cascade of prompt()
//    calls").
//  - Cancel semantics (ADR-P3-H): any PromptProvider Cancel pops one screen;
//    on the root cancel is a no-op. This is strictly safer than v1 (which
//    patched Enquirer's prototype to make Ctrl+C quit-from-anywhere).
//  - Ctrl+Q graceful quit is installed at boot via the shell-level stdin
//    keypress listener (ADR-P3-H / readme §2.6), NOT a prototype patch - it
//    is the same `scrapeKeys.ts` standalone-listener pattern that
//    03-tui-design §5 explicitly allows.
// ─────────────────────────────────────────────────────────────────────────────

import readline from "readline";

import type { BrowserPort } from "../../ports/BrowserPort.js";
import type { ConfigStore } from "../../ports/ConfigStore.js";
import type { CookieStore } from "../../ports/CookieStore.js";
import type { ProfileStore } from "../../ports/ProfileStore.js";
import type { SessionStore } from "../../ports/SessionStore.js";
import type { Logger } from "../../ports/Logger.js";

import type { PromptProvider } from "./PromptProvider.js";
import type { Screen, ShellContext, ScreenResult, TaskRegistry } from "./ShellContext.js";

export interface ShellDeps {
  config: ConfigStore;
  cookies: CookieStore;
  profiles: ProfileStore;
  sessions: SessionStore;
  browser: BrowserPort;
  log: Logger;
  prompt: PromptProvider;
  tasks: TaskRegistry;
  // Optional hooks for the test harness / composition root.
  // flushOnQuit: called before closeAll() on graceful quit. Phase 3 ships a
  // no-op default (Phase 4 wires ScrapeService.cancel() + final checkpoint).
  flushOnQuit?: () => Promise<void>;
  // exitFn is overridable for tests; default is process.exit(0).
  exitFn?: () => void;
  // stdin override: tests pass a fake; production uses process.stdin.
  stdin?: NodeJS.ReadStream & { setRawMode?(m: boolean): void; isTTY?: boolean };
}

interface StackFrame {
  screen: string;
  params: unknown;
}

export class Shell {
  private stack: StackFrame[] = [];
  private registry: Map<string, Screen>;
  private deps: ShellDeps;
  private ctx: ShellContext;
  private quitRequested = false;
  private removeKeypress: (() => void) | null = null;

  constructor(registry: Map<string, Screen>, deps: ShellDeps) {
    this.registry = registry;
    this.deps = deps;
    this.ctx = {
      config: deps.config,
      cookies: deps.cookies,
      profiles: deps.profiles,
      sessions: deps.sessions,
      browser: deps.browser,
      log: deps.log,
      prompt: deps.prompt,
      tasks: deps.tasks,
      navigate: (to, params) => {
        this.stack.push({ screen: to, params });
      },
    };
  }

  async run(startScreen: string, params?: unknown): Promise<void> {
    this.stack.push({ screen: startScreen, params });
    this.installQuitListener();

    while (!this.quitRequested && this.stack.length > 0) {
      const frame = this.stack[this.stack.length - 1];
      const screen = this.registry.get(frame.screen);
      if (!screen) {
        throw new Error(`Shell: unknown screen "${frame.screen}"`);
      }
      let result: ScreenResult;
      try {
        result = await screen.render(this.ctx, frame.params);
      } catch (e) {
        // A thrown error in a screen never bubbles to the user; surface via
        // the log region and pop so the previous screen can recover.
        this.deps.log.error(`Screen "${frame.screen}" threw: ${(e as Error).message}`);
        result = { action: "pop" };
      }
      this.applyResult(result);
    }

    this.uninstallQuitListener();
    await this.shutdown("shell completed");
  }

  private applyResult(result: ScreenResult): void {
    switch (result.action) {
      case "push":
        this.stack.push({ screen: result.screen, params: result.params });
        break;
      case "pop":
        // pop from a nested screen returns to the caller. pop from root
        // (nothing to pop) is a NO-OP - a single Escape/Ctrl+C on the main
        // menu never kills the app (ADR-P3-H; T2/T10 assert the no-op).
        // Graceful quit is reached via the `quit` action or Ctrl+Q.
        if (this.stack.length > 1) {
          this.stack.pop();
        }
        break;
      case "replace":
        this.stack.pop();
        this.stack.push({ screen: result.screen, params: result.params });
        break;
      case "quit":
        this.quitRequested = true;
        break;
    }
  }

  // ── Graceful-quit listener (Ctrl+Q) ──────────────────────────────────────
  // Per ADR-P3-H: clack owns Ctrl+C as cancel; the Shell installs Ctrl+Q
  // through a standalone keypress listener (NOT a prototype patch), matching
  // the scrapeKeys.ts precedent.
  private installQuitListener(): void {
    const stdin = this.deps.stdin ?? (process.stdin as NodeJS.ReadStream);
    if (!stdin.isTTY || !stdin.setRawMode) return;

    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      return; // raw mode unsupported in this environment - skip without error
    }

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } = {}): void => {
      if (key.ctrl && key.name === "q") {
        this.quitRequested = true;
      }
    };
    stdin.on("keypress", onKey);

    const restore = (): void => {
      stdin.removeListener("keypress", onKey);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* already restored */
      }
    };
    this.removeKeypress = restore;
  }

  private uninstallQuitListener(): void {
    if (this.removeKeypress) {
      this.removeKeypress();
      this.removeKeypress = null;
    }
  }

  // Re-entrant safe: shutdown hooks fire only once.
  private shuttingDown = false;
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.uninstallQuitListener();
    this.deps.log.info(`Shell shutting down (${reason})`);
    try {
      if (this.deps.flushOnQuit) await this.deps.flushOnQuit();
    } catch (e) {
      this.deps.log.error(`flushOnQuit failed: ${(e as Error).message}`);
    }
    try {
      await this.deps.browser.closeAll();
    } catch (e) {
      this.deps.log.error(`browser.closeAll failed: ${(e as Error).message}`);
    }
    this.quitRequested = true;
    if (this.deps.exitFn) this.deps.exitFn();
  }
}
