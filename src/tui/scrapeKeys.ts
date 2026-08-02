// ─────────────────────────────────────────────────────────────────────────────
//  A single-key 'q' (or Ctrl+C) quit shortcut for the one part of the app
//  where no enquirer prompt is reading the keyboard: the chapter-download
//  progress bar. tui/keys.ts already covers every prompt screen; this
//  covers the gap between them.
//
//  Putting stdin in raw mode here means the terminal driver's own SIGINT
//  generation for Ctrl+C is disabled for as long as this is installed
//  (raw mode always disables that — it's why enquirer needs to handle
//  Ctrl+C itself too), so this listener explicitly re-implements "Ctrl+C
//  quits" itself rather than relying on the existing SIGINT handler, which
//  would otherwise silently stop firing for the duration of a scrape.
//
//  Always paired with its teardown function via try/finally at the call
//  site, and additionally self-restores on the process's 'exit' event as a
//  safety net for the one path that can't reach that finally block: the
//  quit key itself calling process.exit() from inside the keypress handler.
//  Without that second safety net, a crash or forced exit here would leave
//  the user's shell in raw mode (no echo, broken arrow keys) until they ran
//  `reset`/`stty sane`.
// ─────────────────────────────────────────────────────────────────────────────

import readline from "readline";

export function installScrapeQuitKey(
  onQuit: (label: string) => void,
): () => void {
  const { stdin } = process;
  if (!stdin.isTTY) return () => {}; // non-interactive (piped/CI) — nothing to hook

  const wasRaw = stdin.isRaw;
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);

  const restore = () => {
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
  };

  let fired = false;
  const onKey = (
    _str: string,
    key: { name?: string; ctrl?: boolean } = {},
  ) => {
    if (fired) return;
    if (key.name === "q") {
      fired = true;
      onQuit("'q' key");
    } else if (key.ctrl && key.name === "c") {
      fired = true;
      onQuit("Ctrl+C");
    }
  };

  stdin.on("keypress", onKey);
  process.once("exit", restore);

  return () => {
    stdin.removeListener("keypress", onKey);
    process.removeListener("exit", restore);
    restore();
  };
}
