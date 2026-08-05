// ─────────────────────────────────────────────────────────────────────────────
//  LibraryScreen - list/open/delete EPUBs under defaultOutputDir (readme §2.4).
//
//  New screen (no v1 oracle, per 03-tui-design §2). Adapter-side per ADR-P3-F:
//  no core service, no port - presentation + a FS/process concern, both
//  adapter-local. The listing + opener are injected so T9 runs without touching
//  the real filesystem.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { Cancel } from "../PromptProvider.js";
import type { Screen, ShellContext, ScreenResult } from "../ShellContext.js";

export interface EpubListing {
  name: string;
  size: number;
  mtime: string; // ISO
}

export type ListEpubsFn = (dir: string) => EpubListing[];

export type OpenEpubFn = (absPath: string) => Promise<void>;

export const defaultOpenEpub: OpenEpubFn = (absPath: string) =>
  new Promise((resolve) =>
    spawn(
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open",
      [absPath],
      { detached: true, stdio: "ignore" },
    ).on("close", () => resolve(undefined)),
  );

/** Default FS-based listing: scans `dir` for `*.epub`. */
export const defaultListEpubs: ListEpubsFn = (dir: string): EpubListing[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".epub"))
    .map((name) => {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      return { name, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
};

export class LibraryScreen implements Screen {
  readonly id = "library";
  constructor(
    private deps: { list?: ListEpubsFn; open?: OpenEpubFn } = {},
  ) {}

  async render(ctx: ShellContext): Promise<ScreenResult> {
    const cfg = await ctx.config.read();
    const dir = cfg.defaultOutputDir;
    const listFn = this.deps.list ?? defaultListEpubs;
    const openFn = this.deps.open ?? defaultOpenEpub;

    while (true) {
      const listing = listFn(dir);
      if (listing.length === 0) {
        ctx.prompt.log("warn", `No EPUBs found under ${dir}.`);
        return { action: "pop" };
      }
      const options = [
        ...listing.map((ep) => ({
          value: `open:${ep.name}`,
          label: `${ep.name}  (${humanSize(ep.size)}, ${ep.mtime.slice(0, 10)})`,
        })),
        { value: "__delete__", label: "Delete an EPUB" },
        { value: "__back__", label: "Back" },
      ];
      const choice = await ctx.prompt.select<string>({
        message: `Library - ${listing.length} EPUB(s) in ${dir}`,
        options,
      });
      if (choice === Cancel) return { action: "pop" };
      if (choice === "__back__") return { action: "pop" };
      if (choice === "__delete__") {
        await this.deleteFlow(ctx, dir, listing);
        continue;
      }
      if (choice.startsWith("open:")) {
        const name = choice.slice("open:".length);
        const absPath = path.resolve(dir, name);
        try {
          await openFn(absPath);
          ctx.prompt.log("success", `Opened: ${absPath}`);
        } catch (e) {
          ctx.prompt.log("error", `Failed to open ${absPath}: ${(e as Error).message}`);
        }
        continue;
      }
      ctx.prompt.log("warn", `Unknown choice: ${choice}`);
      continue;
    }
  }

  private async deleteFlow(
    ctx: ShellContext,
    dir: string,
    listing: EpubListing[],
  ): Promise<void> {
    const options = [
      ...listing.map((ep) => ({ value: `del:${ep.name}`, label: ep.name })),
      { value: "__cancel__", label: "Cancel" },
    ];
    const picked = await ctx.prompt.select<string>({
      message: "Delete which EPUB?",
      options,
    });
    if (picked === Cancel) return;
    if (picked === "__cancel__") return;
    if (picked.startsWith("del:")) {
      const name = picked.slice("del:".length);
      const ok = await ctx.prompt.confirm({
        message: `Delete ${name}? This cannot be undone.`,
        initial: false,
      });
      if (ok === Cancel || ok === false) {
        ctx.prompt.log("warn", "Delete cancelled.");
        return;
      }
      try {
        fs.unlinkSync(path.resolve(dir, name));
        ctx.prompt.log("success", `Deleted: ${name}`);
      } catch (e) {
        ctx.prompt.log("error", `Failed to delete ${name}: ${(e as Error).message}`);
      }
    }
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
