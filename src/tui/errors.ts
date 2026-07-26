// ─────────────────────────────────────────────────────────────────────────────
//  Shared error / notice reporting for TUI flows.
//
//  disp.err()/disp.warn() output alone gets wiped almost instantly, because
//  whatever screen runs next calls banner() → console.clear(). These helpers
//  log to Winston AND block on an explicit keypress before continuing, so a
//  failure can never disappear before it's been read.
//
//  Extracted from index.ts (where these lived unexported) because the cookie
//  capture flow needs identical behavior for browser-launch/navigation
//  failures — better to share one copy than risk two drifting.
// ─────────────────────────────────────────────────────────────────────────────

import chalk from "chalk";
import logger from "../logger/index.js";
import * as disp from "./display.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require("enquirer");

export async function reportError(context: string, e: unknown): Promise<void> {
  const err = e as Error;
  logger.error(context, { error: err.message, stack: err.stack });

  console.log("");
  disp.err(`${context}: ${err.message}`);
  if (err.stack) disp.dim(err.stack.split("\n").slice(1, 5).join("\n"));
  console.log("");

  await _prompt({
    type: "input",
    name: "ack",
    message: chalk.dim("Press Enter to return to the main menu…"),
  }).catch(() => {});
}

export async function reportNotice(lines: string[]): Promise<void> {
  console.log("");
  lines.forEach((l) => disp.warn(l));
  console.log("");
  await _prompt({
    type: "input",
    name: "ack",
    message: chalk.dim("Press Enter to continue…"),
  }).catch(() => {});
}
