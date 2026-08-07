// ─────────────────────────────────────────────────────────────────────────────
//  cliCommands/doctorCmd.ts - `wnscrape doctor [--json] [--fix]`
//
//  §1.5 / §2.6: pure wiring. `app/doctor.ts:runDoctor()` (Phase 2) already
//  returns the DoctorReport; this is the human renderer + JSON envelope.
//  No new logic.
// ─────────────────────────────────────────────────────────────────────────────

import { runDoctor } from "../doctor.js";
import type { DoctorCheck, DoctorReport } from "../doctor.js";
import { createWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
import { createSilentLogger } from "../../adapters/cli-json/silentLogger.js";
import logger from "../../logger/index.js";
import type { Logger } from "../../ports/Logger.js";

import { emitJson, type JsonResult } from "../../adapters/cli-json/envelope.js";
import type { GlobalCliOpts } from "./run.js";

function newLog(json?: boolean): Logger {
  // §1.4 / T11: under --json the winston console transport would interleave
  // pretty lines into the envelope - swap to a silent Logger port so the ONLY
  // stdout output is the JSON envelope itself.
  return json ? createSilentLogger() : createWinstonLogger(logger);
}

export async function doctorCommand(opts: { fix?: boolean } & GlobalCliOpts): Promise<void> {
  const command = "doctor";
  const log = newLog(opts.json === true);
  try {
    const report = await runDoctor({ fix: opts.fix ?? false, log });
    if (opts.json) {
      // §2.6: the envelope's `ok` mirrors `report.exitCode === 0` so a CI
      // `jq '.ok'` gate lines up with the process exit code. The full report
      // is carried on `data` regardless of pass/fail/warn so the consumer can
      // drill into the per-check breakdown of a non-zero exit (ADR-P5-D:
      // doctor widens the §1.8 strict "ok:false = error only" envelope by ALSO
      // carrying `data: report` alongside the canonical `error` summary).
      // The `error` here is a one-line summary; `data.checks` is the audit log.
      const exitCodeToSummary: Record<number, { code: string; message: string }> = {
        0: { code: "DOCTOR_PASS", message: "all checks pass" },
        1: { code: "DOCTOR_FAIL", message: "one or more checks failed" },
        2: { code: "DOCTOR_WARN", message: "warnings only" },
      };
      const summary: { code: string; message: string } = exitCodeToSummary[report.exitCode] ?? exitCodeToSummary[1]!;
      // The outgoing envelope widens §1.8's strict shape per ADR-P5-D: doctor
      // carries `data: report` ALWAYS (so `jq '.data.checks'` works regardless
      // of exit code) and only switches the discriminator on the result. The
      // optional `data` slot on `jsonErrSchema` (envelope.ts) makes this round-
      // trip without a cast.
      const envelope: JsonResult = report.exitCode === 0
        ? { ok: true, command, data: report }
        : { ok: false, command, error: summary, data: report };
      emitJson(envelope);
      process.exit(report.exitCode);
      return;
    }
    renderDoctorHuman(report);
    process.exit(report.exitCode);
  } catch (e) {
    if (opts.json) {
      emitJson({
        ok: false,
        command,
        error: { code: "DOCTOR_FAILED", message: (e as Error).message },
      });
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── Human-readable renderer ───────────────────────────────────────────────────
//
//  §2.6: chalk is fine on the human path (it never runs under --json - JSON
//  output never carries ANSI codes per §1.4 / ADR-P5-C).

function renderDoctorHuman(report: DoctorReport): void {
  for (const check of report.checks) {
    renderCheck(check);
  }
  const codeStr = report.exitCode === 0 ? "all green" : report.exitCode === 2 ? "warnings only" : "failures";
  console.log(``);
  console.log(`doctor: ${codeStr} (exit ${report.exitCode})`);
}

function renderCheck(check: DoctorCheck): void {
  const tag =
    check.result === "pass" ? "pass" : check.result === "warn" ? "warn" : "fail";
  const suffix = check.fixable ? " (fixable with --fix)" : "";
  console.log(`[${tag}] ${check.name}: ${check.message}${suffix}`);
}
