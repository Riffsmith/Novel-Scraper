// ─────────────────────────────────────────────────────────────────────────────
//  JSON envelope - the published stable contract for `wnscrape --json`.
//
//  Phase 5 (ADR-P5-A): a single tagged-union envelope so a CI script can
//  `jq '.ok'` then branch on `command`. Read-only commands emit `{ok:true,
//  command, data}`; failures go through the SAME envelope so consumers don't
//  have to switch between "stdout JSON" and "stderr text" exit-code parsing.
//
//  Stability contract: this shape is the published contract Phase 6 docs
//  reference. Changes MUST be additive (new optional fields, never renamed
//  or retyped existing ones).
//
//  `emitJson()` validates the shape against a zod schema of `JsonResult`
//  itself before writing to stdout so a bug that emits an unstructured value
//  is caught at the seam rather than poisoning a CI pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

const jsonResultErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

// `ok:false` envelope ALLOWS an optional `data` field for commands whose
// failure listing is itself the value the consumer wants (doctor: the
// DoctorReport IS the per-check breakdown of why it failed/warned; a CI
// script should `jq '.data.checks` regardless of exit code). The canonical
// failure envelope (`{ok:false, command, error}`) is preserved — `data`
// never overrides `error` — it just rides alongside. See docs/phase-5/adr.md
// ADR-P5-D for why doctor deviates from §1.8's strict "ok:false = error only".
const jsonOkSchema = z.object({
  ok: z.literal(true),
  command: z.string(),
  data: z.unknown(),
});

const jsonErrSchema = z.object({
  ok: z.literal(false),
  command: z.string(),
  error: jsonResultErrorSchema,
  data: z.unknown().optional(),
});

export const jsonResultSchema = z.discriminatedUnion("ok", [jsonOkSchema, jsonErrSchema]);

export type JsonResultError = z.infer<typeof jsonResultErrorSchema>;
export type JsonOk = z.infer<typeof jsonOkSchema>;
export type JsonErr = z.infer<typeof jsonErrSchema>;
export type JsonResult = JsonOk | JsonErr;

/**
 * Serialise a `JsonResult` to stdout. Validates against `jsonResultSchema`
 * first so a malformed envelope fails loudly INSTEAD of reaching the
 * consumer. Writes a trailing newline; never colourised.
 */
export function emitJson(r: JsonResult): void {
  const parsed = jsonResultSchema.safeParse(r);
  if (!parsed.success) {
    // Defensive: an envelope that fails its own schema is a programmer bug.
    // Emit the canonical failure shape so the consumer still sees JSON.
    const fallback: JsonResult = {
      ok: false,
      command: typeof (r as { command?: string } | null)?.command === "string"
        ? (r as { command: string }).command
        : "unknown",
      error: {
        code: "ENVELOPE_SCHEMA_VIOLATION",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      },
    };
    process.stdout.write(JSON.stringify(fallback) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(parsed.data) + "\n");
}
