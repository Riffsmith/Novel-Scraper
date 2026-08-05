// ─────────────────────────────────────────────────────────────────────────────
//  clackPrompts.ts - the SOLE file in the repo that imports @clack/prompts.
//
//  Per ADR-P3-B / ADR-002, every screen goes through the PromptProvider seam;
//  this is the production implementation. `isCancel()` is translated to the
//  single `Cancel` symbol exported from PromptProvider.
//
//  clack distinguishes `select`/`confirm`/`text` (the value-or-symbol
//  primitives) from `log.*` (which renders an immediate line in the body
//  region). `spinner()` returns clack's spinner handle. Any future clack
//  primitive screens need is added here, not imported anywhere else.
// ────────────────────────────────────────────────────────────────────────────

import * as clack from "@clack/prompts";

import {
  Cancel,
  type Cancel as CancelType,
  type PromptProvider,
  type SelectOption,
} from "./PromptProvider.js";

function isCancel(v: unknown): v is CancelType {
  return clack.isCancel(v);
}

export const clackPromptProvider: PromptProvider = {
  async select<T extends string>(opts: {
    message: string;
    options: SelectOption<T>[];
    initial?: T;
  }): Promise<T | CancelType> {
    const initial = opts.initial;
    const result = await clack.select<T>({
      message: opts.message,
      initialValue: initial,
      // clack's Option<T> conditional type needs the value narrowing that TS
      // cannot do inside a generic call; cast through the option shape.
      options: opts.options.map((o) => {
        const out: { value: T; label: string; hint?: string; disabled?: boolean } = {
          value: o.value,
          label: o.label,
        };
        if (o.hint !== undefined) out.hint = o.hint;
        return out as clack.Option<T>;
      }),
    });
    return isCancel(result) ? Cancel : (result as T);
  },

  async confirm(opts: { message: string; initial?: boolean }): Promise<boolean | CancelType> {
    const result = await clack.confirm({
      message: opts.message,
      initialValue: opts.initial,
    });
    return isCancel(result) ? Cancel : (result as boolean);
  },

  async text(opts: {
    message: string;
    initial?: string;
    placeholder?: string;
    hint?: string;
    validate?(value: string): boolean | string;
  }): Promise<string | CancelType> {
    const result = await clack.text({
      message: opts.message,
      initialValue: opts.initial,
      placeholder: opts.placeholder,
      validate: opts.validate
        ? (v) => {
            const out = opts.validate!(v ?? "");
            return out === true ? undefined : out === false ? "Invalid value" : out;
          }
        : undefined,
    });
    return isCancel(result) ? Cancel : (result as string);
  },

  spinner(): {
    start(text: string): void;
    stop(text?: string): void;
    fail(text?: string): void;
    succeed(text?: string): void;
  } {
    const s = clack.spinner();
    return {
      start(text: string) {
        s.start(text);
      },
      stop(text?: string) {
        s.stop(text);
      },
      fail(text?: string) {
        s.error(text);
      },
      succeed(text?: string) {
        s.stop(text);
      },
    };
  },

  log(kind: "info" | "success" | "warn" | "error" | "dim", msg: string): void {
    switch (kind) {
      case "info":
        clack.log.info(msg);
        break;
      case "success":
        clack.log.success(msg);
        break;
      case "warn":
        clack.log.warn(msg);
        break;
      case "error":
        clack.log.error(msg);
        break;
      case "dim":
        clack.log.message(msg);
        break;
    }
  },
};
