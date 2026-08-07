# Phase 5 - CLI & Automation: Investigation & Design

> **Status: proposal.** This is an investigation-and-design document written *before* the
> implementation, following the same shape as `docs/phase-1/readme.md`, `phase-2/readme.md`,
> `phase-3/readme.md`, and `phase-4/readme.md`. It proposes how Phase 5 ("CLI & automation")
> should be built against the *current* v2 code (i.e. the post-Phase-4 state). It does **not**
> modify any business logic. Design decisions with real trade-offs are flagged as ADR
> candidates (ADR-P5-*) rather than silently decided.

Roadmap reference: `docs/04-implementation-roadmap.md` §"Phase 5".
Governing ADRs: ADR-005 (TUI + CLI share `ScrapeService`), ADR-003 (hexagonal), ADR-004 (YAML for
human-edited, JSON for machine-only).
Hard contracts: AGENTS.md - v1 `src/index.ts`, `src/tui/`, `src/sites/*`, `src/types.ts` stay
byte-untouched until Phase 6. Phase 5 touches only `src/app/`, new files under
`src/adapters/cli-*`, and the `bin` repoint in `package.json`.

**Goal in one sentence:** give `wnscrape` a full `cac`-based non-interactive CLI so everything
achievable in the TUI is achievable from a script/CI without prompts, every read-only command
emits machine-stable JSON via `--json`, and the job-file schema is published from the existing
zod definitions so external tools can validate job files against a stable contract.

---

## 1. Investigation - what Phase 5 must build and what is already in place

### 1.1 The Phase 1 CLI scaffolding that exists today (`src/app/cli.ts`, 50 LOC)

Phase 1 shipped only `wnscrape run --job <file>`:

```
cli.command("run")
  .option("--job <file>", "Path to job YAML file", { default: "" })
  .action(async (opts) => {
    const jobFile = opts.job || process.env["WNSCRAPE_JOB"];
    if (!jobFile) { console.error("..."); process.exit(1); }
    const ui = new NoopUIAdapter();
    const log = createWinstonLogger(logger);
    const job = loadJobFile(jobFile);
    const result = await runJob(job, { log, ui });
    console.log(`Done: ${result.chapters.length} chapters, ${result.totalWords} words, ...`);
  });
```

Two things to note right away:

1. **`cli.ts` is already wired through `cac`, `runJob`, `loadJobFile`, `NoopUIAdapter`, and the
   Winston logger** - no new dependency, no new composition-root pattern. Phase 5 *extends* this
   file, it doesn't replatform it.
2. **The `bin` field still points at v1** (`package.json`: `"wnscrape": "./dist/index.js"`).
   Phase 5 repoints it to the v2 CLI (ADR-005 + roadmap Phase 5 acceptance), making `wnscrape`
   binary = v2 binary. v1 stays reachable via `pnpm dev` (tsx on `src/index.ts`) until Phase 6
   deletes it. This is the single most user-visible change of Phase 5.

### 1.2 What `runJob` already exposes (`src/app/runJob.ts`, 67 LOC)

`runJob(job, { log, ui?, cookies?, resumeSessionId? }): Promise<ScrapeResult>` is already the
full composition root for a scrape: it builds `PlaywrightBrowserPort` + `JsonSessionStore` +
`ArchiverEpubWriter`, runs discovery via `discoverJobChapters` (ADR-P4-B) when
`!job.chapterLinks && !resume`, then calls `ScrapeService.run`. The `cac` `run` command already
calls it.

Phase 5 additions here are *additive*:

- Thread `resumeSessionId` from a new `--resume <id>` option (the field already exists on
  `RunJobOptions`; `runJob` already loads the session from `JsonSessionStore`).
