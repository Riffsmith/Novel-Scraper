// ─────────────────────────────────────────────────────────────────────────────
//  TaskRegistry - the live TaskRegistry impl Phase 3 stubbed
//  (readme §2.2 / ADR-P3-D).
//
//  Tracks the single currently-running scrape task (the shell runs one
//  scrape at a time; concurrent scrapes are deliberately unsupported so the
//  header strip and the q-key handler both have one obvious target).
//
//  Progress comes from the `ClackUIAdapter`'s `onProgress(done, total)`
//  convenience (design §1.9) - the TUI wires `UIAdapter.onProgress` to
//  `tasks.publishProgress` so the engine never talks to the shell directly,
//  keeping the hexagonal boundary. `cancel()` singularly owns a scrape-side
//  `ScrapeService.cancel()` callback the TaskScreen passes in at start() -
//  the same `flushOnQuit` hook calls it (readme §2.6) on Ctrl+Q.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "paused" | "done" | "failed";

export interface ScrapeTask {
  id: string;
  title: string;
  status: TaskStatus;
  progress: { done: number; total: number };
  cancel(): Promise<void>;
}

export interface TaskRegistryEvents {
  /** Subscribe to registry mutations (start/finish/cancel/progress). Returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Reset the registry to no active task (used by tests). */
  reset(): void;
  /** Currently-active task, or null when idle. */
  get(): ScrapeTask | null;
}

export interface StartTaskOpts {
  id: string;
  title: string;
  total: number;
  /** Called once by `cancel()` - the TaskScreen wires this to `ScrapeService.cancel()`. */
  onCancel(): Promise<void>;
}

export interface LiveTaskRegistryControls extends TaskRegistryEvents {
  start(opts: StartTaskOpts): ScrapeTask;
  publishProgress(done: number): void;
  finish(): void;
  cancelActive(): Promise<void>;
}

export class LiveTaskRegistry implements LiveTaskRegistryControls {
  private task: ScrapeTask | null = null;
  private readonly subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  reset(): void {
    this.task = null;
    this.notify();
  }

  get(): ScrapeTask | null {
    return this.task;
  }

  start(opts: StartTaskOpts): ScrapeTask {
    const task: ScrapeTask = {
      id: opts.id,
      title: opts.title,
      status: "running",
      progress: { done: 0, total: opts.total },
      cancel: async () => {
        try {
          await opts.onCancel();
        } finally {
          if (this.task && this.task.id === opts.id) {
            this.task.status = "paused";
            this.notify();
          }
        }
      },
    };
    this.task = task;
    this.notify();
    return task;
  }

  publishProgress(done: number): void {
    if (!this.task) return;
    this.task.progress.done = done;
    this.notify();
  }

  finish(): void {
    if (!this.task) return;
    this.task.status = this.task.status === "paused" ? "paused" : "done";
    // Keep the task visible post-finish so the summary card can render the
    // final progress; the TaskScreen calls reset() after the summary is
    // acknowledged so the header strip goes idle.
    this.notify();
  }

  async cancelActive(): Promise<void> {
    if (!this.task) return;
    await this.task.cancel();
  }

  private notify(): void {
    for (const fn of this.subscribers) {
      try {
        fn();
      } catch {
        /* a single subscriber throwing must not break the others */
      }
    }
  }
}
