// ─────────────────────────────────────────────────────────────────────────────
//  ShellContext + Screen contract.
//
//  Per ADR-P3-D / readme §2.2 this is the normative Phase 3 shape, refining
//  03-tui-design §6's sketch: the four store PORTS (read/write/reset) are
//  carried here, not bare AppConfig or a "CookieService" that has no v2
//  counterpart. The shell depends on ports only, so hexagonal direction
//  (adapter -> ports -> core) is preserved.
//
//  Navigation is an explicit stack inside Shell: Screen.render() returns a
//  ScreenResult (push/pop/replace/quit), the shell pushes or pops, and
//  re-renders. This replaces v1's recursive `mainMenu()` loop and is exactly
//  the "stack of screens, not a cascade of standalone prompt() calls" shape
//  that ADR-002 asked for.
//
//  `tasks: TaskRegistry` is an empty type stub in Phase 3 so Phase 4's
//  TaskScreen slots in without changing the interface.
// ─────────────────────────────────────────────────────────────────────────────

import type { ConfigStore } from "../../ports/ConfigStore.js";
import type { CookieStore } from "../../ports/CookieStore.js";
import type { ProfileStore } from "../../ports/ProfileStore.js";
import type { SessionStore } from "../../ports/SessionStore.js";
import type { BrowserPort } from "../../ports/BrowserPort.js";
import type { Logger } from "../../ports/Logger.js";

import type { PromptProvider } from "./PromptProvider.js";
import type { ScrapeTask, TaskRegistryEvents } from "./TaskRegistry.js";

// TaskRegistry - Phase 4 ships a live implementation (readme §2.2 / ADR-P3-D),
// populating the empty Phase 3 stub. The interface is `TaskRegistryEvents`;
// the production implementation is `LiveTaskRegistry`. `ShellContext.tasks`
// carries the live registry so the TaskScreen can `tasks.start/finish/cancel`
// and the Shell's header strip can read the current `task` state.
export type TaskRegistry = TaskRegistryEvents;

export interface ShellContext {
  config: ConfigStore;
  cookies: CookieStore;
  profiles: ProfileStore;
  sessions: SessionStore;
  browser: BrowserPort;
  log: Logger;
  // Injected by Shell - same PromptProvider for every screen.
  prompt: PromptProvider;
  // Empty in Phase 3; populated in Phase 4 with a LiveTaskRegistry.
  tasks: TaskRegistry;
  // Resolves to true when the user invoked graceful quit (Ctrl+Q); screens
  // can early-return by checking this, but the canonical quit path is the
  // ScreenResult 'quit' action.
  navigate(to: string, params?: unknown): void;
}

// Re-exported so tests / composition root can construct ScrapeTask without
// an extra import only to round-trip here.
export type { ScrapeTask };

export interface Screen {
  readonly id: string;
  render(ctx: ShellContext, params?: unknown): Promise<ScreenResult>;
}

export type ScreenResult =
  | { action: "push"; screen: string; params?: unknown }
  | { action: "pop" }
  | { action: "replace"; screen: string; params?: unknown }
  | { action: "quit" };
