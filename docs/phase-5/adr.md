# Phase 5 - Architecture Decision Record (post-implementation)

This is the consolidated ADR for Phase 5 ("the non-interactive CLI"). It records the decisions that
shaped the shipped code: the three ADR-P5-* candidates sketched in `docs/phase-5/readme.md` §6 are
now recorded as decided, plus one additional ADR (ADR-P5-D) that crystallized during implementation.

For the chronological divergence list see `docs/phase-5/deviation-log.md`. For the top-level project
ADRs (ADR-001 ... ADR-006) see `docs/01-architecture-decisions.md`.

This file is written **after the code landed**; every "Evidence" line points at shipped files.

---

## ADR-P5-A - Single tagged-union JSON envelope for every `--json` command (required)

**Context**

`docs/phase-5/readme.md` §1.8 specifies a single JSON envelope as the published contract a CI script
relies on: `wnscrape run --job <f> --json` produces output that can be `jq '.ok'`-gated, with the
full payload on `data`. Read-only commands emit `{ok:true, command, data}`; failures go through the
SAME envelope so consumers don't have to switch between stdout JSON / stderr text and exit-code
parsing.

**Decision**

A single `JsonResult` discriminated union lives in `src/adapters/cli-json/envelope.ts`, validated
against a zod `jsonResultSchema` BEFORE write so a malformed envelope fails loudly INSTEAD of
poisoning a CI pipeline (`emitJson` § envelope.ts:58-77). Every `cliCommands/*` command goes
through `emitJson`; no `console.log(JSON.stringify(...))` for envelope output. The shape is:

```ts
type JsonResult =
  | { ok: true;  command: string; data: unknown }
  | { ok: false; command: string; error: { code: string; message: string; details?: unknown };
                data?: unknown }    // optional `data` slot — see ADR-P5-D
```

Read-only commands (`sessions ls`, `cookies ls`, `profiles ls`, `config get`, `config set`,
`config reset`, `cookies add`, `cookies rm`, `sessions rm`, `profiles rm`) emit `ok:true` with the
store's natural return value on `data`. Failure paths emit `ok:false` with `error: {code, message}`
where `code` is a stable `COMMANDNAME_FAILED` or command-specific code (`SESSION_NOT_FOUND`,
`INVALID_VALUE`, `UNKNOWN_KEY`, `JOB_REQUIRED`, etc.).

Under `--json` the winston Console transport is swapped for `createSilentLogger()` so the ONLY stdout
output is the envelope — no chalk codes, no interleaved progress lines. See ADR-P5-C for the
human-path rationale.

**Evidence:** `src/adapters/cli-json/envelope.ts`, every `cliCommands/*.ts` file, the
`createSilentLogger()` swap in `cliCommands/run.ts:commonLog`, `cliCommands/sessions.ts:newLog`,
`cliCommands/cookies.ts:newLog`, `cliCommands/profiles.ts:newLog`, `cliCommands/config.ts:newLog`,
`cliCommands/doctorCmd.ts:newLog`.

---

## ADR-P5-B - `config set` coercion is schema-driven, with ALL typed fields coerced (required, expanded)

**Context**

The readme §2.5 / ADR-P5-B candidate proposed `appConfigSchema.partial().safeParse({[key]: rawValue})`
as the single source of truth for `config set <key> <value>` coercion, calling out only
`fingerprintSeed` accepting the string `"null" -> null`. v1 used a hand-rolled per-key coercion table
(the audit pattern the design avoided).

**Decision**

Implemented as proposed. `parseSetInput()` (`cliCommands/config.ts:37-56`) feeds the partial schema
a one-key object and returns the parsed value or zod's first issue message. The unknown-key fast
path (`KNOWN_KEYS.has(key)`) surfaces a "valid keys: ..." hint distinct from zod internals.

