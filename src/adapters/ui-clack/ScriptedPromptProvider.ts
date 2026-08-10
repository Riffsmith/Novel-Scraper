// ─────────────────────────────────────────────────────────────────────────────
//  ScriptedPromptProvider - test double for PromptProvider.
//
//  Same pattern as FakeBrowserPort: screens cannot tell whether they are
//  talking to clack or to this, so walkthrough tests are plain vitest, no TTY,
//  no terminal rendering, no timing flakes. Every prompt descriptor handed to
//  the provider is appended to `calls` for assertion; each call pops the
//  next scripted answer from `script`.
//
//  Answer shapes:
//   - select/confirm/text: the bare value, or `Cancel` (exported symbol) to
//     simulate clack's isCancel path
//   - validators run, but on `Cancel` they are skipped and the prompt
//     short-circuits (matching how clack never validates a cancelled value)
//
//  Any spurious call (script exhausted) throws - tests must be exhaustive;
//  a partial script is a TUI bug masquerading as a test failure.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Cancel,
  type Cancel as CancelType,
  type PromptProvider,
  type SelectOption,
} from "./PromptProvider.js";

type AnyAnswer = string | boolean | CancelType;

export interface RecordedCall {
  kind: "select" | "confirm" | "text" | "log" | "spinner";
  message: string;
  options?: SelectOption<string>[];
  initial?: unknown;
  hint?: string;
  placeholder?: string;
  logKind?: "info" | "success" | "warn" | "error" | "dim";
  logMsg?: string;
}

export class ScriptedPromptProvider implements PromptProvider {
  private readonly script: AnyAnswer[];
  private next = 0;
  readonly calls: RecordedCall[] = [];
  /** Spinner start/stop pairs are appended here for assertion (NoTty-safe). */
  readonly spinnerEvents: Array<{
    action: "start" | "stop" | "fail" | "succeed" | "message";
    text?: string;
  }> = [];

  constructor(script: AnyAnswer[] = []) {
    this.script = script;
  }

  /** Append more answers to the script (chainable in tests for readability). */
  enqueue(answers: AnyAnswer[]): this {
    this.script.push(...answers);
    return this;
  }

  private nextAnswer(): AnyAnswer {
    if (this.next >= this.script.length) {
      throw new Error(
        `ScriptedPromptProvider: script exhausted at index ${this.next}. ` +
          `Recorded calls so far: ${JSON.stringify(this.calls)}`,
      );
    }
    return this.script[this.next++];
  }

  async select<T extends string>(opts: {
    message: string;
    options: SelectOption<T>[];
    initial?: T;
  }): Promise<T | CancelType> {
    this.calls.push({
      kind: "select",
      message: opts.message,
      options: opts.options as SelectOption<string>[],
      initial: opts.initial,
    });
    const a = this.nextAnswer();
    if (a === Cancel) return Cancel;
    if (typeof a === "boolean")
      throw new Error(
        `ScriptedPromptProvider.select got boolean for "${opts.message}"`,
      );
    return a as T;
  }

  async confirm(opts: {
    message: string;
    initial?: boolean;
  }): Promise<boolean | CancelType> {
    this.calls.push({
      kind: "confirm",
      message: opts.message,
      initial: opts.initial,
    });
    const a = this.nextAnswer();
    if (a === Cancel) return Cancel;
    if (typeof a !== "boolean")
      throw new Error(
        `ScriptedPromptProvider.confirm got non-boolean for "${opts.message}"`,
      );
    return a;
  }

  async text(opts: {
    message: string;
    initial?: string;
    placeholder?: string;
    hint?: string;
    validate?(value: string): boolean | string;
  }): Promise<string | CancelType> {
    this.calls.push({
      kind: "text",
      message: opts.message,
      initial: opts.initial,
      hint: opts.hint,
      placeholder: opts.placeholder,
    });
    let a = this.nextAnswer();
    if (a === Cancel) return Cancel;
    if (typeof a !== "string")
      throw new Error(
        `ScriptedPromptProvider.text got non-string for "${opts.message}"`,
      );
    // clack re-prompts on validation failure; mirror that by consuming the
    // next scripted answer each time the validator rejects the current one.
    while (opts.validate) {
      const out = opts.validate(a);
      if (out === true) break;
      if (this.next >= this.script.length) {
        throw new Error(
          `ScriptedPromptProvider.text: validator keeps rejecting for "${opts.message}" and the script ran out of answers (last value: "${a}"; ${out})`,
        );
      }
      a = this.nextAnswer();
      if (a === Cancel) return Cancel;
      if (typeof a !== "string")
        throw new Error(
          `ScriptedPromptProvider.text got non-string for "${opts.message}"`,
        );
    }
    return a;
  }

  spinner(): {
    start(text: string): void;
    stop(text?: string): void;
    fail(text?: string): void;
    succeed(text?: string): void;
    message?(text: string): void;
  } {
    return {
      start: (text) => this.spinnerEvents.push({ action: "start", text }),
      stop: (text) => this.spinnerEvents.push({ action: "stop", text }),
      fail: (text) => this.spinnerEvents.push({ action: "fail", text }),
      succeed: (text) => this.spinnerEvents.push({ action: "succeed", text }),
      message: (text) => this.spinnerEvents.push({ action: "message", text }),
    };
  }

  log(kind: "info" | "success" | "warn" | "error" | "dim", msg: string): void {
    this.calls.push({ kind: "log", message: msg, logKind: kind, logMsg: msg });
  }
}
