// ─────────────────────────────────────────────────────────────────────────────
//  WinstonLogger — builds and wraps a winston instance behind our Logger port.
//
//  Core services receive a Logger via DI, never a winston import. Two exports:
//
//    createWinstonLogger(winstonLike)        Thin DI wrapper around an externally
//                                            built {debug,info,warn,error} object.
//    createDefaultWinstonLogger()            Builds the winston instance using the
//                                            canonical config (rotating files,
//                                            exception/rejection handlers, chalk
//                                            pretty-print, LOG_LEVEL env, logs/ dir).
//                                            Returns a Logger directly.
// ─────────────────────────────────────────────────────────────────────────────

import winston from "winston";
import chalk from "chalk";
import fs from "fs";
import path from "path";

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

// ── Level → colour mapping ──────────────────────────────────────────────────
const LEVEL_STYLES: Record<string, (s: string) => string> = {
  error: (s) => chalk.bold.red(s),
  warn: (s) => chalk.bold.yellow(s),
  info: (s) => chalk.cyan(s),
  verbose: (s) => chalk.magenta(s),
  debug: (s) => chalk.gray(s),
  silly: (s) => chalk.white(s),
};

// ── Pretty console format ───────────────────────────────────────────────────
const consoleFormat = winston.format.printf(
  ({
    level,
    message,
    timestamp,
    ...meta
  }: {
    level: string;
    message: unknown;
    timestamp?: unknown;
    [k: string]: unknown;
  }) => {
    const colorFn = LEVEL_STYLES[level] ?? ((s: string) => s);
    const ts = chalk.dim(String(timestamp));
    const lvl = colorFn(`[${level.toUpperCase().padEnd(7)}]`);
    const msg = typeof message === "string" ? message : JSON.stringify(message);
    const extra = Object.keys(meta).length ? chalk.dim(" " + JSON.stringify(meta)) : "";
    return `${ts} ${lvl} ${msg}${extra}`;
  },
);

// ── JSON format for files ──────────────────────────────────────────────────
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/**
 * Build the canonical winston instance and return it wrapped behind the Logger
 * port. Called once per command invocation in the CLI, once per TUI boot. The
 * exception/rejection handlers are registered at factory-call time, which is
 * AFTER `cli.parse(argv)` has already run sync - so the handlers never swallow
 * a cac parse error (cli.ts still wraps `cli.parse()` in its own try/catch for
 * that reason). See ADR-P6-B.
 */
export function createDefaultWinstonLogger(): Logger {
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const instance = winston.createLogger({
    level: (process as NodeJS.Process).env["LOG_LEVEL"] ?? "info",
    exitOnError: false,

    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp({ format: "HH:mm:ss" }),
          consoleFormat,
        ),
      }),

      new winston.transports.File({
        filename: path.join(logsDir, "error.log"),
        level: "error",
        format: fileFormat,
        maxsize: 5_242_880,
        maxFiles: 3,
      }),

      new winston.transports.File({
        filename: path.join(logsDir, "combined.log"),
        format: fileFormat,
        maxsize: 10_485_760,
        maxFiles: 5,
      }),
    ],

    exceptionHandlers: [
      new winston.transports.File({
        filename: path.join(logsDir, "exceptions.log"),
      }),
    ],

    rejectionHandlers: [
      new winston.transports.File({
        filename: path.join(logsDir, "rejections.log"),
      }),
    ],
  });

  return createWinstonLogger(instance);
}
