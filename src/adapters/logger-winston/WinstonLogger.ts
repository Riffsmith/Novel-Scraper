// ─────────────────────────────────────────────────────────────────────────────
//  WinstonLogger — wraps the existing src/logger/index.ts winston instance
//  behind our Logger port. Core services receive this via DI, not via import.
// ─────────────────────────────────────────────────────────────────────────────

import type { Logger } from "../../ports/Logger.js";

export function createWinstonLogger(winstonLike: {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}): Logger {
  return {
    debug: (msg, meta) => winstonLike.debug(msg, meta ?? {}),
    info: (msg, meta) => winstonLike.info(msg, meta ?? {}),
    warn: (msg, meta) => winstonLike.warn(msg, meta ?? {}),
    error: (msg, meta) => winstonLike.error(msg, meta ?? {}),
  };
}