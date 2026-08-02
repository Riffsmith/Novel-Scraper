// ─────────────────────────────────────────────────────────────────────────────
//  Global keyboard shortcuts for every enquirer prompt in the app.
//
//    Ctrl+Q  or  Ctrl+C   → quit the whole program gracefully, from any
//                           prompt screen, at any time.
//    Escape                → "back" inside a runWizard() step sequence (see
//                           tui/wizard.ts); everywhere else it safely
//                           returns to the calling screen instead of
//                           crashing (see note 2 below for why that was
//                           previously a real gap).
//
//  WHY THIS IS A PROTOTYPE PATCH, NOT A PER-CALL WRAPPER
//  ───────────────────────────────────────────────────────
//  `require("enquirer").prompt` looks like an ordinary function, but it's
//  produced by a class *getter* (`static get prompt()`) that builds and
//  returns a brand-new function + event emitter on every access. That means
//  every file's own `const { prompt } = require("enquirer")` holds a
//  completely separate, unrelated object — confirmed by testing, not just
//  reading the source: `require("enquirer").prompt !== require("enquirer").prompt`.
//  A listener attached to one such function is invisible to prompts created
//  through any other one, so there is no way to reach every prompt in this
//  codebase (prompts.ts, cookieManager.ts, configManager.ts, errors.ts,
//  index.ts, …) from a single listener attached that way.
//
//  `Enquirer.prototype.ask`, on the other hand, is one shared method that
//  every internal `Enquirer` instance uses to process each question —
//  regardless of which `prompt()` closure created that instance — because
//  method lookup goes through the prototype chain, not through whatever
//  produced the instance. Patching it once, here, at boot, reaches every
//  prompt in the app with zero changes needed at any individual call site.
//  (Also confirmed by direct testing: two independently-obtained `prompt`
//  functions both trigger a listener installed this way.)
//
//  Two more things worth flagging for anyone touching this file later,
//  since both were easy to get wrong from reading the source alone and
//  needed to be confirmed by actually exercising the library:
//
//   1. `keypress.action()` computes `{ ...combos, ...customActions }` — a
//      SHALLOW merge — so passing `actions.ctrl` REPLACES enquirer's whole
//      built-in ctrl map instead of extending it. CTRL_ACTIONS below is a
//      full copy of enquirer@2.4.1's lib/combos.js ctrl map (plus our own
//      `q` and a repointed `c`) for exactly this reason; trimming it down
//      to "just the new bindings" would silently break Ctrl+A/W/U/etc.
//      everywhere.
//   2. Escape is already bound to the built-in "cancel" action by default,
//      so it needs no patching at all. But `cancel()` sets
//      `state.submitted = true` *before* computing what the rejection value
//      should be, and the default `error()` is
//      `!state.submitted ? (err || state.error) : ''` — so despite
//      appearances, a cancelled prompt's promise ALWAYS rejects with a bare
//      empty string, never the key that was pressed or an Error object.
//      CANCEL_SIGNAL below is that empty string.
//
//  Pin the enquirer dependency and re-check this file (ideally by running
//  the same kind of direct test, not just reading the new source) if it's
//  ever upgraded — none of the above is documented public API.
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Enquirer = require("enquirer");

// See note 2 above. Anything that reaches `step()` in tui/wizard.ts with
// exactly this value is treated as "the user pressed Escape".
export const CANCEL_SIGNAL = "";

// Copied verbatim from enquirer@2.4.1's lib/combos.js `exports.ctrl` — see
// note 1 above — with two changes: `q` is added (unbound by default, so
// nothing existing is lost) and `c` is repointed from its default
// `'cancel'` to our own `'quit'`, so Ctrl+C behaves identically to Ctrl+Q
// everywhere, including mid-prompt. Previously, Ctrl+C during an active
// prompt just rejected *that one prompt* with an unrecognisable value
// instead of shutting the program down — the SIGINT handler in index.ts
// only ever saw Ctrl+C while no prompt was reading the keyboard (e.g.
// during the chapter-download progress bar).
const CTRL_ACTIONS: Record<string, string> = {
  a: "first",
  b: "backward",
  c: "quit",
  d: "deleteForward",
  e: "last",
  f: "forward",
  g: "reset",
  i: "tab",
  k: "cutForward",
  l: "reset",
  n: "newItem",
  m: "cancel",
  j: "submit",
  p: "search",
  r: "remove",
  s: "save",
  u: "undo",
  w: "cutLeft",
  x: "toggleCursor",
  v: "paste",
  q: "quit",
};

interface PatchedPromptOptions {
  actions?: { ctrl?: Record<string, string>; [k: string]: unknown };
  quit?: (input: unknown, key: { name?: string; ctrl?: boolean }) => unknown;
  [k: string]: unknown;
}

interface PromptLike {
  options: PatchedPromptOptions;
  stop?: () => void;
}

let installed = false;

/**
 * Call once at boot, before the first prompt is shown (there's no strict
 * ordering requirement beyond that — see the module comment for why a
 * single call here is enough to cover the whole app).
 *
 * `onQuit` is invoked with a short label ("Ctrl+Q" / "Ctrl+C") purely for
 * the shutdown message, and is expected to close browsers, flush any
 * in-flight session checkpoint, and exit the process — mirroring exactly
 * what the existing SIGINT/SIGTERM handlers already do.
 */
export function installKeyHandling(
  onQuit: (label: string) => void | Promise<void>,
): void {
  if (installed) return;
  installed = true;

  const originalAsk = Enquirer.prototype.ask;

  Enquirer.prototype.ask = function patchedAsk(
    this: { __wizardKeysInstalled?: boolean; on: (e: string, fn: (p: PromptLike) => void) => void },
    question: unknown,
  ) {
    if (!this.__wizardKeysInstalled) {
      this.__wizardKeysInstalled = true;
      this.on("prompt", (p: PromptLike) => {
        const existing = p.options.actions ?? {};
        p.options.actions = {
          ...existing,
          ctrl: { ...(existing.ctrl ?? {}), ...CTRL_ACTIONS },
        };

        p.options.quit = async function (
          this: PromptLike,
          _input: unknown,
          key: { name?: string; ctrl?: boolean },
        ) {
          // Deliberately bypass this.cancel()/close() — those reject the
          // pending prompt() promise, which would race the process.exit()
          // inside onQuit() against whatever catch block that rejection
          // unwinds into. `stop` is the exact function enquirer itself
          // installs to restore the terminal's raw mode and stop reading
          // keystrokes (lib/prompt.js `start()`), so calling it directly
          // leaves the terminal clean with none of that risk.
          try {
            this.stop?.();
          } catch {
            /* already stopped — fine */
          }
          const label = key?.ctrl && key.name === "c" ? "Ctrl+C" : "Ctrl+Q";
          await onQuit(label);
        };
      });
    }
    return originalAsk.call(this, question);
  };
}
