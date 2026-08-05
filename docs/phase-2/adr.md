# Phase 2 - Architecture Decision Record

This is the consolidated ADR for Phase 2 ("Persistence and configuration"). It
records the design-time decisions from `docs/phase-2/readme.md` that acquired
new evidence during implementation, plus any new decisions introduced by the
implementation itself.

For a chronological deviation list see `docs/phase-2/deviation-log.md`. For the
top-level project ADRs (ADR-001 ... ADR-006) see `docs/01-architecture-decisions.md`.

---

## ADR-P2-A - Zod schemas live in `src/adapters/schemas/`, not `src/core/`

**Context**

The Phase 2 design (`docs/phase-2/readme.md` §2.1) places zod schemas under
`src/adapters/schemas/`. An alternative - putting them in `src/core/` -
would violate ADR-003's rule that core imports nothing from external
validation libraries. Zod is an adapter-level concern: it validates at
the I/O boundary (YAML/JSON file reads and writes), not inside the domain
where plain TypeScript interfaces suffice.

**Decision**

Schemas live in `src/adapters/schemas/` with a barrel export
(`src/adapters/schemas/index.ts`). Core domain types (`AppConfig`,
`JobConfig`, `CookieProfile`) and their `DEFAULT_CONFIG` constants remain
in `src/core/domain/` as pure interfaces - no zod imports in core.
Adapter implementations import the schemas at their constructor or
before writing to disk to validate and stamp schemaVersion.

**Consequences**

- `src/core/` has zero zod imports, upholding ADR-003.
- Adding a new schema means adding one file to `src/adapters/schemas/` and
  updating the barrel - no core changes needed.
- The schemas serve as **the single validation boundary** for every adapter:
  `YamlConfigStore` uses `appConfigSchema`, `JsonCookieStore` uses
  `cookieStoreDocumentSchema` and `cookieProfileSchema`, etc. This is the
  "single place" the roadmap promises.

**Evidence**

- `src/adapters/schemas/appConfig.ts`, `cookieProfile.ts`, `jobConfig.ts`,
  `session.ts`, `siteProfile.ts`, `index.ts`.
- `grep zod src/core/` returns nothing.
- `docs/phase-2/readme.md` §2.1 layout diagram.

---

## ADR-P2-B - `DomainCookie.domain` is bare hostname; dot-prefix lives in the adapter

**Context**

v1's `loadCookiesForProfile` (`src/cookies/store.ts:201-219`) reattached
`.${hostname}` on the cookie domain before handing it to Playwright, baking
Playwright semantics into the cookie store. After Phase 2, the `CookieStore`
port returns `DomainCookie[]` with a bare hostname domain (e.g.
`"wtr-lab.com"`). The browser adapter (playwright-core) maps this to
`".wtr-lab.com"` via `domainCookiesToPlaywright()` in
`adapters/browser-playwright/cookieMappers.ts`.

**Decision**

`DomainCookie.domain` is the bare hostname, matching the key in the
`CookieProfile` store. The `cookieMappers.ts` module in the
`browser-playwright` adapter adds the leading dot (Playwright's convention
for "valid for all subdomains"). This fixes audit P7: the store is now
driver-agnostic.

**Consequences**

- Changing the browser backend (a future Puppeteer evaluation per ADR-001)
  means writing a new `cookieMappers` file, not touching the store logic.
- `JsonCookieStore.load()` is the single return type for cookies loaded
  from a profile; the adapter is the single consumer. The invariant holds
  at the port boundary, not at the store.

**Evidence**

- `src/core/domain/Cookie.ts:22-24` - `DomainCookie` with bare
  `domain: string`.
- `src/adapters/browser-playwright/cookieMappers.ts:35-43` - leading dot.
- `docs/phase-2/readme.md` §1.2 line "this conversion moves to the adapter
  boundary".

---

## ADR-P2-C - Legacy cookie-array wrap persists synchronously on read (the one exception to "read never mutates")

**Context**

