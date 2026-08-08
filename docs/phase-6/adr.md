# Phase 6 - Architecture Decision Record (post-implementation)

This is the consolidated ADR for Phase 6 ("Polish, docs, and v1 source removal"). It records the
decisions the readme (`docs/phase-6/readme.md`) flagged as ADR candidates: ADR-P6-A (benchmark
skip) and ADR-P6-B (logger factory). For chronological divergence see
`docs/phase-6/deviation-log.md`. For the top-level project ADRs (ADR-001 ... ADR-006) see
`docs/01-architecture-decisions.md`.

This file is written after the code landed; every "Evidence" line points at shipped files.

---

## ADR-P6-B - Logger factory replaces v1 singleton; preserves winston config + handlers (required)

**Context**

`src/logger/index.ts` (v1-era flat-layout path) constructed a winston singleton at module load
and registered `exceptionHandlers` + `rejectionHandlers` at import time. Eight surviving v2
files imported it directly (`import logger from "../../logger/index.js"`) and wrapped it via
`createWinstonLogger(logger)` to satisfy the `Logger` port:

```
src/app/cliCommands/{cookies,doctorCmd,config,profiles,sessions,run}.ts
src/app/tui.ts
tests/acceptance.test.ts
```

Per AGENTS.md: "Core services take a `Logger` port via constructor DI, not a winston import."
Importing a constructed singleton from a v1-era path violates the v2 hexagonal rule and is the
sole blocker preventing deletion of the v1 source tree (7 v2 files + 1 test import the logger
module; deleting v1 logger first would break the build).

The winston configuration itself (chalk pretty-print, rotating `error.log`/`combined.log`,
`exceptionHandlers` for `exceptions.log`, `rejectionHandlers` for `rejections.log`, `LOG_LEVEL`
env read, `logs/` mkdir with `exitOnError: false`) is correct and must survive v1 deletion - it
is the app's logging backend. Only the v1-era path + singleton shape must go.

**Decision**

Replace the singleton with a factory in the adapter layer. `src/adapters/logger-winston/WinstonLogger.ts`
now offers TWO exports:

1. `createWinstonLogger(winstonLike)` - **unchanged**. Thin DI wrapper; takes any
   `{debug,info,warn,error}` object behind the `Logger` port. Still used by tests that want to
   inject a fake winston-like object.
2. `createDefaultWinstonLogger()` - **new**. Builds and returns the winston instance using the
   EXACT configuration previously in `src/logger/index.ts:54-97` (transports, exceptionHandlers,
   rejectionHandlers, `LOG_LEVEL` env, `chalk` pretty-print, `logs/` dir creation). Returns a
   `Logger` directly (already wrapped via the same wrapper logic). Uses a single shared module
   scope for the `LEVEL_STYLES` / `consoleFormat` / `fileFormat` helpers.

The 7 v2 callers + the acceptance test change from:

```ts
import logger from "../../logger/index.js";
import { createWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
// ...
return json ? createSilentLogger() : createWinstonLogger(logger);
```

to:

```ts
import { createDefaultWinstonLogger } from "../../adapters/logger-winston/WinstonLogger.js";
// ...
return json ? createSilentLogger() : createDefaultWinstonLogger();
```

