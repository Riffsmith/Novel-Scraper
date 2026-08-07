# Phase 5 - Deviation Log (post-implementation)

Chronological record of every place the shipped code diverges from `docs/phase-5/readme.md` (the
design doc), with a justification. Matches the format of the phase-1/2/3/4 logs.

The design doc was treated as the authoritative spec; deviations are called out here, not silently
decided. Where the deviation has a real architectural trade-off, it links to `adr.md`.

---

## D-P5-A - `cli.parse()` is wrapped in try/catch to surface cac errors (ADR-P5-F)

**Spec:** readme §2.2 ships a thin-shell `cli.ts` invoking `cli.parse(argv)` once.

**Shipped:** `cli.parse(argv)` runs inside `try/catch`; a caught cac error produces a
`console.error(...)` and `process.exit(1)` on top of the default silent winston behavior.

**Reason:** `src/logger/index.ts` registers winston `exceptionHandlers` at module load: any
`uncaughtException` (including the synchronous throws from `cli.parse()` on argv-validation errors)
is captured to `logs/exceptions.log` and silently swallowed, so the process exits 0 with no stderr.
A CLI user typing `wns --bogus-flag run` would see no error. Wrapping `cli.parse()` in `try/catch`
re-surfaces the cac error directly.

**ADR:** ADR-P5-F (added during impl).

**Migration impact:** none — this only affects CLI ergonomics; no on-disk format, no store schema.

---

## D-P5-B - `config set` coercion expands beyond `fingerprintSeed` to ALL typed config fields

**Spec:** readme §2.5 / ADR-P5-B calls out ONE additive coercion tweak (`fingerprintSeed` accepting
`"null" -> null`); the implication was that the partial zod schema would coerce every other field
natively.

**Shipped:** `src/adapters/schemas/appConfig.ts` widens every typed config field with
`boolOrStr`/`numOrStr`/`seedOrStr` unions. Each union accepts BOTH the native type (YAML authors get
`humanize: false` validated as a boolean) AND a string (CLI users get
`wns config set humanize false` validated through `z.preprocess(String)`). Impossible coercions
(e.g. `boolOrStr` on a function) throw inside the preprocessor.

**Reason:** `config set <key> <value>` always arrives as a CLI STRING. The partial zod schema WITHOUT
the union would refuse `"true"` for a boolean field (`expected boolean, received string`) — making
`config set humanize true` fundamentally unusable. The readme's `fingerprintSeed` carve-out was the
one explicit example of the pattern, but in practice EVERY typed field needed the same union
treatment to make `config set` work for any non-string field.

The expansion was the minimal honest fix: use the SAME coercion shape (`*OrStr` union) for every
typed config field, fed through the SAME partial-zod-single-key parse path the readme proposed.
Documented in `appConfig.ts:57-92` (`boolOrStr`, `numOrStr`, `seedOrStr` definitions + the partial
schema assembly). The T9 test plan items (`set boolean field`, `set humanize string`, `set number`,
`set fingerprintSeed null`, `set fingerprintSeed 123`) all assert the union's behavior.

**ADR:** none for the additive union itself — this is a refinement of ADR-P5-B's coercion
implementation that the readme left implicit. The fact that the deviation widens the scope from one
key to every typed field is the deviation; the existing ADR-P5-B "zod-coerced, schema-driven" decision
the readme approved still stands as the architectural choice.

**Migration impact:** the `config.yaml` on-disk shape is unchanged. YAML authors' native types
(booleans, numbers) still parse; CLI strings now coerce. No write-side effect: a value parsed via
`numOrStr` becomes a number in `appConfigSchema.parse(...).defaultConcurrency`, persisted to YAML as
a number — same as before.

---

## D-P5-C - `cac@7` does NOT match space-separated command names; group commands dispatch on `<action>`

**Spec:** readme §1.5 command table + §2.2 register `cli.command("sessions ls", ...)`,
`cli.command("cookies add --file ...", ...)`, etc., with two-token command names.

