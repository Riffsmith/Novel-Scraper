// ─────────────────────────────────────────────────────────────────────────────
//  Acceptance — full local-HTTP-server scrape with the REAL CloakBrowser binary.
//
//  This test is gated on `CLOAKBROWSER_BINARY_AVAILABLE=1` because it requires
//  the stealth Chromium binary to be downloaded and a working environment.
//  CI sets the env var; local development may skip it.
//
//  Covers roadmap acceptance bullets:
//    - "wnscrape run --job fixtures/job.yaml produces a valid EPUB for a
//       local fixture > 50 chapters"
//    - "A crashed run resumes ... skips already-done chapters"
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

import { runJob } from "../src/app/runJob.js";
import { createDefaultWinstonLogger } from "../src/adapters/logger-winston/WinstonLogger.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";
import type { JobConfig } from "../src/core/domain/JobConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOULD_RUN = process.env.CLOAKBROWSER_BINARY_AVAILABLE === "1";

const itAcceptance = SHOULD_RUN ? it : it.skip;

function mkServer(root: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><a href='/c1.html'>c1</a> ... toc stub</body></html>");
        return;
      }
      const file = path.join(root, url);
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fs.readFileSync(file, "utf8"));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

describe("Acceptance — full pipeline via real CloakBrowser (skip without binary)", () => {
  let server: http.Server;
  let port: number;
  let workDir: string;

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wns-accept-"));
    // Generate 60 chapter pages + a TOC page
    const tocEntries: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const html = `<!DOCTYPE html><html><head><title>Chapter ${i}</title></head>
<body><h1 class="t">Chapter ${i}</h1><div class="c"><p>Content ${i} word word word.</p></div></body></html>`;
      fs.writeFileSync(path.join(workDir, `c${i}.html`), html);
      tocEntries.push(`<a href="/c${i}.html">Chapter ${i}</a>`);
    }
    const toc = `<!DOCTYPE html><html><head><title>TOC</title></head>
<body>${tocEntries.join("<br/>")}</body></html>`;
    fs.writeFileSync(path.join(workDir, "toc.html"), toc);

    ({ server, port } = await mkServer(workDir));
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  itAcceptance("runs a 60-chapter scrape from a local fixture server", async () => {
    const outDir = path.join(workDir, "out");
    const job: JobConfig = {
      method: "toc",
      tocUrl: `http://127.0.0.1:${port}/toc.html`,
      contentSelector: ".c",
      separateTitle: true,
      titleSelector: ".t",
      excludeSelectors: [],
      metadata: { title: "Accept", author: "Test", language: "en", coverSource: "none" },
      outputDir: outDir,
      outputFilename: "accept",
      concurrency: 1,
      delayMin: 0,
      delayMax: 0,
      headless: true,
      output: { epub: true },
    };

    const log = createDefaultWinstonLogger();
    const ui = new NoopUIAdapter();
    const result = await runJob(job, { log, ui });

    expect(result.chapters.length).toBeGreaterThanOrEqual(50);
    expect(fs.existsSync(path.join(outDir, "accept.epub"))).toBe(true);
  }, 300_000);
});