**Why a factory, not a singleton re-export:** keeps the v2 layer pure DI (AGENTS.md: "Core
services take a Logger port via constructor DI"). A singleton re-export from the adapter would
re-introduce the import-side-effect smell. The factory is called once per command invocation in
the CLI, once per TUI boot - cheap.

**Why not delete `src/logger/index.ts` in Step 0 (per readme §2.2 sequencing):** the readme
originally proposed deleting `src/logger/index.ts` as the final sub-step of Step 0. In practice
the v1 source tree (`src/{scraper,queue,sessions,cookies,sites,tui,...}/`) still imports
`../logger/index.js` directly (13 v1 files). Those v1 files are deleted only in Step 3.
Deleting `src/logger/index.ts` in Step 0 would break `pnpm typecheck` on v1 (TS2307 across 13
files), making the readme's Step 0 acceptance gate ("`pnpm typecheck && pnpm lint && pnpm test`
must be green") impossible to satisfy. Sequencing correction: `src/logger/index.ts` is deleted
in Step 3 alongside the rest of the v1 source tree, since after the Step 0 v2-caller migration
it is the LAST remaining importer of the v1 logger shape AND its deletion has to happen as part
of the v1-tree deletion to keep typecheck green at every step boundary. This is logged as
D-P6-B in the deviation log.

**The `cli.parse()` try/catch interaction:** `src/app/cli.ts` keeps its `try { cli.parse(argv); }
catch (e) { ... process.exit(1); }` wrapper (ADR-P5-F). Pre-migration the winston
`exceptionHandlers` were registered at module load (import time) of `src/logger/index.ts`, BEFORE
`cli.parse(argv)` ran synchronously, so a cac parse error was silently swallowed (exit 0, no
stderr). Post-migration the handlers register at factory-call time, INSIDE each command handler
- which runs AFTER `cli.parse(argv)` has already returned successfully. So the import-time
swallowing effect is gone in v2 by construction, and the try/catch wrapper remains correct (it
handles the parse-time throw directly, not via winston). The cli.ts comment was updated to
describe the new ordering.

**Trade-off:** any code that relied on winston's `exceptionHandlers` being registered BEFORE
`cli.parse()` would break. Audit: the 7 callers all call the factory INSIDE their command
handler, which runs after `cli.parse()` - so the import-time exception-handler effect is
already gone in v2, and ADR-P5-F's try/catch wrapper remains the correct fix.

**Evidence:** `src/adapters/logger-winston/WinstonLogger.ts` (the factory + the preserved
helpers), the 7 v2 caller rewrites (`src/app/cliCommands/{cookies,doctorCmd,config,profiles,
sessions,run}.ts`, `src/app/tui.ts`), `tests/acceptance.test.ts`, the updated `cli.ts` comment
at the `cli.parse(argv)` try/catch block.

---

## ADR-P6-A - Benchmark skip path: v2 ports v1's queue math verbatim (required)

**Context**

Roadmap acceptance bullet: "Benchmarks committed as `docs/benchmarks/v2.0.0.md`, showing
**>= v1 speed at equal concurrency** (or a recorded ADR explaining any regression)."

The user elected the **ADR-skip path**: do not run the real CloakBrowser binary benchmark
for the v2.0.0 release. Instead ship a short ADR asserting that v2 ports v1's queue math
verbatim, so by construction chapters/minute at a given concurrency is unchanged. The
benchmark harness (`scripts/benchmark.ts`) is still written and is drop-in ready for any
future contributor who elects a real run, but v2.0.0 ships this ADR in place of
`docs/benchmarks/v2.0.0.md` numbers.

**Decision**

Ship ADR-P6-A in place of `docs/benchmarks/v2.0.0.md`. The benchmark harness
`scripts/benchmark.ts` is written (drop-in) per the readme §2.3 spec: it boots a local HTTP
server with a 200-chapter fixture (mirroring `tests/acceptance.test.ts`), runs `runJob` at
concurrency 1 / 2 / 4, prints a markdown table of chapters/minute and peak RSS, and writes
`docs/benchmarks/v2.0.0.md` when invoked with `--write`. The script is gated behind
`CLOAKBROWSER_BINARY_AVAILABLE=1` so `pnpm install` + `pnpm test` never require a real
browser, and a plain `node scripts/benchmark.ts` exits 2 with a usage message.

**Rationale (no regression by construction):**

1. **v2's `ScrapeService` is a line-for-line port of v1's `queue/index.ts`.** The Phase 1
   deviation log (`docs/phase-1/deviation-log.md`) records that the queue math (the
   `p-queue` concurrency wiring, the retry backoff schedule, the checkpoint throttle
   interval) was ported verbatim from v1. The challenge-detection thresholds
   (`CHALLENGE_BODY_TEXT_MAX_LEN`, the three-tier DOM -> title -> body ordering) and the
   `SecurityChallengeError` longer-backoff multiplier (`CHALLENGE_BACKOFF_MS`, 45s) were
   likewise ported line-for-line. See AGENTS.md "Browser & scraping conventions" and the
   Phase 1 readme §3 test plan.

2. **Every per-chapter cost in v1 has an exact v2 counterpart.** Browser context pool:
   `PlaywrightBrowserPort` uses CloakBrowser's `ensureBinary()` + `buildLaunchOptions()`
   exactly as v1's `scraper/browser.ts` did (ADR-006). Resource blocking, cookie
   injection, and `Accept-Language`/`Accept`/`DNT` headers land at the same context layer.
   The EPUB build step uses `ArchiverEpubWriter` (port of v1's `epub/builder.ts`), validated
   against the v1 reference structure in `tests/epub-archiver.test.ts`.

3. **The only v2 additions are the event bus + UIAdapter indirection per chapter.** A
   `ScrapeEvent` is emitted through `UIAdapter.emit()` for progress and status. Under the
   CLI human path, `NoopUIAdapter` discards the events (zero work per event); under `--json`,
   `CollectingUIAdapter` accumulates them in an array (one object per event). Per-chapter
   overhead is roughly one extra `Map.get` + one object allocation, negligible against the
   browser + cheerio + EPUB work that dominates each chapter.

4. **Concurrency pool and resource limits are identical.** v2 reuses `p-queue` with the same
   concurrency cap (default 2, max 5), the same per-task jitter range, and the same retry +
   challenge backoff math. No architectural choice in v2 widens the queue, the context pool,
   or the EPUB builder's working set in a way that would reduce chapters/minute.

5. **Peak RSS may differ slightly** from v1 because v2 keeps the in-memory `ScrapeEvent`
   log per run (under `CollectingUIAdapter`) and the hexagon adds a few small objects per
   chapter for the event envelope. This is expected and documented; it does not widen
   linearly with chapter count (the event log is bounded by the per-run UIAdapter
   collection policy, capped at the chapter count) and does not affect throughput.

**Why the ADR-skip and not a real run:** the user is the only consumer of the v1->v2
benchmark comparison, and they elected to invest the engineering time elsewhere. The
script is written and ready; a future contributor only needs to run
`CLOAKBROWSER_BINARY_AVAILABLE=1 pnpm tsx scripts/benchmark.ts --write` to materialize
`docs/benchmarks/v2.0.0.md` with real numbers. The ADR is the recorded evidence the
roadmap explicitly allows in lieu of numbers.

**Evidence:** `scripts/benchmark.ts` (the drop-in harness), `docs/phase-1/deviation-log.md`
(the line-for-line port record for `ScrapeService`), `tests/epub-archiver.test.ts` and
`tests/session-store.test.ts` (parity assertions), AGENTS.md "Browser & scraping
conventions" (the three-tier challenge detection carried over verbatim).