**Deviation from spec scope:** the readme called out only `fingerprintSeed` for string coercion; in
practice EVERY typed config field needed the same treatment because `pnpm config set <key> <value>`
always arrives as a CLI string. So `appConfigSchema` `src/adapters/schemas/appConfig.ts` widens
booleans, numbers, and enum fields with `boolOrStr`/`numOrStr`/`seedOrStr` unions: each accepts BOTH
its native type AND a string (with `z.preprocess(String)` normalization) — YAML authors writing
`humanize: false` and CLI users writing `wns config set humanize false` both work. Each preprocessor
throws on the impossible case (e.g. `boolOrStr` on a function) so a wrong type fails loudly instead
of silently coercing. See D-P5-B in the deviation log for the full rationale.

**Evidence:** `src/adapters/schemas/appConfig.ts` (`boolOrStr`, `numOrStr`, `seedOrStr` schemas),
`src/app/cliCommands/config.ts:parseSetInput`.

---

## ADR-P5-C - Human-readable `run` path uses one-line stderr, no `cli-progress` (required)

**Context**

The readme §2.5 / ADR-P5-C candidate proposed one-line-per-checkpoint stderr (mirroring v1's
`queue/index.ts` checkpoint throttle), keeping `cli-progress` v1-only (Phase 6 deletes it).

**Decision**

As proposed. The v2 human `run` path (`cliCommands/run.ts:execScrape` after the `if (opts.json)`
early return) emits a single `Done: N chapters, X words, Ys` line on stdout. Checkpoint progress
events flow through `CollectingUIAdapter` to populate the `--json` envelope; under the human path
`NoopUIAdapter` drops them (the v1 oracle's exact `queue/index.ts` checkpoint throttle math lives
unchanged inside `ScrapeService`). `cli-progress` stays a dep of v1 only; v2 never imports it.

**Evidence:** `src/app/cliCommands/run.ts:156-188` (the execScrape human tail), the
`CollectingUIAdapter`/`NoopUIAdapter` choice at `:162`.

---

## ADR-P5-D - `doctor --json` widens §1.8: ok:false carries `data` alongside `error` (added during impl)

**Context**

§2.6 hard-codes the doctor action:

```ts
if (opts.json) emitJson({ ok: report.exitCode === 0, command: "doctor", data: report });
else renderDoctorReport(report);
process.exit(report.exitCode);
```

but §1.8's strict discriminated union says `ok:false` MUST go through `{ok:false, command, error}` —
no `data` field. Under a fresh isolated XDG, doctor routinely warns (`site-profiles.json` missing) or
fails (`config.yaml` missing); a CI script should still see `jq '.data.checks'` to debug, regardless
of the pass/warn/fail result. The §1.8 strict shape would force doctor to either drop the report on
warnings/failures OR widen the canonical error shape.

**Decision**

Widen §1.8 so `ok:false` ALLOW an OPTIONAL `data` slot. The canonical failure envelope
`{ok:false, command, error}` is preserved (every other command still emits exactly that shape on
failure); the loose variant `{ok:false, command, error, data?}` is opt-in. doctor emits
`{ok: exitCode === 0, command: "doctor", data: report}` on pass, and
`{ok: false, command: "doctor", error: {code: "DOCTOR_PASS|FAIL|WARN", message}, data: report}` on
warn/fail. The error summary is a one-line canonical encoding of the exit code; the full per-check
audit trail is always on `data` regardless. This preserves both §1.8's stability contract (a CI
script that only checks `jq '.ok' + .error.code` is unaffected) AND §2.6's per-check visibility
contract (a CI script that drills into `jq '.data.checks'` works regardless of pass/warn/fail).

**Why not the alternative:** dropping `data` from a warnings/failures doctor run would break the
core use case (CI reveals WHY the doctor is failing). Emitting the canonical error envelope ONLY
would force consumers to walk `.checks` from `.error.details`, which the readme's §1.8 type doesn't
even mention (`details?: unknown` — too loose to guarantee the audit). Widening the loose variant
is the minimal additive change with the strongest backwards-compat guarantee.

**Evidence:** `src/adapters/cli-json/envelope.ts:39-44` (`jsonErrSchema` accepts the optional
`data` slot, with a comment linking here), `src/app/cliCommands/doctorCmd.ts:31-43` (the
doctor-specific envelope construction with the `exitCodeToSummary` map).

