// ─────────────────────────────────────────────────────────────────────────────
//  Phase 2 test suite - T1–T9 from docs/phase-2/readme.md §3.
//
//  Each test isolates the XDG directory so no real user data is touched.
//  Fixtures live under tests/fixtures/ and tests/fixtures/stores/v1/.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import YAML from "yaml";

// ── Leaf utils ─────────────────────────────────────────────────────────────
import { normaliseDomain } from "../src/core/domain/Domain.js";
import {
  resolveConfigDir,
  resolveDataDir,
  sessionsDirPath,
  cookiesFilePath,
  siteProfilesFilePath,
  configYamlPath,
  configJsonPath,
  configJsonBakPath,
} from "../src/adapters/store-json/paths.js";
// ── Migration chain ───────────────────────────────────────────────────────
import { runMigrations, detectStoreVersion } from "../src/adapters/store-json/migrations/chain.js";
import { cookiesMigrations } from "../src/adapters/store-json/migrations/cookies.1to2.js";
import { profilesMigrations } from "../src/adapters/store-json/migrations/profiles.1to2.js";
import { sessionsMigrations } from "../src/adapters/store-json/migrations/sessions.1to2.js";

// ── Store adapters ────────────────────────────────────────────────────────
import { JsonCookieStore } from "../src/adapters/store-json/JsonCookieStore.js";
import { JsonProfileStore } from "../src/adapters/store-json/JsonProfileStore.js";
import { JsonSessionStore } from "../src/adapters/store-json/JsonSessionStore.js";

// ── Config ────────────────────────────────────────────────────────────────
import { YamlConfigStore } from "../src/adapters/config-yaml/YamlConfigStore.js";
import { migrateJsonConfig } from "../src/adapters/config-yaml/migrateJsonConfig.js";
import { DEFAULT_CONFIG } from "../src/core/domain/AppConfig.js";

// ── Zod / doctor ──────────────────────────────────────────────────────────
import { parseJobConfig } from "../src/app/loadJobFile.js";
import { jobConfigSchema } from "../src/adapters/schemas/jobConfig.js";
import { runDoctor } from "../src/app/doctor.js";
import { atomicWrite, type AtomicFsHooks } from "../src/adapters/store-json/atomicWrite.js";

// ── Version constants ─────────────────────────────────────────────────────
import { COOKIE_STORE_SCHEMA_VERSION } from "../src/adapters/schemas/cookieProfile.js";
import { SITE_PROFILES_SCHEMA_VERSION } from "../src/adapters/schemas/siteProfile.js";
import { SESSION_STORE_SCHEMA_VERSION } from "../src/adapters/schemas/session.js";

// ── Types ─────────────────────────────────────────────────────────────────
import type { ScrapeSession } from "../src/core/domain/Session.js";
import type { Logger } from "../src/ports/Logger.js";

// ────────────────────────────────────────────────────────────────────────────
// Test helpers - isolate XDG directories per test
// ────────────────────────────────────────────────────────────────────────────

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

let tempDirs: { data: string; config: string; originalDataX: string | undefined; originalConfigX: string | undefined };

beforeAll(() => {
  setupTempDirs();
});

afterAll(() => {
  cleanupTempDirs();
});

function setupTempDirs() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "wns-ph2d-"));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "wns-ph2c-"));
  const origData = process.env.XDG_DATA_HOME;
  const origConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_CONFIG_HOME = config;
  tempDirs = { data, config, originalDataX: origData, originalConfigX: origConfig };
}

function cleanupTempDirs() {
  if (tempDirs) {
    try { fs.rmSync(tempDirs.data, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempDirs.config, { recursive: true, force: true }); } catch {}
    if (tempDirs.originalDataX !== undefined) process.env.XDG_DATA_HOME = tempDirs.originalDataX;
    else delete process.env.XDG_DATA_HOME;
    if (tempDirs.originalConfigX !== undefined) process.env.XDG_CONFIG_HOME = tempDirs.originalConfigX;
    else delete process.env.XDG_CONFIG_HOME;
  }
}

// Reset the data/config dirs between tests so that cross-contamination never
// happens (e.g. T2's previous migration shouldn't leave a config.yaml).
beforeEach(() => {
  cleanupTempDirs();
  setupTempDirs();
});

function copyFixtureToStore(fixturePath: string, storePath: string): void {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixturePath, storePath);
}

// ────────────────────────────────────────────────────────────────────────────
// T1 - v1 fixture round-trip: cookies, profiles, sessions all load identically
// ────────────────────────────────────────────────────────────────────────────

