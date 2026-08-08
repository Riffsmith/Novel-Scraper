// ─────────────────────────────────────────────────────────────────────────────
//  Phase 6 — structural sweep (docs/phase-6/readme.md §3, items T5 + T8).
//
//  Codifies the repo-wide invariants that v1 source deletion + package.json
//  cleanup leave behind, so a future contributor can't regress them without a
//  red test. Source-tree walks are filesystem-only (no test imports a v2
//  module that scans at runtime) and assert on:
//    - ADR-001 repo-wide: no `from "playwright"` (non-core) anywhere in src/.
//    - the v1 logger path is gone (no `from "../logger"` / `./logger` /
//      `logger/index` imports in src/ or tests/).
//    - the v1 source tree is physically deleted (src/{tui,scraper,queue,epub,
//      sessions,cookies,sites,config,logger}/, src/index.ts, src/types.ts).
//    - package.json has no v1-only deps/scripts and reports v2.0.0.
//    - the three Phase 6 docs exist and are non-empty.
//
//  No network, no browser. Gated nothing: this test runs on every `pnpm test`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
type TSFile = string;

function walkTs(dir: string, out: TSFile[] = []): TSFile[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if ((e.isFile() && p.endsWith(".ts")) || p.endsWith(".tsx")) {
      if (!p.endsWith(".d.ts")) out.push(p);
    }
  }
  return out;
}

function srcTsFiles(): TSFile[] {
  return walkTs(SRC);
}

function allTsFiles(): TSFile[] {
  return [...srcTsFiles(), ...walkTs(path.join(ROOT, "tests"))];
}

async function readImports(files: TSFile[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const txt = await fs.promises.readFile(f, "utf8");
    for (const line of txt.split("\n")) {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      const m = line.match(/from\s+['"]([^'"]+)['"]/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

describe("T5 — ADR-001 repo-wide: no `playwright` (non-core) imports", () => {
  it("src/ contains no `from \"playwright\"` imports (only playwright-core is allowed)", async () => {
    const files = srcTsFiles();
    const imports = await readImports(files);
    const bad = imports.filter((spec) => spec === "playwright");
    expect(bad, `non-core playwright imports found: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("T5 — v1 logger path deleted", () => {
  it("src/ and tests/ contain no `../logger`, `./logger`, or `logger/index` imports", async () => {
    const files = allTsFiles();
    const imports = await readImports(files);
    const bad = imports.filter((spec) => /(^|\.)\/logger(\/index)?['"]?$/.test(spec) || spec.includes("logger/index"));
    expect(bad, `v1 logger imports found: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("T5 — v1 source tree physically deleted", () => {
  const gone: Array<[string, string]> = [
    ["file", "src/index.ts"],
    ["file", "src/types.ts"],
    ["dir", "src/tui"],
    ["dir", "src/scraper"],
    ["dir", "src/queue"],
    ["dir", "src/epub"],
    ["dir", "src/sessions"],
    ["dir", "src/cookies"],
    ["dir", "src/sites"],
    ["dir", "src/config"],
    ["dir", "src/logger"],
  ];
  for (const [kind, rel] of gone) {
    it(`${rel} does not exist (${kind})`, () => {
      const p = path.join(ROOT, rel);
      const exists = kind === "dir" ? fs.existsSync(p) && fs.statSync(p).isDirectory() : fs.existsSync(p);
      expect(exists, `${rel} should have been deleted in Phase 6 Step 3`).toBe(false);
    });
  }
  it("src/ contains only the v2 hexagon dirs (core, ports, adapters, app)", () => {
    const entries = fs.readdirSync(SRC, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(entries).toEqual(["adapters", "app", "core", "ports"]);
  });
});

describe("T8 — package.json has no v1-only deps/scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  it("version is 2.0.0", () => {
    expect(pkg.version).toBe("2.0.0");
  });
  it("dev:v1 script is gone", () => {
    expect(pkg.scripts?.["dev:v1"]).toBeUndefined();
  });
  it("dev script still targets the v2 CLI entry point", () => {
    expect(pkg.scripts?.dev).toContain("src/app/cli.ts");
  });
  it("bin.wnscrape points at dist/app/cli.js", () => {
    expect(pkg.bin?.wnscrape).toBe("./dist/app/cli.js");
  });

  const removedDeps = ["enquirer", "cli-progress", "playwright", "ora", "@types/cli-progress", "slugify"];
  for (const dep of removedDeps) {
    it(`${dep} is no longer a dep`, () => {
      expect(allDeps[dep], `${dep} should have been removed in Phase 6 Step 4`).toBeUndefined();
    });
  }
});

describe("T7 — Phase 6 docs exist and are non-empty", () => {
  const docs: Array<[string, string]> = [
    ["README.md", "README.md"],
    ["CONTRIBUTING.md", "CONTRIBUTING.md"],
    ["docs/sites/adding-a-site.md", "the contributor site adapter guide"],
  ];
  for (const [rel, label] of docs) {
    it(`${rel} exists and is non-empty (${label})`, () => {
      const p = path.join(ROOT, rel);
      expect(fs.existsSync(p), `${rel} should exist`).toBe(true);
      const stat = fs.statSync(p);
      expect(stat.size, `${rel} should be non-empty`).toBeGreaterThan(0);
    });
  }
});