- Thread `cookies` from a new `--cookies-file <path>` option (v1's `cookiesFile` job field),
  reusing the v1 cookie-snippet format. The path is read into `DomainCookie[]` then passed as
  `opts.cookies`.
- No refactor of `runJob` itself - it is already the shared engine the TUI and CLI both want.

### 1.3 The published schema gap (roadmap: "Job-file schema published at
`schemas/job.schema.json`")

The roadmap's Phase 5 scope explicitly lists `schemas/job.schema.json` "generated from the zod
schema". `src/adapters/schemas/jobConfig.ts` already defines `jobConfigSchema` (zod, 74 LOC).
The `zod-to-json-schema` package (or a small `zod => JSON Schema draft-07` emitter) renders it
once at build time; the emitted file is committed under `schemas/job.schema.json`. The `run`
command grows a `--validate-only` flag that re-validates a job file against the schema without
launching a browser (cheap CI gate).

### 1.4 The `--json` requirement (roadmap: "`--json` on every read-only command")

The roadmap is unambiguous: every read-only command (`run`, `cookies ls`, `profiles ls`,
`sessions ls`, `config get`, `doctor`) must emit JSON when `--json` is passed, and "JSON output
validates against a stable schema (no chalk codes)". Concretely:

- A `--json` global option flips stdout to a structured shape per command (a typed
  `JsonResult` variant per command). Errors flow through the same envelope
  (`{ ok: false, error: { code, message } }`) so a CI consumer can `jq '.ok'`.
- **No `chalk`, `ora`, or `cli-progress` import in any new CLI code path that can run with
  `--json`** - the human-readable path can still pretty-print; the JSON path never colours.
  This is a Phase-1-grade hard rule (AGENTS.md: "core never imports chalk/ora"; the CLI is an
  *adapter*, so chalk is technically allowed, but JSON output must never carry ANSI codes).
- The `NoopUIAdapter` already swallows every `ScrapeEvent` (`ui-noop/NoopUIAdapter.ts:9-10`).
  For Phase 5's machine-stable `run --json` output, a thin `CollectingUIAdapter` (subclass or
  sibling) records `ScrapeEvent`s into an array so the final JSON envelope includes the chapter
  count, error list, durations, and output path. No core change - it's a new adapter that
  implements `UIAdapter`.

### 1.5 Commands to add (parity surface from the roadmap + TUI feature set)

The roadmap lists: `run`, `resume`, `cookies ls`, `cookies add --file`, `config get/set`,
`profiles ls`, `doctor`. Cross-checking against the TUI's full surface (Phase 3+4 screens) so
nothing the user can do interactively is unreachable from a script:

| Command | parity target | TUI screen it mirrors | Notes |
|---|---|---|---|
| `wnscrape run --job <f> [--json] [--resume <id>] [--cookies-file <f>] [--validate-only]` | the full scrape pipeline | `NewScrape` + `TaskScreen` tail | already implemented (Phase 1); Phase 5 adds the flags + `--json` envelope |
| `wnscrape resume` (no arg) | n/a - new | (none) | Lists resumable sessions if `--json`, or errors "use `wnscrape run --resume <id>`"; the TUI `ResumeScreen` is interactive so the CLI equivalent is `run --resume <id>` + `sessions ls` for discovery |
| `wnscrape sessions ls [--json]` | resume picker | `ResumeScreen` | `SessionStore.list()` already exists |
| `wnscrape sessions rm <id>` | deleting a checkpoint | (none in Phase 3 TUI - resume picker only lists) | `SessionStore.delete(id)` already exists; mirrors cookie/profile delete parity |
| `wnscrape cookies ls [--json]` | cookie manager (list) | `CookieManagerScreen` | `CookieStore.listDomains` + `listProfiles` + `describeProfile` |
| `wnscrape cookies add --file <f> --domain <d> --profile <p> [--label <l>] [--json]` | add via file | v1 `addCookiesFlow` paste-header path | Reads v1 cookie JSON snippet OR a `Cookie:` header string, upserts via `CookieStore.upsert`. The `--file` accepts the v1 cookie-file snippet shape (`{ cookies: [{name,value,...}] }`) so it round-trips with `cookiesFile` job field |
| `wnscrape cookies rm --domain <d> --profile <p>` | remove profile | `CookieManagerScreen` delete | `CookieStore.deleteProfile` |
| `wnscrape cookies rm --domain <d> (--all)` | remove domain | v1 cookie manager "remove domain" | `CookieStore.deleteDomain` |
| `wnscrape profiles ls [--json]` | library/listing | `LibraryScreen` (read-only listing) | `ProfileStore.list()` |
| `wnscrape profiles rm --domain <d>` | remove profile | `SettingsScreen` delete | `ProfileStore.delete(domain)` |
| `wnscrape config get [--key <k>] [--json]` | settings read | `SettingsScreen` read path | `ConfigStore.read()` then optional key filter |
| `wnscrape config set <key> <value>` | settings write | `SettingsScreen` write path | `ConfigStore.write({ [key]: coercedValue })`; coercion mirrors v1's per-key type rules |
| `wnscrape config reset` | settings reset | (TUI confirms first) | `ConfigStore.reset()`; CLI does NOT confirm (non-interactive) |
| `wnscrape doctor [--json] [--fix]` | binary + store validation | (no TUI equivalent - new capability) | **Already implemented**: `app/doctor.ts:runDoctor()` (Phase 2). Phase 5 only *wires* it to `cli.ts` and renders the `DoctorReport` either human-readable or JSON. |

