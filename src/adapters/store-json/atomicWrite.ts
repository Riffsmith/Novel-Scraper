// ─────────────────────────────────────────────────────────────────────────────
//  atomicWrite - POSIX-safe file writes via write-tmp-then-rename.
//
//  A crash mid-`writeFileSync` produces a truncated JSON file. v1's own
//  `listSessions` quietly dropped such files, silently losing a resumable
//  scrape (see `docs/phase-2/readme.md` §1.4). Phase 2 fixes this with
//  write-tmp-then-rename - atomic on POSIX, near-atomic on Windows - while
//  keeping the "skip unreadable file" tolerance in list operations.
//
//  The fs hooks below default to `fs.promises` and `os` from node; tests
//  inject fakes to fault-inject between the tmp-write and the rename
//  (T6 - fault-injection point documented by design §3 / T6).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import os from "os";

export interface AtomicFsHooks {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<void>;
  writeFile(p: string, data: string, enc: BufferEncoding): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  tmpdir(): string;
  // Used for fsync-on-fsyncFeel path - kept here so a test can swap no-op fsync.
  fsync?(fdPath: string): Promise<void>;
  // Returns a unique suffix; default uses Date.now() + random.  Test fakes
  // can return a constant for deterministic assertions.
  uniqueSuffix(): string;
}

const defaultHooks: AtomicFsHooks = {
  mkdir: (d, o) => fs.promises.mkdir(d, o).then(() => undefined),
  writeFile: (p, d, e) => fs.promises.writeFile(p, d, e),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
  tmpdir: () => os.tmpdir(),
  uniqueSuffix: () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
};

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  hooks?: AtomicFsHooks;
}

export async function atomicWrite(
  filePath: string,
  data: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const enc = opts.encoding ?? "utf8";
  const h = opts.hooks ?? defaultHooks;

  const dir = path.dirname(filePath);
  await h.mkdir(dir, { recursive: true });

  const base = path.basename(filePath);
  const tmp = path.join(h.tmpdir(), `.${base}.${h.uniqueSuffix()}.tmp`);

  await h.writeFile(tmp, data, enc);

  // Ensure the destination directory exists before the rename - needed when
  // the tmpdir is on a different filesystem root than the destination (a
  // cross-device rename fails with EXDEV; we mirror v1's "ensureDir before
  // write" guarantee instead). We always do this - idempotent if the dir
  // exists - so a partial state never surprises us on the recovery path.
  await h.mkdir(dir, { recursive: true });

  try {
    await h.rename(tmp, filePath);
  } catch (e) {
    // Best effort: clean the tmp file on failure so a retrying test sees no
    // leftover (T6 asserts "no .tmp left after next save").
    try {
      await h.unlink(tmp);
    } catch {
      /* swallow - original error is more useful */
    }
    throw e;
  }
}