The migration guide §3 documented the legacy flat-array wrap
(`Record<hostname, StoredCookie[]>`) as writing back immediately after
migration (`cookies/store.ts:131-136`). Changing this behavior - making
the v2 read return migrated in-memory objects and only write back on a
subsequent save, like the sessions store - would make the migration guide
a liar (design §2.2 #1 specifically warns against this).

**Decision**

`JsonCookieStore.loadDocument()` detects when the `cookies.1to2` migration
actually wrapped a legacy-array domain (the `migratedLegacy` flag is true
when the pre-version was `1` and the post-version is `2`) and calls
`persistSync()` immediately, mirroring v1's `writeStore()` behavior after
the migration. For a clean v1 named-profile store (no legacy arrays), the
`schemaVersion` stamp is NOT written on read alone - it's lazily stamped
on the next write, matching the lazy-upgrade contract documented for
sessions (`05` §5: "stamped on next write, not on read").

**Consequences**

- The one exception §2.2 rule #1 documents is respected: an existing user
  who has a legacy pre-profile cookie store sees it upgraded immediately
  on first read (synchronously, matching v1's exact behavior).
- For non-legacy stores: all `schemaVersion` stamps are lazy, consistent
  with the other entities (profiles, sessions).
- T4 and T1 assert the legacy wrap changes the on-disk bytes immediately.

**Evidence**

- `docs/phase-2/readme.md` §2.2 rule #1 and exception text.
- `src/adapters/store-json/JsonCookieStore.ts` - `migratedLegacy`
  persistSync path.
- `tests/phase-2-stores.test.ts` T4 and T1.

---

## ADR-P2-D - `parseCookieHeader` is a core domain utility, not a store method

**Context**

Phase 2's test plan (T5) lists `parseCookieHeader` as part of the full
CookieStore surface, and v1's implementation sits idle in
`src/cookies/store.ts:386-406` despite having zero fs or external module
calls. Putting the parser inside the store adapter would force Phase 3's
TUI cookie-manager to import the JSON adapter (wrong dependency direction
in hexagonal architecture).

**Decision**

`parseCookieHeader(raw: string): StoredCookie[]` lives as a pure exported
function in `src/core/domain/Cookie.ts`. The `CookieStore` port does NOT
expose it as a method - the semantics are pure stdlib (string split), with
no fs and no Network. This follows Phase 1's pattern in
`src/core/domain/Domain.ts` (the `normaliseDomain` shared util).

**Consequences**

- Phase 3's TUI can invoke `parseCookieHeader()` when a user pastes a raw
  Cookie header string, without importing `JsonCookieStore`.
- The `CookieStore` port stays focused on operations that need mutable
  state; everything pure-portable lives in `core/domain`.

**Evidence**

- `src/core/domain/Cookie.ts` - `parseCookieHeader()`.
- Phase 3 dependency direction is preserved (TUI -> core, TUI -> adapter;
  core never imports adapter, no circular dep).

---

## ADR-P2-E - `config.json` -> `.bak` rename is synchronous; YAML write is atomic

**Context**

The migration guide §2 step 5 says "fsync, then rename
`config.json` -> `config.json.bak`". The `atomicWrite` utility is used for
the YAML write, but the rename is done with `fs.renameSync`. The two-step
ordering is: `await atomicWrite(yamlPath, ...)` then
`fs.renameSync(jsonPath, bakPath)`.

**Reason**

The rename is a single atomic path change (`rename(2)` on POSIX). Using
`atomicWrite` (write-tmp-then-rename, designed for content writes) for
this would add a tmp-file dance without benefit - the rename is itself
already atomic. Synchronous on the rename narrows the "YAML written but
rename not yet done" race window to one syscall, after which both files
exist consistently.

**Consequences**

- A crash between `atomicWrite` and `renameSync` leaves both
  `config.yaml` and `config.json` on disk; the next migration run
  no-ops (`noop-yaml-exists`) since YAML already exists.
- The v1 `config.json` is left alone for the user to delete manually,
  exactly as migration guide §2 step 1 prescribes.
- The fallback path in `YamlConfigStore.read()` correctly handles the rare
  race (if both files exist, YAML wins; if only JSON exists, migration
  runs).

**Evidence**

- `src/adapters/config-yaml/migrateJsonConfig.ts` - the rename step.
- `tests/phase-2-stores.test.ts` T2 asserts `.bak` exists after migration
  and the original bytes round-trip through the backup.

---

## ADR-P2-F - `runDoctor()` is a library function, not a CLI handler

**Context**

Phase 5 wires `wnscrape doctor` as a `cac` subcommand in `app/cli.ts`.
But Phase 2 still needs the acceptance-bullet "doctor() against synthetic
broken dirs" (T8) to be testable. So doctor must be callable as a function,
not only as a CLI command.

**Decision**

`src/app/doctor.ts` exports an async
`runDoctor(opts?: { fix?: boolean; log?: Logger }): Promise<DoctorReport>`.
The returned `DoctorReport` has `checks: DoctorCheck[]` and `exitCode`
(0 all-green / 1 any fail / 2 warn-only) so Phase 5's CLI can shell-exit
with the same code.

**Consequences**

- T8 runs `await runDoctor()` against isolated XDG dirs; no real
  `CloakBrowser` binary needed (the binary check reports `fail` but the
  function does not crash - see deviation D5).
- Phase 5's minimal wrapping means a single point of truth for the
  doctor's check-list order.

**Evidence**

- `src/app/doctor.ts` - `runDoctor` exported.
- `tests/phase-2-stores.test.ts` T8 calls `runDoctor` directly.

---

## ADR-P2-G - `jobConfigSchema` uses zod `.default()` for optional fields

**Context**

Phase 1's hand-rolled validator (`loadJobFile.ts:21-55`) filled inline
defaults (concurrency=2, delayMin=1200, separateTitle=false, etc.). Phase 2
replaces the whole function body with the zod schema per §2.5 ("one file,
one commit, no call-site changes"). zod `.default()` values are produced
during parse, so `separateTitle` defaults to `false`, `concurrency` to `2`,
`output.epub` to `true`, etc., matching Phase 1's defaults exactly.

**Decision**

Use zod built-in `.default()` on every field whose Phase 1 hand-rolled
default existed. Avoid a second-tier extra "defaults-fill" pass after
parsing.

**Consequences**

- Load logic is explicit: `parseJobConfig(...)` resolves all defaulted
  fields during parsing, not via a scattered "fillMissingKeys" pass
  afterwards.
- Schema version bumps complement regular zod default fields without
  needing to adjust the `loadJobFile` pipeline.
- The Phase 1 v1 fixture (`tests/fixtures/job.yaml`) still parses
  successfully (validated every Phase 2 `pnpm test` run).

**Evidence**

- `src/adapters/schemas/jobConfig.ts` - per-field `.default()` calls.
- `tests/phase-2-stores.test.ts` T9 - "parses valid yaml with defaults".

---

## Summary of Phase 2 deliverables

| Design item | Status | Evidence |
|---|---|---|
| `core/domain/AppConfig.ts` + `DEFAULT_CONFIG` | done | `src/core/domain/AppConfig.ts` |
| `core/domain/Domain.ts` (single `normaliseDomain`) | done | `src/core/domain/Domain.ts` |
| `src/adapters/store-json/paths.ts` (single source) | done | `src/adapters/store-json/paths.ts` |
| `src/adapters/store-json/atomicWrite.ts` | done | `src/adapters/store-json/atomicWrite.ts` |
| `adapters/schemas/` (5 zod schemas + barrel) | done | `src/adapters/schemas/*.ts` |
| `migrations/chain.ts` + `cookies.1to2` + `profiles.1to2` + `sessions.1to2` | done | `src/adapters/store-json/migrations/*` |
| `JsonSessionStore` upgrade (atomic writes, versioned reads) | done | `src/adapters/store-json/JsonSessionStore.ts` |
| `CookieStore` port (full v1 surface) | done | `src/ports/CookieStore.ts` |
| `JsonCookieStore` (full v1 behaviour port) | done | `src/adapters/store-json/JsonCookieStore.ts` |
| `JsonProfileStore` (v2 fields defaulted) | done | `src/adapters/store-json/JsonProfileStore.ts` |
| `cookieMappers.ts` (DomainCookie -> PlaywrightCookie) | done | `src/adapters/browser-playwright/cookieMappers.ts` |
| `ConfigStore` port | done | `src/ports/ConfigStore.ts` |
| `YamlConfigStore` + template + migrateJsonConfig + `.bak` | done | `src/adapters/config-yaml/*.ts` |
| `doctor.ts` (T8) | done | `src/app/doctor.ts` |
| T1-T9 tests (17 new) | done | `tests/phase-2-stores.test.ts` (54 total tests) |
| `loadJobFile` zod swap (T9) | done | `src/app/loadJobFile.ts` (`parseJobConfig` export) |

**Test totals:** 53 unit tests passing (36 Phase 1 + 17 Phase 2). 1
acceptance test registered (skipped unless `CLOAKBROWSER_BINARY_AVAILABLE=1`).
`pnpm typecheck`, `pnpm test`, and `pnpm build` are green.

**Hard constraints upheld:**
- No new code imports `playwright` (only `playwright-core`).
- v1 code in `src/scraper|queue|epub|sessions|tui|cookies|config` is
  untouched (Phase 6 will remove it).
- Every byte of v1 user data is read by v2 unchanged (T1 fixture suite).
- Unknown keys round-trip everywhere (T3, the deep-merge over raw on
  write).
- The legacy cookie-array migration keeps v1's write-immediately behavior
  (ADR-P2-C / deviation D2).
- Session files are deleted only after EPUB build succeeds (Phase 1
  assertion still holds; `JsonSessionStore.delete` is unchanged
  behaviorally).
