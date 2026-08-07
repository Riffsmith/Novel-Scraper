// ─────────────────────────────────────────────────────────────────────────────
//  createSilentLogger - Logger port implementation that drops every message.
//
//  Phase 5 §1.4 / T11: under --json the ONLY stdout output is the JSON
//  envelope (no chalk codes, no interleaved progress). The winston logger
//  writes a pretty console line per info/warn via its Console transport,
//  which would interleave with - and invalidate - the envelope. The CLI
//  commands swap to this silent logger under --json so every event lands in
//  the JSON envelope, never on stdout/stderr mid-run. The on-disk winston
//  logs (logs/*.log) are still written elsewhere when collect-only mode is
//  desired; for the scriptable CLI contract this is correct.
// ─────────────────────────────────────────────────────────────────────────────

import type { Logger } from "../../ports/Logger.js";

export function createSilentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
