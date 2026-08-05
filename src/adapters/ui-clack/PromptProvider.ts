// ─────────────────────────────────────────────────────────────────────────────
//  PromptProvider - the typed prompt seam between Screen code and clack.
//
//  Per ADR-P3-B: screens need to be testable without a TTY (snapshot tests +
//  scripted CRUD walkthroughs, roadmap Phase 3 tests). @clack/prompts renders
//  straight to stdout and rejects headless driving, so every screen goes
//  through this interface instead. The real implementation
//  (`clackPrompts.ts`) is the ONLY FILE IN THE REPOSITORY that imports
//  `@clack/prompts`; `ScriptedPromptProvider` is the test double, mirroring
//  the FakeBrowserPort precedent.
//
//  `Cancel` is `isCancel()` translated to a single Symbol so screens don't
//  repeat the `typeof x === 'symbol'` check - the standard pattern is
//  `if (result === Cancel) return { action: 'pop' }`.
// ─────────────────────────────────────────────────────────────────────────────

export const Cancel: unique symbol = Symbol("PromptProvider.Cancel");
export type Cancel = typeof Cancel;

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface PromptProvider {
  select<T extends string>(opts: {
    message: string;
    options: SelectOption<T>[];
    initial?: T;
  }): Promise<T | Cancel>;

  confirm(opts: { message: string; initial?: boolean }): Promise<boolean | Cancel>;

  text(opts: {
    message: string;
    initial?: string;
    placeholder?: string;
    hint?: string;
    validate?(value: string): boolean | string;
  }): Promise<string | Cancel>;

  spinner(): {
    start(text: string): void;
    stop(text?: string): void;
    fail(text?: string): void;
    succeed(text?: string): void;
  };

  log(kind: "info" | "success" | "warn" | "error" | "dim", msg: string): void;
}
