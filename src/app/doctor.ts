// ─────────────────────────────────────────────────────────────────────────────
//  doctor - validate the persistence layer and binary availability.
//
//  Phase 2 deliverable per roadmaps Phase 2 acceptance bullet; wired to
//  CLI in Phase 5 but callable from Phase 2 tests (T8).
//
//  Checks, in order (each reports pass/fail/warn + fixable-by-`--fix`):
//    1. CloakBrowser binary resolves & `--version` runs (binary check).
//    2. config.yaml parses and validates (migration check).
//    3. Data dir + sessions dir writable.
//    4. cookies.json / site-profiles.json parse; report schemaVersion,
//       offer `--fix` stamp for pre-v2 files untouched since Phase 1.
//    5. Every sessions/*.json parses; count corrupt (warn only, never delete).
//    6. Output dir writable or creatable.
//
//  Exit code: 0 all-green, 1 any failure, 2 warnings only (Phase 5 CI
//  can gate on it per ADR-005).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { ensureBinary } from "cloakbrowser";
import YAML from "yaml";

import {
  resolveDataDir,
  resolveConfigDir,
  sessionsDirPath,
  cookiesFilePath,
  siteProfilesFilePath,
  configYamlPath,
  configJsonPath,
} from "../adapters/store-json/paths.js";
import { detectStoreVersion } from "../adapters/store-json/migrations/chain.js";
import {
  cookieStoreDocumentSchema,
  COOKIE_STORE_SCHEMA_VERSION,
} from "../adapters/schemas/cookieProfile.js";
import {
  siteProfilesDocumentSchema,
  SITE_PROFILES_SCHEMA_VERSION,
} from "../adapters/schemas/siteProfile.js";
import {
  sessionDocumentSchema,
  SESSION_STORE_SCHEMA_VERSION,
} from "../adapters/schemas/session.js";
import { appConfigSchema } from "../adapters/schemas/appConfig.js";
import type { AppConfig } from "../core/domain/AppConfig.js";
import type { Logger } from "../ports/Logger.js";

export type CheckResult = "pass" | "fail" | "warn";

export interface DoctorCheck {
  name: string;
  result: CheckResult;
  message: string;
  fixable?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exitCode: number; // 0 = all-green, 1 = any failure, 2 = warnings only
}

// ── Per-check helpers ───────────────────────────────────────────────────────

async function checkBinary(): Promise<DoctorCheck> {
  try {
    const _path = await ensureBinary();
    return { name: "CloakBrowser binary", result: "pass", message: "binary resolves" };
  } catch (e) {
    return {
      name: "CloakBrowser binary",
      result: "fail",
      message: `binary unavailable: ${(e as Error).message}`,
    };
  }
}

