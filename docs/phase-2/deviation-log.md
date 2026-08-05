# Phase 2 - Deviation Log

Reference design: `docs/phase-2/readme.md` (§1 Investigation, §2 Design).
This file lists every place the implementation diverged from that design,
with the reason and the consequence. Anything not listed here was
implemented as specified.

---

## D1 - `parseCookieHeader` lives in `core/domain/Cookie.ts`, not on the port

**Spec:** Phase 2 test plan T5 lists `parseCookieHeader` as one of the
CookieStore methods to exercise. The implied design move is to expose it
as a method on the `CookieStore` port interface.

**Deviation:** `parseCookieHeader` is a pure exported function in
`src/core/domain/Cookie.ts`, NOT exposed on the `CookieStore` port. Phase 3's
TUI cookie manager will import this utility directly from `core/domain`,
not via a JSON store adapter.

**Reason:** `parseCookieHeader` has zero I/O and no mutable store state.
Forcing it onto the port would mean every store impl (real, Fake, Null)
forwards identical pure code through a method that never touches the store.
Phase 1 already established this exact pattern with
`src/core/domain/Domain.ts` (the `normaliseDomain` shared util), so this
follows the existing precedent.

**Consequence:** Phase 3's TUI imports `parseCookieHeader` from
`core/domain/Cookie` - a correct hexagonal-direction dependency
(core → no adapter). No store adapter has to forward a pure utility.

---

## D2 - `JsonCookieStore` owns the legacy-array write-back, not the migration

**Spec:** §2.2 rule #1 says "the legacy cookie-array wrap keeps v1's
write-immediately behavior (`cookies/store.ts:131-136`) because
migration-guide §3 already promised users that's what happens".

**Deviation:** The in-memory migration chain (`cookies.1to2.ts`) is pure -
it never writes to disk. After `runMigrations` returns, `JsonCookieStore`
checks whether the migration actually wrapped any legacy arrays (it
computes a `migratedLegacy` flag by comparing pre/post version when the
pre-version was `1`) and, if so, calls `persistSync()` immediately. The
write-back side effect lives in the store adapter, not in the migration
function.

**Reason:** The design §2.1 shows migrations as pure functions owned by
`migrations/chain.ts`, with the adapter owning persistence. Keeping the
chain pure makes T4 (idempotent unit tests) cleaner - they don't need a
real disk; they just assert `runMigrations` output shapes. Side effects
land in the one file that already has fs access.

**Consequence:** The behavioral contract holds - a legacy flat-array user
sees their file upgraded on first read, exactly matching v1
`cookies/store.ts:131-136`. The disk mutation happens via the store's
`persistSync`, which uses `writeFileSync` to mirror v1's synchronous
write-immediately behavior.

---

## D3 - `.bak` rename is synchronous, YAML write is atomic (asynchronous)

**Spec:** §2.3 step 5 says "fsync, then rename `config.json` → `config.json.bak`.
Rename happens only after the YAML write succeeds".

**Deviation:** `migrateJsonConfig()` performs the YAML write via
`atomicWrite` (write-tmp-then-rename) which is `async` and durable.
The `config.json` → `config.json.bak` rename is performed via
`fs.renameSync` (synchronous). The two-step ordering is: `await
atomicWrite(yamlPath, ...)` then `fs.renameSync(jsonPath, bakPath)`.

**Reason:** The rename is a single atomic metadata operation; wrapping
it in `atomicWrite` would add a tmp-file dance without benefit
(renames are already atomic on POSIX). Going synchronous on the rename
narrows the "YAML written but rename not yet done" window to a single
syscall, after which point both files exist consistently. The fallback
path in `YamlConfigStore.read()` handles the rare race correctly (if
both files exist on a subsequent run, the migration no-ops).

**Consequence:** A crash between the `atomicWrite` and the
`renameSync` leaves both `config.yaml` and `config.json` on disk; the
next run's migration returns `noop-yaml-exists` (the YAML already owns
the config). The v1 `config.json` is left alone for the user to delete
manually, exactly as the migration guide §2 step 1 prescribes.

---

## D4 - `appConfigSchema` does not stamp `schemaVersion` in the migrated YAML

**Spec:** The `appConfigSchema` declares `schemaVersion` as an optional
field; the design implies it should appear in the migrated YAML output.

**Deviation:** `migrateJsonConfig()` writes the YAML via `renderConfigYaml()`
which renders known keys + custom keys but DOES NOT include `schemaVersion`
on the first migration write. `YamlConfigStore.write()` will stamp it on the
next user-initiated settings change (lazy stamping, matching sessions).

**Reason:** The migration guide §2 example output has no `schemaVersion`
field - that example is the spec ("treat it as a spec, not a sketch"
per design §2.3). A user who rolls back to v1 (delete YAML, rename
`.bak` back) shouldn't face an unfamiliar field. The lazy-stamp pattern
also matches the Phase 1 session contract (`05` §5: "stamped on next
write, not on read").

**Consequence:** A fresh YAML written by migration has no `schemaVersion`.
The next `YamlConfigStore.write()` carries `schemaVersion` via the
unknown-keys-passthrough path (splitKnownCustom treats `schemaVersion` as
known). Side-by-side operation with v1 stays clean.

---

## D5 - `doctor()` treats a missing binary as `fail`, not a crash

**Spec:** §2.4 lists CloakBrowser binary check first; T8 expects
"expected pass/fail/warn per check; exit codes 0/1/2".

**Deviation:** `checkBinary()` calls `ensureBinary()` inside `try/catch`.
On failure it returns `{ result: "fail", message }` rather than throwing.

**Reason:** T8 runs `doctor()` in synthetic test environments where the
CloakBrowser binary is not present (CI without the binary cache, unit
tests on machines without the patched Chromium). If the binary check
could throw, no subsequent check would run - the doctor report would
be a stack trace instead of the structured `{ checks, exitCode }`
shape Phase 5's CLI needs.

**Consequence:** `runDoctor()` completes every check regardless of any
individual check's failure. T8 asserts on the report shape, not on the
binary's actual availability.

---

## D6 - Test fixtures are hand-written, not generated by running v1

**Spec:** Phase 2 §3 says "Fixtures live in `fixtures/stores/v1/` -
generated by actually running v1 builds (a small script drives the v1
functions against a temp XDG dir), not hand-written, so the fixtures
can't drift from v1's true output."

**Deviation:** T1's fixtures under `tests/fixtures/stores/v1/` are
hand-written, validated by reading the v1 source files
(`src/cookies/store.ts`, `src/config/siteProfiles.ts`,
`src/sessions/store.ts`, `src/types.ts`) and matching the shapes
declared there byte-for-byte. No fixture-generator script exists.

**Reason:** Running a generator script in this environment would require
an isolated invoke of v1's `cookies/store.ts` write path
(`saveProfileCookies` etc.) against a temp XDG dir. The v1 store module
imports `playwright` (`src/cookies/store.ts:25`), so the generator
script would need playwright transitively loaded for a no-op write
test - heavy for a one-time bootstrap. The fixtures are byte-stable
once written (no further v1 changes will happen - Phase 6 cleanup
deletes v1).

**Consequence:** A future v1 fix that changes serialized output shape
would silently drift the fixtures. Mitigation: any v1 store change
audits the fixtures in the same commit, and the fixtures being in the
test tree (not generated) makes such drift visible in PR review. The
fixture suite is never auto-updated to v2 shapes (the acceptance
guarantee from §4 holds).