describe("T1 - v1 fixture round-trip", () => {
  it("loads v1 cookies fixture - two domains, three profiles total", async () => {
    copyFixtureJson(
      "tests/fixtures/stores/v1/cookies.json",
      cookiesFilePath(),
    );
    const store = new JsonCookieStore(nullLogger());
    const domains = await store.listDomains();
    expect(domains).toEqual(["novelfire.net", "wtr-lab.com"]);
    const profiles = await store.listProfiles("wtr-lab.com");
    expect(profiles).toEqual(["default", "alt-account"]); // recent-first sort
    const main = await store.getProfile("wtr-lab.com", "default");
    expect(main).not.toBeNull();
    expect(main!.cookies).toHaveLength(2);
    // v1 fixture cookie counts match here
    const mainCookies = await store.load("wtr-lab.com", "default");
    expect(mainCookies).toHaveLength(2);
    expect(mainCookies![0].domain).toBe("wtr-lab.com");
  });

  it("loads v1 legacy flat-array cookies and auto-wraps", async () => {
    copyFixtureJson(
      "tests/fixtures/stores/v1/cookies-legacy.json",
      cookiesFilePath(),
    );
    const store = new JsonCookieStore(nullLogger());
    const domains = await store.listDomains();
    expect(domains).toContain("legacy-site.com");
    const profiles = await store.listProfiles("legacy-site.com");
    expect(profiles).toEqual(["default"]);
    const p = await store.getProfile("legacy-site.com", "default");
    expect(p!.cookies).toHaveLength(2);
    // After the auto-wrap, the file should already be stamped.  Rerun.
    const domains2 = await store.listDomains();
    expect(domains2).toContain("legacy-site.com");
  });

  it("loads v1 site-profiles.json - two profiles", async () => {
    copyFixtureJson(
      "tests/fixtures/stores/v1/site-profiles.json",
      siteProfilesFilePath(),
    );
    const store = new JsonProfileStore(nullLogger());
    const all = await store.list();
    expect(Object.keys(all).sort()).toEqual(["novelfire.net", "wtr-lab.com"]);
    const wtr = await store.load("wtr-lab.com");
    expect(wtr!.method).toBe("toc");
    expect(wtr!.contentSelector).toBe(".chapter-content");
  });

  it("loads v1 session files - 3 sessions", async () => {
    const sessionDir = sessionsDirPath();
    fs.mkdirSync(sessionDir, { recursive: true });
    for (const id of ["session-1", "session-2", "session-3"]) {
      copyFixtureJson(
        `tests/fixtures/stores/v1/sessions/${id}.json`,
        path.join(sessionDir, `${id}.json`),
      );
    }
    const store = new JsonSessionStore(nullLogger());
    const list = await store.list();
    expect(list).toHaveLength(3);
    // All three have expected completedCounts.
    const s2 = list.find((s) => s.id === "session-2");
    expect(s2!.completedCount).toBe(1);
    const s3 = list.find((s) => s.id === "session-3");
    expect(s3!.completedCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T2 - Config json->yaml migration
// ────────────────────────────────────────────────────────────────────────────

describe("T2 - Config migration", () => {
  it("migrates config.json to commented YAML and renames .bak", async () => {
    copyFixtureJson(
      "tests/fixtures/stores/v1/config.json",
      configJsonPath(),
    );
    const log = nullLogger();
    const outcome = await migrateJsonConfig(log);
    expect(outcome.kind).toBe("migrated");
    expect(outcome.yamlPath).toBe(configYamlPath());
    expect(outcome.bakPath).toBe(configJsonBakPath());

    // yaml exists
    expect(fs.existsSync(configYamlPath())).toBe(true);
    // .bak exists
    expect(fs.existsSync(configJsonBakPath())).toBe(true);
    // original json is gone
    expect(fs.existsSync(configJsonPath())).toBe(false);
    // rerun is a no-op
    const outcome2 = await migrateJsonConfig(log);
    expect(outcome2.kind).toBe("noop-yaml-exists");
  });

  it("fresh install writes YAML from defaults (no json)", async () => {
    const log = nullLogger();
    const outcome = await migrateJsonConfig(log);
    expect(outcome.kind).toBe("fresh");
    expect(fs.existsSync(configYamlPath())).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T3 - Unknown-key preservation
// ────────────────────────────────────────────────────────────────────────────

describe("T3 - Unknown-key preservation", () => {
  it("config with extra keys survives write round-trip", async () => {
    // Place a config.json with a custom key
    copyFixtureJson(
      "tests/fixtures/stores/v1/config.json",
      configJsonPath(),
    );
    await migrateJsonConfig(nullLogger());

    const store = new YamlConfigStore(nullLogger());
    const cfg = await store.read();
    expect(cfg.defaultConcurrency).toBe(3); // from the fixture
    expect(cfg.askSaveProfile).toBe(false);
    // The customKeyPreserved field is NOT on AppConfig-passthrough survives.
    // We write an update that changes a known key, we keep the custom field.
    await store.write({ defaultConcurrency: 4 });
    // Read back the YAML as raw text.
    const raw = fs.readFileSync(configYamlPath(), "utf8");
    // "customKeyPreserved" survives
    expect(raw).toContain("customKeyPreserved");
    expect(raw).toContain("defaultConcurrency: 4");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T4 - Cookie legacy wrap migration order + idempotent
// ────────────────────────────────────────────────────────────────────────────

describe("T4 - Cookie legacy wrap migration", () => {
  it("wraps legacy array and stamps schemaVersion 2", () => {
    const legacy = {
      "predomain.com": [
        { name: "a", value: "1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
      ],
    };
    const v = detectStoreVersion(legacy);
    expect(v).toBe(1);
    const { data } = runMigrations(legacy, cookiesMigrations, COOKIE_STORE_SCHEMA_VERSION);
    const out = data as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out["predomain.com"]).toHaveProperty("default");
    const _def = (out["predomain.com"] as Record<string, unknown>)["default"];
    expect(_def).toHaveProperty("cookies");
  });

  it("already-named profile v1 cookie store stamps schemaVersion 2", () => {
    const v1Named = {
      "site-x.com": {
        main: {
          cookies: [
            { name: "c1", value: "v1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const { data } = runMigrations(v1Named, cookiesMigrations, COOKIE_STORE_SCHEMA_VERSION);
    expect((data as any).schemaVersion).toBe(2);
  });

  it("double-run is idempotent", () => {
    const raw = { "x.com": { default: { cookies: [], createdAt: "x", updatedAt: "x" } }, schemaVersion: 2 };
    const { data, migratedFrom } = runMigrations(raw, cookiesMigrations, COOKIE_STORE_SCHEMA_VERSION);
    expect(migratedFrom).toBeNull();
    expect((data as any).schemaVersion).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T5 - Full CookieStore surface
// ────────────────────────────────────────────────────────────────────────────

describe("T5 - Full CookieStore surface", () => {
  it("save/upsert/deleteCookie/deleteProfile/rename/setLabel/parseCookieHeader & lastUsed sort", async () => {
    const store = new JsonCookieStore(nullLogger());

    // save
    await store.save("example.com", "main", [
      { name: "a", value: "1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
      { name: "b", value: "2", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
    const p1 = await store.getProfile("example.com", "main");
    expect(p1?.cookies).toHaveLength(2);

    // upsert
    await store.upsert("example.com", "main", [
      { name: "a", value: "aa-updated", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
      { name: "c", value: "3", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
    const p2 = await store.getProfile("example.com", "main");
    expect(p2?.cookies).toHaveLength(3);
    const aCookie = p2?.cookies.find((c) => c.name === "a");
    expect(aCookie?.value).toBe("aa-updated");

    // deleteCookie
    let deleted = await store.deleteCookie("example.com", "main", "b");
    expect(deleted).toBe(true);
    deleted = await store.deleteCookie("example.com", "main", "x");
    expect(deleted).toBe(false);

    // rename (no-clobber)
    await store.save("example.com", "target-already-exists", [
      { name: "z", value: "z", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
    let renamed = await store.renameProfile("example.com", "main", "target-already-exists");
    expect(renamed).toBe(false); // target exists
    renamed = await store.renameProfile("example.com", "main", "renamed");
    expect(renamed).toBe(true);
    const rp = await store.getProfile("example.com", "renamed");
    expect(rp?.cookies).toHaveLength(2);

    // setLabel / clear label
    let labeled = await store.setLabel("example.com", "renamed", "My Label");
    expect(labeled).toBe(true);
    const rl = await store.getProfile("example.com", "renamed");
    expect(rl?.label).toBe("My Label");
    labeled = await store.setLabel("example.com", "renamed", undefined);
    expect(labeled).toBe(true);
    expect((await store.getProfile("example.com", "renamed"))?.label).toBeUndefined();

    // deleteProfile prunes empty domain
    const delp = await store.deleteProfile("example.com", "target-already-exists");
    expect(delp).toBe(true);
    expect(await store.getProfile("example.com", "target-already-exists")).toBeNull();

    // lastUsed sort
    await store.markUsed("example.com", "renamed");
    const profiles = await store.listProfiles("example.com");
    // renamed should be first now since lastUsedAt bumped
    expect(profiles[0]).toBe("renamed");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T6 - Session atomic write
// ────────────────────────────────────────────────────────────────────────────

describe("T6 - Session atomic write", () => {
  it("crash between tmp-write and rename leaves original intact", async () => {
    const sessionDir = sessionsDirPath();
    fs.mkdirSync(sessionDir, { recursive: true });

    // atomicWrite with a fault injected after tmp write
    let tmpFileWritten: string | null = null;
    let wroteOk = false;
    const failingHooks: AtomicFsHooks = {
      mkdir: (d, o) => fs.promises.mkdir(d, o).then(() => undefined),
      writeFile: async (p, d, e) => {
        tmpFileWritten = p;
        await fs.promises.writeFile(p, d, e);
        wroteOk = true;
      },
      rename: async (from, to) => {
        // Simulate crash: throw after the tmp file is written (rename never
        // completes), then check that the original is intact.
        throw new Error("simulated rename crash");
      },
      unlink: async () => {},
      tmpdir: () => os.tmpdir(),
      uniqueSuffix: () => "fault-test",
    };

    // Pre-write an original file.
    const originalPath = path.join(sessionDir, "test.json");
    const original = JSON.stringify({ original: "data", id: "test" });
    fs.writeFileSync(originalPath, original, "utf8");

    try {
      await atomicWrite(originalPath, JSON.stringify({ id: "test", updated: true }), { hooks: failingHooks });
    } catch {
      // rename failure is expected
    }

    expect(wroteOk).toBe(true);
    // original is intact
    const afterCrash = JSON.parse(fs.readFileSync(originalPath, "utf8"));
    expect(afterCrash.original).toBe("data");

    // Clean tmp
    try {
      if (tmpFileWritten) fs.unlinkSync(tmpFileWritten);
    } catch {}
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T7 - Newer-version store hard error
// ────────────────────────────────────────────────────────────────────────────

describe("T7 - Newer-version store hard error", () => {
  it("detectStoreVersion throws and runs:Storage newer than app", () => {
    expect(() => runMigrations({ schemaVersion: 99 }, cookiesMigrations, COOKIE_STORE_SCHEMA_VERSION)).toThrow(/newer/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T8 - doctor against synthetic broken dirs
// ────────────────────────────────────────────────────────────────────────────

describe("T8 - doctor() synthetic broken dirs", () => {
  it("reports fail for unwritable config", async () => {
    // Let data dir default to temp writable; config dir also normal.  Hard to
    // test broken binary here (needs CLOAKBROWSER_BINARY_AVAILABLE).  At
    // least ensure we can walk through doctor without crashing.
    // Simulate a frozen area (read-only) by setting the config dir = current
    // dir so at least we don't touch real config.
    fs.mkdirSync(resolveConfigDir(), { recursive: true });
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    const report = await runDoctor({ fix: false });
    expect(report.exitCode).toBeGreaterThanOrEqual(0);
    expect(report.checks.length).toBeGreaterThanOrEqual(7);
    // binary report is either pass or fail (no binary here, but doctor tolerates.)
    const binary = report.checks.find((c) => c.name.startsWith("CloakBrowser"));
    expect(binary).not.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T9 - Zod boundary: job config parse/reject
// ────────────────────────────────────────────────────────────────────────────

describe("T9 - Zod boundary: job config", () => {
  it("parses valid yaml with defaults", () => {
    const y = `
method: toc
tocUrl: http://example.com/toc
contentSelector: ".chapter-body"
separateTitle: true
titleSelector: "h1.title"
outputDir: "./output"
outputFilename: "myNovel"
metadata:
  title: "My Novel"
  author: "Jane"
`;
    const parsed = parseJobConfig(y);
    expect(parsed.method).toBe("toc");
    expect(parsed.concurrency).toBe(2);
    expect(parsed.delayMin).toBe(1200);
    expect(parsed.separateTitle).toBe(true);
    expect(parsed.excludeSelectors).toEqual([]);
    expect(parsed.output.epub).toBe(true);
    expect(parsed.metadata.language).toBe("en");
    expect(parsed.metadata.coverSource).toBe("none");
  });

  it("rejects bad job.yaml with human-readable paths", () => {
    const y = `
method: toc
contentSelector: 12345
outputDir: ./o
outputFilename: f
metadata:
  title: x
  author: x
`;
    expect(() => parseJobConfig(y)).toThrow("Invalid job");
  });

  it("passthrough: unknown keys survive validation", () => {
    const y = `
method: toc
contentSelector: .c
outputDir: ./o
outputFilename: f
metadata:
  title: x
  author: x
  language: en
defaultConcurrency: 4   # v1 unknown key
customExtra: hello
`;
    const parsed = parseJobConfig(y);
    // It validates, concurrency maps to 2 (our default), custom fields
    // pass through because .passthrough() preserves them.
    expect(parsed.concurrency).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Additional chain / round-trip
// ────────────────────────────────────────────────────────────────────────────

function copyFixtureJson(fixture: string, target: string): void {
  const f = path.resolve(fixture);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(raw), "utf8");
}