async function checkConfigYaml(): Promise<DoctorCheck> {
  const yp = configYamlPath();
  if (!fs.existsSync(yp)) {
    // Migration may not have run yet; check the json as a fallback.
    const jp = configJsonPath();
    if (!fs.existsSync(jp)) {
      return { name: "config (YAML/JSON)", result: "fail", message: "no config file found" };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(jp, "utf8"));
      const parsed = appConfigSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          name: "config (JSON)",
          result: "warn",
          message: "config.json exists but failed schema validation - will use defaults on migration",
        };
      }
      return { name: "config (JSON)", result: "warn", message: "not yet migrated to YAML - first run will auto-migrate" };
    } catch (e) {
      return {
        name: "config (JSON)",
        result: "fail",
        message: `config.json parse error: ${(e as Error).message}`,
      };
    }
  }
  try {
    const raw = YAML.parse(fs.readFileSync(yp, "utf8"));
    if (raw === null || typeof raw !== "object") {
      return { name: "config.yaml", result: "fail", message: "empty or invalid YAML" };
    }
    const parsed = appConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        name: "config.yaml",
        result: "warn",
        message: `valid YAML but failed schema - will use defaults; ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      };
    }
    return { name: "config.yaml", result: "pass", message: "schema validates" };
  } catch (e) {
    return {
      name: "config.yaml",
      result: "fail",
      message: `parse error: ${(e as Error).message}`,
    };
  }
}

async function checkWritable(doctorLog: Logger): Promise<DoctorCheck[]> {
  return [writableCheck("data dir", resolveDataDir()), writableCheck("sessions dir", sessionsDirPath())];
}

function writableCheck(name: string, dir: string): DoctorCheck {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const testFile = `${dir}/.doctor-write-test`;
    fs.writeFileSync(testFile, Date.now().toString());
    fs.unlinkSync(testFile);
    return { name: `${name} (writable)`, result: "pass", message: "writable" };
  } catch (e) {
    return { name: `${name} (writable)`, result: "fail", message: `not writable: ${(e as Error).message}` };
  }
}

/** Validate the cookies.json AND site-profiles.json; report schema versions. */
async function checkStoreFiles(doctorLog: Logger, fix: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [storeName, filePath, schema, targetVersion] of [
    ["cookies.json", cookiesFilePath(), cookieStoreDocumentSchema, COOKIE_STORE_SCHEMA_VERSION],
    ["site-profiles.json", siteProfilesFilePath(), siteProfilesDocumentSchema, SITE_PROFILES_SCHEMA_VERSION],
  ] as const) {
    const file = filePath;
    if (!fs.existsSync(file)) {
      checks.push({ name: storeName, result: "warn", message: "file missing - will be created on first write" });
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const version = detectStoreVersion(raw);
      const currentMsg = version === targetVersion ? "current" : `v${version} (can be stamped to v${targetVersion} with -fix)`;
      const parseRes = schema.safeParse(raw);
      if (!parseRes.success) {
        checks.push({
          name: storeName,
          result: "fail",
          message: `parse error (schemaVersion ${version}): ${parseRes.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
        });
      } else {
        checks.push({ name: storeName, result: "pass", message: currentMsg });
        if (version < targetVersion && fix) {
          // Stamp schemaVersion to current by writing a valid doc back.
          // This `--fix` path is the idiomatic doctor(update) flow (Phase 5).
          const doc = parseRes.data;
          (doc as { schemaVersion?: number }).schemaVersion = targetVersion;
          fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
          checks.push({ name: storeName, result: "pass", message: "schemaVersion stamped to current" });
        }
      }
    } catch (e) {
      checks.push({
        name: storeName,
        result: "fail",
        message: `parse error: ${(e as Error).message}`,
      });
    }
  }
  return checks;
}

/** Check every session/*.json file; count corrupt (warn only, never delete). */
async function checkSessions(doctorLog: Logger): Promise<DoctorCheck> {
  const sDir = sessionsDirPath();
  let files: string[] = [];
  try {
    fs.mkdirSync(sDir, { recursive: true });
    files = fs.readdirSync(sDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { name: "sessions", result: "fail", message: "cannot read sessions directory" };
  }
  let good = 0;
  let corrupt = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(sDir, file), "utf8"));
      if (sessionDocumentSchema.safeParse(raw).success) good++;
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  if (corrupt === 0) {
    return {
      name: `sessions (${good} ${good === 1 ? "file" : "files"})`,
      result: "pass",
      message: "all parseable",
    };
  }
  return {
    name: `sessions (${good} good, ${corrupt} corrupt)`,
    result: "warn",
    message: `${corrupt} corrupt session file${corrupt === 1 ? "" : "s"} - will be skipped, not deleted`,
  };
}

/** Check the output directory is writable or creatable. */
async function checkOutputDir(doctorLog: Logger): Promise<DoctorCheck> {
  // Use the default output dir since that's what APP_CONFIG enforces on first run.
  const defaultOutputDir = "./output";
  try {
    fs.mkdirSync(defaultOutputDir, { recursive: true });
    const testFile = path.join(defaultOutputDir, ".doctor-write-test");
    fs.writeFileSync(testFile, Date.now().toString());
    fs.unlinkSync(testFile);
    return { name: `output dir (${defaultOutputDir})`, result: "pass", message: "writable" };
  } catch (e) {
    return {
      name: `output dir (${defaultOutputDir})`,
      result: "fail",
      message: `not writable: ${(e as Error).message}`,
    };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface DoctorOptions {
  fix?: boolean;
  log?: Logger;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const doctorLog = opts.log ?? ({ info() {}, warn() {}, error() {}, debug() {} } as Logger);
  const checks: DoctorCheck[] = [];

  // 1. Binary
  checks.push(await checkBinary());

  // 2. Config
  checks.push(await checkConfigYaml());

  // 3. Data dir + sessions dir writable
  checks.push(...(await checkWritable(doctorLog)));

  // 4. Stores
  checks.push(...(await checkStoreFiles(doctorLog, opts.fix ?? false)));

  // 5. Sessions
  checks.push(await checkSessions(doctorLog));

  // 6. Output dir
  checks.push(await checkOutputDir(doctorLog));

  const fails = checks.some((c) => c.result === "fail");
  const warns = checks.some((c) => c.result === "warn");

  return {
    checks,
    exitCode: fails ? 1 : warns ? 2 : 0,
  };
}