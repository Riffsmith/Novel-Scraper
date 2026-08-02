// ─────────────────────────────────────────────────────────────────────────────
//  Back-navigable prompt sequences.
//
//  `step()` is a drop-in replacement for calling enquirer's `prompt()`
//  directly: same signature, same return shape, but a press of Escape is
//  turned into a typed `WizardBack` signal instead of an unrecognisable
//  rejection (see tui/keys.ts for exactly why that rejection looks the way
//  it does). Everywhere in this codebase that used to do
//  `const { prompt: _prompt } = require("enquirer")` and call `_prompt(...)`
//  directly can call `step(...)` instead with no other changes — Escape
//  becomes safe by default, and it composes with `runWizard()` below when a
//  screen wants Escape to mean "go back one field" specifically.
//
//  `runWizard()` walks an ordered list of single-question steps forward,
//  answer by answer. Escape on any step re-opens the previous one (skipping
//  back over any that are currently `skip()`-conditioned out) so the user
//  can change something without restarting the whole flow. Escape on the
//  very first step throws `WizardBack` out of `runWizard()` itself, which
//  callers use to mean "back out of this entire wizard" (e.g. return to the
//  menu that launched it).
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require("enquirer");
import { CANCEL_SIGNAL } from "./keys.js";

export class WizardBack extends Error {
  constructor() {
    super("wizard: go back");
    this.name = "WizardBack";
  }
}

export async function step<T extends Record<string, unknown>>(
  question: object | object[],
): Promise<T> {
  try {
    return (await _prompt(question)) as T;
  } catch (e) {
    if (e === CANCEL_SIGNAL) throw new WizardBack();
    throw e;
  }
}

// A single wizard question. `run` receives the answers gathered so far (so
// it can pre-fill its own `initial` from a prior visit, or read an earlier
// answer to decide what to ask). `skip` lets a step opt out entirely based
// on prior answers — e.g. "titleSelector" only applies when "separateTitle"
// is true — without it ever showing up in back/forward navigation.
export interface WizardStep<A, K extends keyof A> {
  key: K;
  run: (answers: Partial<A>) => Promise<A[K]>;
  skip?: (answers: Partial<A>) => boolean;
}

export async function runWizard<A extends object>(
  steps: ReadonlyArray<WizardStep<A, keyof A>>,
): Promise<A> {
  const answers: Partial<A> = {};
  let i = 0;

  while (i < steps.length) {
    const current = steps[i];
    if (current.skip?.(answers)) {
      i++;
      continue;
    }

    try {
      answers[current.key] = await current.run(answers);
      i++;
    } catch (e) {
      if (!(e instanceof WizardBack)) throw e;

      i--;
      while (i >= 0 && steps[i].skip?.(answers)) i--;
      if (i < 0) throw new WizardBack(); // backed out of the whole wizard

      // Deliberately NOT clearing answers[steps[i].key] here — leaving the
      // previous value in place lets that step's own `run()` use it as a
      // natural pre-fill for re-editing, the same way every other prefilled
      // field in this app already works.
    }
  }

  return answers as A;
}