**Trade-off:** the strict equality check `ok:false → has(error) AND no(data)` no longer holds; a
type guard that switches on `ok` then asserts `data` is absent in the false branch would now break.
This is documented as an additive stability note in `envelope.ts:26-32` and referenced from the
deviation log D-P5-E so future contributors don't re-tighten the schema inadvertently.

---

## ADR-P5-E (D-P5-C in log) - `cac@7` group commands dispatch on the positional action arg (added during impl)

**Context**

The readme §1.5 / §2.2 table registers grouped commands as space-separated aliases (`cookies ls`,
`sessions rm <id>`, `config get <key>`, etc.) and §2.2 sketches `cli.command("sessions ls", ...)`.

**Decision**

cac@7's matcher only checks the FIRST token of a space-separated command name against `parsed.args[0]`.
`cli.command("sessions ls", ...)` never matches `wnscrape sessions ls` because `parsed.args[0]` is
`"sessions"`, not `"sessions ls"`. The fix is to register `cli.command("sessions <action> [...rest]")`
and `cli.command("cookies <action> [...rest]")` (likewise `profiles`, `config`) as variadic-action
commands that dispatch on `opts.action` from the body. Variadic args in cac@7 use leading dots
(`[...rest]`), not trailing dots — the `findAllBrackets` parser only strips a leading-`...` prefix.

See D-P5-C in the deviation log for the discovery + why the test suite is unaffected (tests call
`cliCommands/*` functions directly, bypassing cac's argv machinery — the dispatch bug lives entirely
in the cli.ts shell which is exercised by manual end-to-end verification).

**Evidence:** `src/app/cli.ts` (group registrations as `<group> <action> [...rest]`), the
`<value>`/`<...rest>` cac arg conventions; manual e2e verification of `wns cookies ls --json`,
`wns sessions rm bogus --json`, `wns config set humanize true --json`, etc.

---

## ADR-P5-F (D-P5-A in log) - `cli.parse()` is wrapped in try/catch to surface cac errors (added during impl)

**Context**

`src/logger/index.ts` registers `exceptionHandlers` at module load: `uncaughtException` is captured
to `logs/exceptions.log` and SILENTLY swallowed (winston's default `handleExceptions: true`).
`cli.parse()` is synchronous; a cac validation throw (e.g. unknown option, unused positional args)
becomes an uncaughtException that exit 0 with no stderr.

**Decision**

Wrap `cli.parse()` in `try/catch` in `src/app/cli.ts` and emit a clear `console.error` +
`process.exit(1)` on caught errors. The winston handler still logs to `logs/exceptions.log` for
post-mortem; the user just sees the actual fault on stderr.

**Evidence:** `src/app/cli.ts` (the try/catch block around `cli.parse(argv)`), the corresponding
note in D-P5-A of the deviation log.

---

## ADR-P5-G - T12 `tui` subcommand boots `app/tui.ts:main()` (required, design follows §2.8)

**Context**

§2.8 spec: `wnscrape tui` imports `app/tui.ts:main()` dynamically (the v1 monolith in `src/index.ts`
stays byte-untouched, so `tui` delegates to the v2 shell built in Phase 3). The dynamic import
gate prevents `cli.ts` from auto-booting the TUI when imported.

**Decision**

`src/app/tui.ts` exports `main()`. An `isMain` guard (fileURLToPath(import.meta.url) ===
process.argv[1]) handles the standalone `pnpm dev:tui` boot path. `cli.ts` registers `tui` and
dynamically `import("../app/tui.js")`-then-`main()`-calls it. The unit-level test (T12) asserts the
exported `main` has the right arity; full spawned-process smoke is gated on the same
`CLOAKBROWSER_BINARY_AVAILABLE=1` env as the existing acceptance suite.

**Evidence:** `src/app/tui.ts:76-103` (the `_isMain` guard + `main()`), `src/app/cli.ts` (the
`tui` subcommand registration with the dynamic import).