Three observations about this table:

- **`doctor` and the four stores already exist**. Phase 5 is overwhelmingly a *wiring* phase:
  wire existing service methods to `cac` commands and a JSON renderer. No new business logic.
- **`resume` as a standalone command does not exist in v1 either**. v1's resume lives inside
  the interactive main menu. The CLI's honest equivalent is `run --resume <id>` + `sessions ls`
  for discovery; the roadmap lists "`resume`" as a shorthand but the *behavior* is the
  `--resume` flag. **ADR-P5-A candidate:** ship `wnscrape resume <id>` as a thin alias for
  `run --resume <id>` (no `--job` needed - it reads the session's embedded `config`) to
  satisfy the roadmap's command-listing without duplicating logic.
- **`config set` type coercion**. v1 reads config keys as typed strings and coerces booleans,
  numbers, enums (`humanPreset`), and `LogLevel`. The CLI must do the same *without* a prompt.
  The zod `appConfigSchema` already encodes the types and produces the parse error; Phase 5
  feeds `config set` args through `appConfigSchema.partial().safeParse({ [key]: rawValue })`
  and reports the zod issue on failure. **ADR-P5-B candidate:** coerce via the schema rather
  than a hand-rolled per-key coercion table (kills the audit-P5-style "make twice" pattern).

### 1.6 The bin repoint + v1 safety (ADR-005, AGENTS.md)

`package.json` currently:

```
"bin": { "wnscrape": "./dist/index.js" },
"scripts": { "dev": "tsx src/index.ts", "dev:tui": "tsx src/app/tui.ts", "start": "node dist/index.js" }
```

Phase 5 changes:

```
"bin": { "wnscrape": "./dist/app/cli.js" },
"scripts": {
  "dev": "tsx src/app/cli.ts",
  "dev:v1": "tsx src/index.ts",
  "dev:tui": "tsx src/app/tui.ts",
  "start": "node dist/app/cli.js"
}
```

Implications:

- `pnpm dev` now boots the v2 CLI (matches the shipped binary). `pnpm dev:v1` keeps v1
  reachable for parity comparison during Phase 5/6. Phase 6 deletes `dev:v1` along with
  `src/index.ts`.
- `src/index.ts` (v1) stays byte-untouched and compiling; `pnpm dev:v1` still runs it.
- The CLI gains a `wnscrape tui` subcommand (`app/cli.ts`) that boots `app/tui.ts:main()` - so
  interactive users get the same Shell they had under `pnpm dev:tui`, just via the binary. This
  closes ADR-005's "TUI + CLI share the engine" loop: one binary, two entry modes.

### 1.7 Logging + progress in CLI mode (two divergences to flag)

The TUI uses `ClackUIAdapter` + `LiveTaskRegistry` to render a live bar; the CLI uses
`NoopUIAdapter` (or `CollectingUIAdapter` under `--json`). Two divergences from v1 deserve a
logged entry, not a silent decision:

1. **v1 prints a `cli-progress` bar to stderr** in interactive runs (`tui/display.ts:54-68`).
   Phase 5's human-readable `run` path *does* print a one-line progress summary to stderr per
   checkpoint (or a `ora` spinner title), but **not** a `cli-progress` bar - the bar lib is
   v1-only and the v2 engine already emits `chapter.done` events. **ADR-P5-C candidate:** use a
   minimal stderr line-per-checkpoint format (`[12/250] chapter_title`), no `cli-progress` or
   `ora` dependency in the new CLI adapter - keeps the v2 adapter surface lean and matches
   "JSON output never carries ANSI codes".
2. **`--json` mode silences stderr entirely** except for the final JSON envelope on stdout
   (and a fatal-error JSON on stderr if the process crashes). No interleaved progress lines - a
   CI consumer can `jq` the output reliably.

### 1.8 JSON envelope shape (stability contract)

A single tagged-union envelope keeps CI assertions simple and stable:

```ts
type JsonResult =
  | { ok: true; command: string; data: unknown; }       // read commands
  | { ok: true; command: "run"; data: RunResultJson }    // run command
  | { ok: false; command: string; error: { code: string; message: string; details?: unknown } };
```

`RunResultJson` = `{ outputPath, chapters, totalWords, scrapeMs, errors: ScrapeError[],
session?: { id, completedCount, totalChapters } }`. The `session` field is populated only when
the run ended with a checkpoint on disk (partial completion or `--resume` mid-run), so a CI
script can decide whether to re-resume. **This shape is the published contract**; Phase 6 docs
reference it. The `JsonResult` lives in a new `src/adapters/cli-json/envelope.ts` (typed,
zod-validated on output for round-trip safety).

### 1.9 What Phase 5 does NOT own

- The **EPUB output** is owned by `ArchiverEpubWriter` (Phase 1). CLI just passes
  `job.outputDir` / `job.outputFilename` through. No EPUB change.
- The **scrape engine** (`ScrapeService`, `DiscoveryService`, the challenge/retry math) is
  locked from Phase 1/4. CLI never re-implements queue behavior.
- The **bin repoint for v1 deletion** is Phase 6. Phase 5 adds `dev:v1` precisely so v1 stays
  reachable for the benchmarks and parity diffs Phase 6 needs.
- The **benchmark script** (`scripts/benchmark.ts`) is Phase 6. Phase 5's `--json` envelope is
  what the benchmark will consume to assert "v2 >= v1 speed", but the benchmark itself is out
  of scope here.
- The ADR-P4-C deferred piece (threading `maxRetries` + full launch-opts from `AppConfig`
  into `ScrapeService.run`) is *still* deferred - Phase 5 doesn't expand the engine's surface
  either. The CLI `run` uses the same hardcoded defaults Phase 1 set; a follow-up (tracked in
  phase-4/deviation-log D5) lands the full thread.

---

## 2. Design

### 2.1 Module layout (additions to `src/app/` + one adapter dir)

```
src/app/
├── cli.ts                    # EXTEND: full cac command tree; boots via main()
├── runJob.ts                 # minor - thread --resume / --cookies-file from caller
├── doctor.ts                 # untouched (already implemented Phase 2)
├── tui.ts                    # untouched (Phase 3/4 composition root)
└── cliCommands/             # NEW dir - one file per command (keeps cli.ts thin)
    ├── run.ts                # run + resume alias
    ├── cookies.ts            # ls / add / rm
    ├── profiles.ts          # ls / rm
    ├── sessions.ts          # ls / rm
    ├── config.ts            # get / set / reset
    └── doctorCmd.ts         # doctor (wraps app/doctor.ts:runDoctor)

src/adapters/
└── cli-json/                # NEW adapter dir - JSON envelope + CollectingUIAdapter
    ├── envelope.ts           # JsonResult type + emitJson(result) + zod-validated output
    └── CollectingUIAdapter.ts # UIAdapter that records ScrapeEvent[] for run --json

schemas/
└── job.schema.json          # NEW - committed, generated from jobConfigSchema

package.json                 # bin repoint + dev:v1 script
```

No `core/` change. No `ports/` change. The only files *touched* outside `src/app/` and
`src/adapters/cli-json/` are `package.json` (bin) and the new `schemas/job.schema.json`.

### 2.2 The `cli.ts` shell - global options + command dispatch

```ts
// app/cli.ts (skeleton - the actual command bodies live in cliCommands/)
import { cac } from "cac";
import { runCommand } from "./cliCommands/run.js";
import { cookiesCommand } from "./cliCommands/cookies.js";
// ...

const cli = cac("wnscrape");

// Global options every subcommand inherits.
cli
  .option("--json", "Emit machine-stable JSON on stdout (no ANSI)", { default: false })
  .option("--quiet, -q", "Suppress stderr progress lines", { default: false });

cli.command("run", "Run a scrape job from a YAML file")
  .option("--job <file>", "Path to job YAML file")
  .option("--resume <id>", "Resume from a session checkpoint id")
  .option("--cookies-file <f>", "Path to a v1 cookie-snippet JSON file")
  .option("--validate-only", "Validate the job file and exit (no browser)")
  .action(async (opts) => runCommand(opts));

cli.command("resume <id>", "Alias: run --resume <id>")
  .action(async (id, opts) => runCommand({ ...opts, resume: id }));

cli.command("tui", "Launch the interactive shell")
  .action(async () => (await import("./tui.js")).main());

cli.command("sessions ls", "List resumable session checkpoints")
  .action(async (opts) => sessionsLsCommand(opts));

cli.command("sessions rm <id>", "Delete a session checkpoint")
  .action(async (id, opts) => sessionsRmCommand(id, opts));

// cookies ls / cookies add / cookies rm ...
// profiles ls / profiles rm ...
// config get / config set / config reset ...
// doctor

cli.help();
cli.parse();
```

`cli.ts` stays under ~80 LOC - each `.action` is a one-liner that delegates to
`cliCommands/<name>.ts`. The `--json` and `--quiet` globals are read by every command via
`opts.json` / `opts.quiet`, never buried inside a command body.

### 2.3 The JSON envelope + `CollectingUIAdapter`

```ts
// adapters/cli-json/envelope.ts
export type JsonResult =
  | { ok: true; command: string; data: unknown }
  | { ok: false; command: string; error: { code: string; message: string; details?: unknown } };

export function emitJson(r: JsonResult): void {
  // Validated against a zod schema of JsonResult itself - round-trip safe.
  // Written to stdout with a trailing newline; never coloured.
  process.stdout.write(JSON.stringify(r) + "\n");
}

// adapters/cli-json/CollectingUIAdapter.ts
export class CollectingUIAdapter implements UIAdapter {
  readonly events: ScrapeEvent[] = [];
  emit(e: ScrapeEvent): void { this.events.push(e); }
  onProgress?(_cb: (done: number, total: number) => void): void {}
}
```

`runCommand` uses it like:

```ts
const ui = opts.json ? new CollectingUIAdapter() : new NoopUIAdapter();
const result = await runJob(job, { log, ui, cookies, resumeSessionId: opts.resume });
if (opts.json) emitJson({ ok: true, command: "run", data: toRunResultJson(result, ui.events) });
else console.log(`Done: ${result.chapters.length} chapters, ${result.totalWords} words, ...`);
```

The `--json` envelope is the *only* stdout output under `--json`; everything else (progress,
warnings, fatal stack) goes to stderr as a structured JSON error on failure.

### 2.4 `cookies add --file` - the one genuinely new behaviour

v1 has three cookie-input flows (paste-header, key-value loop, browser-capture). The CLI only
needs `--file` (the roadmap's named flag). Two accepted file shapes, auto-detected:

1. **v1 cookie-snippet JSON** - `{ cookies: [{ name, value, path, expires, httpOnly, secure,
   sameSite }] }` (the same shape `cookiesFile` job field reads). Round-trips with v1 export.
2. **`Cookie:` header string** - a single line like `session=abc; theme=dark`. Parsed via
   `parseCookieHeader` (already in `core/domain/Cookie.ts:63`).

Domain and profile are required (`--domain`, `--profile`); label is optional. The cookies are
upserted via `CookieStore.upsert(domain, profile, cookies)`, which preserves `createdAt` /
`lastUsedAt` of an existing profile - exactly the v1 "merge-by-name" semantics (`cookies/store.ts`
upsert path).

The roadmap lists only `cookies add --file`, so the interactive add flows (paste-header,
key-value) stay TUI-only. The CLI deliberately does **not** grow a `cookies add --header` or
`cookies add --interactive` flag - YAML/JSON file is the script-friendly boundary.

### 2.5 `config set` - schema-driven coercion (ADR-P5-B)

```ts
// cliCommands/config.ts
async function configSetCommand(key: string, rawValue: string, opts) {
  const cfg = new YamlConfigStore(log);
  const partial = { [key]: rawValue };
  const parsed = appConfigSchema.partial().safeParse({ [key]: coerce(rawValue) });
  // ^^^ zod coerces strings to number/boolean/enum per the schema; the `.partial()
  //     makes unknown keys a parse error that goes back to the user as a zod issue
  if (!parsed.success) {
    if (opts.json) emitJson({ ok: false, command: "config set", error: { ... } });
    else console.error(parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  await cfg.write(parsed.data as Partial<AppConfig>);
  // ...
}
```

The coercion table v1 keeps in `config/appConfig.ts` (boolean/number/enum/"null for
fingerprintSeed") is **not duplicated** - the zod schema is the single source of truth. A
`z.string().transform((v) => v === "null" ? null : Number(v))` upgrade on
`fingerprintSeed` (currently `z.number().nullable()`) is the one additive schema tweak that
makes the string-from-CLI-flag coerce correctly.

### 2.6 `doctor` - wiring only

`runDoctor()` (`app/doctor.ts:252`) already returns a `DoctorReport`. The CLI command:

```ts
cli.command("doctor", "Validate binary, config, and stores")
  .option("--fix", "Stamp schemaVersion on out-of-date stores")
  .action(async (opts) => {
    const report = await runDoctor({ fix: opts.fix, log });
    if (opts.json) emitJson({ ok: report.exitCode === 0, command: "doctor", data: report });
    else renderDoctorReport(report);   // human: per-check pass/fail/warn lines
    process.exit(report.exitCode);
  });
```

No new logic. The human renderer (`renderDoctorReport`) lives in `cliCommands/doctorCmd.ts`
(chalk pass/fail/warn colors OK here - it's a human path, not the JSON path).

### 2.7 The schema publish step

Add a `pnpm gen:schema` script that emits `schemas/job.schema.json` from `jobConfigSchema`
via `zod-to-json-schema`. Wire it into `prebuild` so the committed file is always up to date:

```
"scripts": {
  "gen:schema": "tsx scripts/gen-job-schema.ts",
  "prebuild": "pnpm clean && pnpm gen:schema"
}
```

`scripts/gen-job-schema.ts` is a ~20 LOC file: `import { jobConfigSchema } from ...`,
`JSON.stringify(zodToJsonSchema(jobConfigSchema), null, 2)` -> `schemas/job.schema.json`. The
file is versioned (a header comment notes "Generated - do not edit; regenerate via
`pnpm gen:schema`"). The `run --validate-only` flag loads the published schema (or just
re-runs `jobConfigSchema.safeParse`, the source of truth) and exits 0/1 without a browser.

### 2.8 Boundary changes required (minimal, all in adapters/app)

1. **`runJob` threading** - `RunJobOptions` already carries `cookies` + `resumeSessionId`;
   the changes are in `cliCommands/run.ts` (read `--cookies-file` to `DomainCookie[]`,
   pass `resumeSessionId`). One thin helper `loadCookiesFile(path): DomainCookie[]` lives in
   `cliCommands/cookies.ts` (reused by `cookies add --file`).
2. **`appConfigSchema` additive tweak** - `fingerprintSeed` accepts a string `"null"` from CLI
   and coerces to `null`. **This is the only core-adjacent schema change**, and it's purely
   additive (the schema already accepts `number | null`; the new string-coercion branch only
   fires when the input is a string, which today never happens because YAML parses `null`
   natively). No v1 behavior change for TUI users.
3. **No `ScrapeService`, `DiscoveryService`, store, or EPUB change.**

### 2.9 What Phase 5 does NOT own (recap)

- The v1 deletion, benchmark script, README rewrite - Phase 6.
- The ADR-P4-C deferred `maxRetries`+full-launch-opts thread - a separate follow-up
  (phase-4/deviation-log D5). The CLI uses the engine defaults for now, identical to the TUI.
- New cookie-input modes beyond `--file`. Paste-header + key-value stay TUI-only.
- A live progress bar for the human-readable `run` path. ADR-P5-C explicitly chooses a
  one-line-per-checkpoint stderr format to avoid pulling `cli-progress` into v2.

---

## 3. Test plan (maps 1:1 to roadmap acceptance)

All tests are unit-level: real stores on isolated XDG dirs (Phase 2/3/4 test pattern),
`FakeBrowserPort` for any path that would launch a browser, `CollectingUIAdapter` for
`--json` envelopes. No TTY, no public internet, no CloakBrowser binary.

| # | Test | Fixture / harness | Asserts |
|---|---|---|---|
| T1 | **`run --job` happy path emits human + JSON envelopes** | `FakeBrowserPort` + fixture job YAML + `CollectingUIAdapter` | human path: stdout has "Done: N chapters"; JSON path: `emitJson` envelope `{ok:true, command:"run", data:{outputPath, chapters, totalWords, scrapeMs, errors}}`; envelope round-trips through a zod `JsonResult` schema (no chalk codes) |
| T2 | **`run --resume <id>` resumes from a checkpoint** | `JsonSessionStore` with a midpoint session + `FakeBrowserPort` | already-completed chapters NOT re-requested (`browser.visitedUrls`); `result.chapters` count == session.completedChapters + new; session file deleted after EPUB build (Phase 1 invariant) |
| T3 | **`run --cookies-file <f>` injects cookies** | cookie snippet JSON file + `FakeBrowserPort` recording `createContext` cookies | cookies from the file land in the context; v1 snippet shape + `Cookie:` header string both accepted |
| T4 | **`run --validate-only` exits before browser launch** | fixture job YAML | exit 0 on valid; exit 1 on invalid with zod issues on stderr (JSON envelope under `--json`); `FakeBrowserPort.launch` never called |
| T5 | **`resume <id>` alias == `run --resume <id>`** | same as T2 | identical `JobConfig` reaches `runJob`; alias delegates, no duplicate logic (`cliCommands/run.ts` shares one function body) |
| T6 | **`sessions ls` + `sessions rm` parity** | `JsonSessionStore` with 0/1/N sessions | `ls` human path lists id/title/done/total; JSON path emits `SessionSummary[]` matching `SessionStore.list()`; `rm <id>` deletes (re-list shows it gone); `rm <bogus>` exits 1 |
| T7 | **`cookies ls` + `cookies add --file` + `cookies rm` parity** | `JsonCookieStore` isolated XDG | `ls` JSON matches `CookieStore.listDomains`+`listProfiles`; `add --file` upserts (merge-by-name preserves `createdAt`); both file shapes accepted; `rm --profile` and `rm --all` match the store's `deleteProfile`/`deleteDomain` semantics |
| T8 | **`profiles ls` + `profiles rm --domain` parity** | `JsonProfileStore` isolated XDG | `ls` JSON matches `ProfileStore.list()`; `rm` returns the store's boolean and exits accordingly |
| T9 | **`config get` + `config set` + `config reset`** | `YamlConfigStore` on isolated XDG (incl. a v1 `config.json` to migrate) | `get` JSON emits the full `AppConfig`; `get --key defaultConcurrency` emits the scalar; `set` writes via zod-coerced value (`config set humanPreset careful` -> careful; `config set fingerprintSeed null` -> null); unknown key exits 1 with zod issue; `reset` rewrites defaults; unknown keys preserved on `set` (v1 invariant) |
| T10 | **`doctor [--json] [--fix]` wiring** | `runDoctor` with a real XDG dir + `--fix` on a v1-stamp store | human path renders per-check pass/fail/warn; JSON path emits `DoctorReport`; exit code matches `report.exitCode` (0/1/2); `--fix` stamps `schemaVersion` (the `checkStoreFiles` `--fix` branch already exists) |
| T11 | **`--json` stability: every read-only command emits the envelope** | all of the above | each command's JSON output parses against the published `JsonResult` shape; failures emit `{ok:false, command, error:{code, message}}`; no stdout output besides the envelope |
| T12 | **`tui` subcommand boots the shell** | smoke test that `main()` from `app/tui.ts` is imported and called (mock the Shell) | `wnscrape tui` calls `tui.main()` exactly once; the shell is the same composition root as `pnpm dev:tui` |
| T13 | **bin repoint + dev:v1** | `package.json` assertions | `bin.wnscrape` == `./dist/app/cli.js`; `scripts.dev` runs `tsx src/app/cli.ts`; `scripts.dev:v1` runs `tsx src/index.ts` (v1 oracle still reachable); `pnpm build` produces `dist/app/cli.js` |
| T14 | **schema publish** | `scripts/gen-job-schema.ts` + a fixture job YAML | `pnpm gen:schema` writes `schemas/job.schema.json` matching `jobConfigSchema`; the schema validates a valid fixture and rejects an invalid one (fixtures/job-good.yaml -> ok, fixtures/job-bad.yaml -> AJV errors) |

Network isolation: T1/T2/T3/T5 use `FakeBrowserPort` (no real browser, no network). No
acceptance-gated tests are added in this phase - the `CLOAKBROWSER_BINARY_AVAILABLE=1` suite
(Phase 1/4) already covers the real-binary end-to-end path.

## 4. Acceptance mapping (roadmap Phase 5)

- *"Everything achievable in the TUI is achievable via CLI without prompts."*
  → T1 (run), T2/T5 (resume), T6 (sessions), T7 (cookies), T8 (profiles), T9 (config),
  T10 (doctor). The TUI's interactive add-flows (paste-header, key-value, browser-capture)
  are explicitly scoped to T1's `cookies add --file` for the CLI - the one input mode that's
  scriptable. The browser-login capture remains TUI-only (a non-interactive capture is a
  contradiction in terms). Logged as a deliberate scope boundary in §2.4.
- *"JSON output validates against a stable schema (no chalk codes)."*
  → T1 + T11: every read-only command's `--json` envelope parses against the published
  `JsonResult` zod schema; a `chalk`-code grep on `cliCommands/*` + `cli-json/*` under `--json`
  paths returns zero matches.
- *"CI job runs `wnscrape run --job fixtures/job.yaml --json` and asserts on exit code + EPUB hash."*
  → T1 + T4 + the committed `run --json` envelope: a CI script can `jq '.ok'`, `jq '.data.outputPath'`,
  hash the EPUB, and match `jq '.data.chapters'` against a golden count. The envelope shape is
  the published contract.
- *"Job-file schema published at `schemas/job.schema.json`."*
  → T14 + §2.7 (`pnpm gen:schema` -> committed file; `run --validate-only` consumes it).
- Parity delivered: none (all new capability - the roadmap is explicit). The phase does NOT
  regress any audit section (traceability table row 5: "new capability - no parity risk");
  T1-T14 are net-additive.
- v1 oracle safety: `src/index.ts`, `src/tui/*`, `src/sites/*`, `src/types.ts` stay
  byte-untouched and compiling; `pnpm dev:v1` still runs v1. The bin repoint is the only
  `package.json` change; `dev:v1` is the escape hatch.

## 5. Work breakdown (suggested commit order)

1. **Foundation:** `src/adapters/cli-json/` (`envelope.ts` + `CollectingUIAdapter.ts`), the
   `JsonResult` zod schema, and `scripts/gen-job-schema.ts` + `schemas/job.schema.json`. Green.
2. **`run` flags + `--json`:** refactor `app/cli.ts` to the thin-shell shape (§2.2), pull the
   run command into `cliCommands/run.ts`, add `--resume` / `--cookies-file` / `--validate-only`
   and the JSON envelope (T1, T3, T4, T11).
3. **`resume <id>` alias** (T5) + `sessions ls` / `sessions rm` (T6).
4. **`cookies ls` / `cookies add --file` / `cookies rm`** + the shared `loadCookiesFile`
   helper (T7).
5. **`profiles ls` / `profiles rm`** (T8).
6. **`config get` / `config set` / `config reset`** with schema-driven coercion; the one
   additive `fingerprintSeed` string-coercion tweak (T9).
7. **`doctor` wiring** + human renderer (T10).
8. **`tui` subcommand + bin repoint + `dev:v1`** (T12, T13).
9. **Prebuild hook for `gen:schema`** (T14 invariant) + the `--validate-only` flag consuming
   the published schema.

**Phase 5 done when:** `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm lint` are green
with the new suite, `wnscrape` (binary) is the v2 CLI, `wnscrape run --job <f> --json` emits a
stable envelope a CI script can `jq`, every read-only command honors `--json`, and
`schemas/job.schema.json` is published and consumed by `--validate-only` - and every
divergence from this proposal traces to an ADR-P5-* or a deviation-log entry as the code lands.

---

## Appendix - decisions to confirm before implementing (ADR-P5-*)

| ID | Question | Recommendation |
|---|---|---|
| ADR-P5-A | The roadmap lists `resume` as a standalone command; the honest equivalent is `run --resume <id>`. Ship the alias? | **Yes** - `wnscrape resume <id>` delegates to `run --resume <id>` (reads the session's embedded config, no `--job` needed). One shared function body; no duplicated logic. |
| ADR-P5-B | `config set` needs per-key type coercion. Hand-roll a table like v1, or coerce via the zod schema? | **Yes - zod.** `appConfigSchema.partial().safeParse({ [key]: rawValue })` is the single source of truth; the one additive tweak is `fingerprintSeed` accepting `"null"` -> `null`. Avoids the audit-P5 "make twice" pattern. |
| ADR-P5-C | The human-readable `run` path: pull in `cli-progress` for a bar, or one-line-per-checkpoint stderr? | **One-line stderr.** Keeps the v2 adapter surface lean, no new heavy dep, matches "JSON never carries ANSI". `cli-progress` stays v1-only; Phase 6 deletes it. |

These are proposed, not decided - implementers should confirm each before landing, and record
the outcome in `docs/phase-5/adr.md` + `deviation-log.md` as the code lands, matching the
post-implementation pattern of phases 1-4.