**Shipped:** `cli.command("sessions <action> [...rest]")`, `cli.command("cookies <action> ...")`,
`cli.command("profiles <action>")`, `cli.command("config <action> [...rest]")` — single-token
command names with a mandatory positional `<action>` arg and an optional variadic `[...rest]` for
the trailing key/value (e.g. `config set <key> <value>` is registered as `config <action> [...rest]`
so that two trailing positionals don't trigger `checkUnusedArgs()`).

**Reason:** cac@7's matcher (`cac@7/typescript/Index.ts:matchedCommand`) only compares
`parsed.args[0]` against each registered `.rawName` token. So `cli.command("sessions ls", ...)`
never matches `wnscrape sessions ls` because `parsed.args[0]` is `"sessions"`, not `"sessions ls"`.
The space in the registered name is parsed as a second arg slot that never gets populated.

Symptoms (verified empirically):
- `cli.command("cookies ls")` -> `wns cookies ls` finds no command match (help printed) — exit 0
- `cli.command("sessions rm <id>")` -> `wns sessions rm foo` fails with "unknown command rm"
- `cli.command("config set <key> <value>")` -> `wns config set humanize true` fails with
  "checkUnusedArgs: too many args"

Two separate cac@7 quirks compound the issue:
1. Variadic arg syntax is `[...rest]` (leading dots), NOT `[rest...]` (trailing dots) — the
   `findAllBrackets` parser in `lib/parser/parseArgv.js` only strips a leading-`...` prefix.
2. `checkUnusedArgs()` in `lib/parser/index.js` THROWS when the number of positional args exceeds
   the declared arg slot count. `config set <key> <value>` (two positionals) needs `config <action>
   [...rest]` (one positional + one variadic slot) to accept the trailing key/value pair without
   throwing.

The test suite is unaffected: the tests (T1-T14) call `cliCommands/*` functions DIRECTLY (not via
spawned process), bypassing cac's argv machinery. The dispatch bug lives entirely in the cli.ts
shell, which is exercised by manual end-to-end verification (every `wns <cmd> --json` invocation
below was smoke-tested against the new cli.ts).

**ADR:** ADR-P5-E (added during impl). Manual verification: every grouped command in the new
cli.ts shell produces the expected output — `wns cookies ls --json`, `wns sessions rm bogus --json`
(exit 1, envelope correct), `wns config set humanize true --json`, `wns config reset --json`,
`wns profiles rm --domain nonexistent --json` (exit 1), etc.

**Migration impact:** none — CLI ergonomics only; no on-disk format, no store schema.

---

## D-P5-D - `JsonErrSchema` accepts an optional `data` slot for doctor (ADR-P5-D)

**Spec:** readme §1.8 - strict discriminated union: `ok:false` => `{command, error:{code,message}}`
(no `data` field). §2.6 then sketches `emitJson({ok: report.exitCode === 0, ... data: report})` —
contradicting §1.8 when `exitCode !== 0`.

**Shipped:** `src/adapters/cli-json/envelope.ts:39-44` widens `jsonErrSchema` to accept an
OPTIONAL `data: z.unknown()` slot alongside the canonical `error: {code, message, details?}`.
`doctorCmd.ts:31-43` emits `{ok:false, command, error: {code: "DOCTOR_FAIL"|"DOCTOR_WARN", message},
data: report}` on warn/fail; `{ok:true, command, data: report}` on pass. The canonical failure
envelope (`ok:false` with NO `data`) is preserved for every other command.

**Reason:** the §1.8 strict shape and §2.6 doctor sketch are mutually incompatible under
non-zero exit. The honest options were:
1. Drop `data: report` on warn/fail — breaks the doctor use case (CI can't audit per-check failing
   checks via `jq '.data.checks'`; would have to walk `.error.details`, which §1.8 types as
   `unknown` — too loose to guarantee the audit array shape).
2. Always carry `data: report`, drop `error` on warn/warn — breaks §1.8's stability contract for
   any consumer that branches on the canonical `ok:false => error` shape.
3. (chosen) Widen `ok:false` to ALSO carry optional `data`, alongside the canonical `error`. Both
   contracts preserved: a `jq '.ok'`-only gate still works; a `jq '.data.checks'` drill still
   works; an `error.code` switch still works.

The widening is additive (new optional field, never renames or retypes an existing one), so
§1.8's "Stability contract: changes MUST be additive" rule is honored. The comment in
`envelope.ts:26-32` flags the widening so a future contributor doesn't re-tighten the schema
inadvertently (which would silently regress doctor's per-check inspection).

**ADR:** ADR-P5-D.

**Migration impact:** none — this is the `emitJson` envelope shape only. No on-disk format, no
store schema. The widening is additive; existing consumers of the envelope that switch on `ok`
and read `error.code` on the false branch keep working exactly as before.

---

## D-P5-E - T14 `--validate-only` consumes the zod schema via `loadJobFile`, NOT the published JSON Schema

**Spec:** readme §2.7 + §5 step 9 wire `pnpm gen:schema` (publishes `schemas/job.schema.json`) AND
imply `wns run --validate-only` should validate against that published JSON Schema (T14 wording:
"`run --validate-only` consumes the published schema").

**Shipped:** `wns run --validate-only` uses `loadJobFile(jobPath)` directly — same as the live scrape
path. `loadJobFile` parses YAML then `jobConfigSchema.safeParse` (zod). It does NOT load
`schemas/job.schema.json` + AJV. The T14 test verifies the published schema ROUND-TRIPS:
`scripts/gen-job-schema.ts` writes the JSON Schema, an AJV instance validates a good fixture
passes + a bad fixture (`metadata.title` removed) fails against the committed
`schemas/job.schema.json` (after stripping the leading `//` comment banner the gen script adds).

**Reason:** both paths use the SAME `jobConfigSchema` source of truth (the JSON Schema is generated
from it). The committed `schemas/job.schema.json` is the published artifact a CI script or third-
party tool can validate against WITHOUT depending on the app's zod runtime; consumers preferring a
JSON-Schema-aware validator (ajv, openapi, json-schema-validator) get one. The CLI's `--validate-only`
flag validates by-parse (which is what the live scrape path also does) because:
1. Two code paths that both round-trip the same zod schema is exactly the "make twice" anti-pattern
   the AGENTS.md audit rules flag.
2. The published JSON Schema is _observable output_ — it's the contract's external face; the CLI's
   internal validation stays the zod-shaped source of truth. The gen:schema prebuild hook keeps
   them in lock-step.
3. The spec's "validates a valid fixture and rejects an invalid one" T14 invariant is satisfied by
   asserting the AJV round-trip directly in the test. The CLI using zod internally doesn't
   invalidate the published contract; it just makes the CLI implementation's choice of validator a
   detail of no concern to JSON-Schema consumers.

The committed `schemas/job.schema.json` is regenerated by `prebuild` (`pnpm clean && pnpm gen:schema`)
so the published artifact can never drift from the in-code zod schema ships are validated against.

**ADR:** none — this is a scope reconciliation between §2.7's publishing step and §2.2's
`--validate-only` flag. The published JSON schema is the external contract; the CLI's zod-by-parse
implementation is the internal one. They share `jobConfigSchema` as the source of truth and the test
plan T14 + prebuild hook enforce they agree. Documented here to flag the asymmetry: a future
contributor expecting `--validate-only` to shell out to AJV + the published file should see this
log entry before changing the implementation.

**Migration impact:** none — the published JSON Schema is the artifact consumers should validate
against. The CLI's choice of validator (zod-by-parse vs AJV) is invisible to them; the
prebuild hook guarantees the artifact and the CLI's parser agree.

---

## D-P5-F - The `stubRunJobResult` mock replaces `runJob.ts` in the test suite via `vi.mock`

**Spec:** readme §3 (test plan) calls for `FakeBrowserPort` + `CollectingUIAdapter` in T1/T2/T3/T5
harnesses. The implication is that the test would inject `FakeBrowserPort` into `runJob` somehow.

**Shipped:** `tests/phase-5-cli.test.ts:30-35` mocks `../src/app/runJob.js` with
`vi.mock(...)` and `vi.fn()`. Tests assert on the mocked call args. `runJob` itself constructs
`PlaywrightBrowserPort` internally (the composition root, unchanged in Phase 5 per the design).

**Reason:** `runJob` (`src/app/runJob.ts`) hard-wires its adapter construction (`new
PlaywrightBrowserPort()` at line 35). Wiring `BrowserPort`-as-DI through `runJob` is an architectural
refactor that's out of Phase 5's scope (the readme explicitly owns only the CLI shell; the
composition root and engine are Phase 1+ territory). The honest unit-test path is:
- mock `runJob` to return a deterministic `ScrapeResult` (the test plan calls for "FakeBrowserPort"
  but the run-command tests under T1-5 only assert CLI dispatch behavior: that the command/flag
  pass-through, exit codes, and JSON envelope shape land correctly — which does NOT require an
  active FakeBrowserPort that records visitedUrls)
- the actual `browser.visitedUrls` assert in T2's spec wording is satisfied in
  `tests/scrape-service-resume.test.ts` (Phase 1, unchanged) which directly instantiates
  `ScrapeService` with a `TrackingBrowserPort`. Phase 5's T2 here asserts the cli-side threads
  `chapterUrls` from the session onto the job and passes `resumeSessionId` through to `runJob`,
  which is the part T2 ADDS on top of the Phase 1 resume invariant.

This is a scope reconciliation: the test plan's "harness" line names FakeBrowserPort as the abstract
intent; the shipped impl achieves the same CLI-side coverage more simply. Phase 1's resume test
(in `scrape-service-resume.test.ts`) still asserts the engine-level invariant directly, so the
.intersection is preserved.

**ADR:** none — this is a test-harness implementation detail. The CLI-side coverage is complete
(asserts the cliCommand threads `chapterUrls` and `resumeSessionId` correctly); the engine-side
coverage was already there from Phase 1.

**Migration impact:** none.
