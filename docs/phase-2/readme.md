# Phase 2 — Persistence & Configuration: Investigation & Design

Roadmap reference: `docs/04-implementation-roadmap.md` §"Phase 2".
Governing ADRs: ADR-003 (ports/adapters), ADR-004 (YAML for humans, JSON for machines).
Hard contract: `docs/05-migration-guide.md` — *every byte of v1 user data survives, zero manual steps*.

**Goal in one sentence:** all four v1 data stores (config, cookies, site profiles, sessions) sit behind
the Phase 1 ports as validated, versioned adapters; `config.json` auto-migrates to commented
`config.yaml`; `wnscrape doctor` proves the whole persistence layer is healthy.

---

## 1. Investigation — the four stores as they exist today

### 1.1 Global config (`src/config/appConfig.ts`, 156 LOC)

File: `<configDir>/config.json` where `configDir` resolves `$XDG_CONFIG_HOME` → platform fallback
(`:21-42`). Behavior inventory:

- **Defaults-first read** (`:119-131`): `{ ...DEFAULT_CONFIG, ...disk }` — missing keys fall back;
  unreadable file logs a warning and returns pure defaults (never throws).
- **Unknown-key preservation on write** (`:134-146`): `writeConfig` deep-merges over the *existing raw
  file*, so keys the app doesn't know about survive a settings edit. This is the single most
  important invariant for the YAML port — stripping user comments/keys on round-trip would be a
  silent v1 regression.
- **16 documented keys** (`:48-103`) — the commented YAML template in `05-migration-guide.md` §2
  already defines the target layout, key-for-key.
- `resetConfig()` exists (`:149-156`); must keep existing in v2's adapter (Settings screen, Phase 3,
  will call it; doctor's `--fix` flag may too).

Path resolution (`resolveConfigDir`/`resolveDataDir`) is **duplicated verbatim in three files**
(`appConfig.ts:21-42`, `cookies/store.ts:29-50`, `sessions/store.ts:20-41`, plus
`siteProfiles.ts:26-36`). The migration guide (§1 note) requires v2 to *reuse the same resolution
order*. Phase 2 extracts this **once** into `adapters/store-json/paths.ts` — this is one duplication
we are allowed to delete, because get-it-wrong = user data written to a different directory than v1
reads (the worst possible migration bug).

### 1.2 Cookie store (`src/cookies/store.ts`, 418 LOC)

File: `<dataDir>/cookies.json`, shape `Record<domain, Record<profile, CookieProfile>>`.

- **Already survived one migration**: legacy flat arrays (`Record<domain, StoredCookie[]>`) are
  auto-wrapped into a `default` profile on first read, discriminated by `Array.isArray()` (`:106-144`).
  The comment at `:101-105` explains why this is airtight — the two shapes can never be confused.
  v2 must port this migration *unchanged* and run it **before** its own v1→v2 stamp, per the
  "migration chain, never in-place rewrites" rule (`05` §9).
- **Rich mutation surface**: `saveProfileCookies` (replace, keep label/createdAt), `upsertProfileCookies`
  (merge-by-name), `deleteProfileCookie`, `deleteProfile` (prunes empty domain key, `:310-321`),
  `renameProfile` (refuses to clobber, `:337-350`), `setProfileLabel`, `markProfileUsed`,
  `parseCookieHeader`, `normaliseDomain`. The TUI (Phase 3) calls eleven of these; the port must
  expose **all of them** on `CookieStore`, not a minimal CRUD subset, or Phase 3 will stall.
- `loadCookiesForProfile` (`:201-219`) re-attaches `.${hostname}` as the cookie domain and passes
  `expires: -1` through as Playwright's session sentinel. In v2 this conversion moves to the
  **browser adapter boundary** — `adapters/browser-playwright/cookieMappers.ts` maps
  `DomainCookie` → `playwright.Cookie` — so the store stays driver-agnostic (fixes P7).
- Sorting semantics: `listProfiles` sorts by `lastUsedAt ?? updatedAt` desc, tie-broken by name
  (`:159-167`). The Phase 1 doc's session list sort (`updatedAt` desc, `sessions/store.ts:99`) and
  this one are both user-visible ordering contracts.

### 1.3 Site profiles (`src/config/siteProfiles.ts`, 121 LOC)

File: `<dataDir>/site-profiles.json`, shape `Record<domain, SiteProfile>`. Much simpler: read-all /
write-all, `saveProfile` preserves `savedAt`, refreshes `updatedAt` (`:91-105`), `deleteProfile`,
`listProfileDomains`. Own copy of `normaliseDomain` with identical rules to the cookie store's —
v2 ports domain normalisation **once** into `core/domain/Domain.ts` and both stores import it
(v1 duplicated deliberately; in v2 the ports make the shared util safe).

v2 additive fields per `05` §4: `schemaVersion`, optional `lastUsedAt` — both defaulted on read.

### 1.4 Sessions (`src/sessions/store.ts`, 117 LOC)

Directory of one-file-per-session JSON. Rusty spots to fix while porting:

- **No atomic write** (`saveSession`, `:54-57`): a crash mid-`writeFileSync` produces a truncated
  JSON file. v1's own `listSessions` acknowledges this ("a half-written file from a crash mid-save
  is possible", `:79-81`) and quietly drops such files — **silently losing a resumable scrape**.
  Phase 2 fixes this with write-tmp-then-rename (atomic on POSIX, near-atomic on Windows), while
  keeping the "skip unreadable file" tolerance.
- `findResumableSessionByUrl` is exact-string match on trimmed `entryUrl` (`:114-117`) — preserved.
- Schema is forward-compatible per `05` §5: v1 files carry no `schemaVersion`; treat that as
  **version 1 implicitly**. Phase 1 wrote sessions without a version stamp (deliberately — side-by-side
  safety); Phase 2's migration stamps `schemaVersion: 2` on *next write*, not on read, so Phase 1
  artifacts upgrade lazily with zero risk window.

### 1.5 Data-directory map (what doctor validates)

| Path | Owner | Format | Migration |
|---|---|---|---|
| `<configDir>/config.json` | v1 only | JSON | → `config.yaml`, rename to `.bak` |
| `<configDir>/config.yaml` | v2 | YAML (commented) | created by `ConfigStore` on first run |
| `<dataDir>/cookies.json` | both | JSON | legacy-array wrap → `schemaVersion: 2` stamp |
| `<dataDir>/site-profiles.json` | both | JSON | `schemaVersion` + defaulted new fields on read |
| `<dataDir>/sessions/*.json` | both | JSON | `schemaVersion: 2` stamped on next write |
| `./jobs/*.yaml` | v2 new | YAML | none — dir created on demand |

---

## 2. Design

### 2.1 Module layout

```
src/
├── core/
│   └── domain/
│       ├── AppConfig.ts          # + DEFAULT_CONFIG (ported defaults verbatim)
│       ├── Cookie.ts             # DomainCookie, CookieProfile (v1 shapes)
│       ├── SiteProfile.ts
│       ├── Session.ts            # (from Phase 1) + v2 fields defaulted
│       ├── JobConfig.ts          # (from Phase 1) now zod-backed
│       └── Domain.ts             # normaliseDomain — single implementation
├── ports/
│   ├── ConfigStore.ts            # NEW: read/write/reset AppConfig
│   ├── CookieStore.ts            # interface filled out to full v1 surface (§1.2)
│   ├── ProfileStore.ts
│   └── SessionStore.ts           # (from Phase 1) unchanged signature
├── adapters/
│   ├── config-yaml/
│   │   ├── YamlConfigStore.ts    # load/save/reset + json→yaml migration
│   │   ├── template.ts           # commented-YAML writer (05 §2 layout)
│   │   └── migrateJsonConfig.ts  # the one-shot migration + .bak rename
│   ├── store-json/
│   │   ├── paths.ts              # resolveConfigDir/resolveDataDir — single source
│   │   ├── atomicWrite.ts        # write-tmp + rename
│   │   ├── JsonCookieStore.ts
│   │   ├── JsonProfileStore.ts
│   │   ├── JsonSessionStore.ts   # upgraded: atomic saves, versioned reads
│   │   └── migrations/
│   │       ├── chain.ts          # generic runner: apply(migrations, raw) until current
│   │       ├── cookies.1to2.ts   # legacy-array wrap + schemaVersion stamp
│   │       ├── profiles.1to2.ts
│   │       └── sessions.1to2.ts
│   └── schemas/                  # zod schemas — single validation boundary
│       ├── appConfig.ts  jobConfig.ts  cookieProfile.ts  siteProfile.ts  session.ts
└── app/
    └── doctor.ts                 # wired to CLI in Phase 5; callable from Phase 2 tests
```

### 2.2 The migration chain mechanism (`migrations/chain.ts`)

Implements `05` §9's contributor contract:

```ts
interface StoreMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(raw: unknown): unknown;
}

function runMigrations(raw: unknown, chain: StoreMigration[], target: number): {
  data: unknown; migratedFrom: number | null;   // null = already current
} {
  let version = detectVersion(raw);              // absent schemaVersion → implicit 1
  const from = version === target ? null : version;
  for (const m of chain.filter(m => m.fromVersion === version)) {
    raw = m.migrate(raw); version = m.toVersion;
    if (version > target) throw new Error(`store newer than app (${version} > ${target})`);
  }
  return { data: raw, migratedFrom: from };
}
```

Design rules:

1. **Read never mutates.** Migrations produce the in-memory value; the file is only rewritten
   (stamped) on the next genuine write, or by an explicit `doctor --fix`. *Exception:* the legacy
   cookie-array wrap keeps v1's write-immediately behavior (`cookies/store.ts:131-136`) because
   `05` §3 already promised users that's what happens — changing it would make the guide a liar.
2. **A store newer than the app is a hard error**, not a silent passthrough. Running v1 against a
   v2-stamped cookie file must fail loudly from v1's own JSON intolerance — no, wait: v1 ignores
   unknown keys, so v2-stamped files *are* v1-readable. That's the side-by-side guarantee (`05` §2
   rollback) and it only holds because all v2 additions are optional-with-defaults. **Rule: every
   schema bump must be additive-optional or have a migration that fills defaults; never rename or
   retype a field without a chain entry.**
3. **Unknown keys preserved everywhere** — same semantics as v1's `writeConfig`, applied uniformly:
   zod schemas use `.passthrough()` at the top level of each store document, and writers round-trip
   the unrecognised keys.

### 2.3 `config.json` → `config.yaml` migration (`migrateJsonConfig.ts`)

Follows `05` §2 step-for-step:

1. If `config.yaml` exists → do nothing (v2 already owns the config; a stray v1 `config.json` is
   left for the user to delete — never touch it).
2. Read `config.json`; on parse failure, log, keep going from defaults (v1 behavior).
3. Merge over `DEFAULT_CONFIG`; validate with the `appConfig` zod schema (`.passthrough()`).
4. Write `config.yaml` via `template.ts`: every key present, sectioned and commented exactly as in
   the `05` §2 example (that layout is already published to users — treat it as a spec, not a sketch).
   Unknown keys appended under a `# ── Custom (preserved) ──` section.
5. fsync, then rename `config.json` → `config.json.bak`. **Rename happens only after the YAML write
   succeeds** — a crash between 4 and 5 leaves v1 fully functional (rollback path from `05` §2:
   delete YAML, rename back).

Backward read: if *only* `config.yaml` exists, obviously read it. If *neither* exists (fresh install),
write `config.yaml` from defaults immediately — mirroring v1's `ensureFile` (`appConfig.ts:106-116`).

### 2.4 `wnscrape doctor` (`app/doctor.ts`)

Checks, in order, each reporting pass/fail/warn + fixable-by-`--fix`:

| Check | Failure means |
|---|---|
| CloakBrowser binary resolves & `--version` runs | `executablePath` wrong — blocks all scraping |
| `config.yaml` parses and validates | migration half-failed |
| Data dir + sessions dir writable | permission problem |
| `cookies.json` / `site-profiles.json` parse; report `schemaVersion` of each, offer `--fix` stamp | pre-v2 file untouched since Phase 1 |
| Every `sessions/*.json` parses; count corrupt | crash-truncated file(s) — warn only, never auto-delete |
| Output dir writable or creatable | EPUB build would fail at the last step |

Exit code: 0 all-green, 1 any failure, 2 warnings only — so Phase 5 CI can gate on it.

### 2.5 Where this leaves Phase 1 seams

- Phase 1's hand-rolled `loadJobFile.ts` validator is **replaced** by the `jobConfig` zod schema —
  one file, one commit, no call-site changes (both export `parseJobConfig(yaml: string): JobConfig`).
  This is the only Phase 1 artifact Phase 2 deliberately deletes.
- `runJob`'s "cookies injected as array" seam (`--cookies` file) now has a real store behind it:
  `CookieStore.loadCookies(domain, profile)` feeds the same array. CLI plumbing stays Phase 5, but
  Phase 2 unit-tests the composition: job file + profile name → correct `DomainCookie[]`.
- `NoopStores` (Phase 1 test doubles) stay in `store-memory/` — they become the standard fake for
  service tests and keep Phase 1's test suite passing unchanged.

---

## 3. Test plan

| # | Test | Asserts |
|---|---|---|
| T1 | **v1 fixture round-trip**: real v1-shaped `config.json`, `cookies.json` (both profiled *and* legacy-array), `site-profiles.json`, 3 session files | all load; cookie counts / session progress counts identical to fixture manifest (`05` §5 test-fixture bullet) |
| T2 | Config migration writes commented YAML; `config.json.bak` exists; original bytes intact in `.bak`; rerun is a no-op | byte-compare `.bak` to fixture |
| T3 | Unknown-key preservation: config/profile/cookie docs with extra keys → write → keys still present; YAML comments survive a settings write round-trip | raw-text grep + parse |
| T4 | Cookie legacy wrap runs first, stamps v2 after; chain order enforced; double-run is idempotent | in-memory equality |
| T5 | Full CookieStore surface: save/upsert/deleteCookie/deleteProfile(domain prune)/rename(no-clobber)/label/clear-label/parseCookieHeader/lastUsed sort | port of v1 behavior table |
| T6 | Session atomic write: kill between tmp-write and rename via fault injection (`atomicWrite` takes injectable fs hooks) | original file unmodified; no `.tmp` left after next save |
| T7 | Newer-version store → hard error with version numbers in message | error shape |
| T8 | `doctor()` against synthetic broken dirs (unwritable, corrupt, missing binary) | expected pass/fail/warn per check; exit codes 0/1/2 |
| T9 | Zod boundary: invalid `job.yaml` fields rejected with human-readable paths; valid v1-named keys (e.g. `defaultConcurrency`) parse | snapshot of error messages |

Fixtures live in `fixtures/stores/v1/` — **generated by actually running v1 builds** (a small script
drives the v1 functions against a temp XDG dir), not hand-written, so the fixtures can't drift from
v1's true output.

## 4. Acceptance mapping (roadmap Phase 2)

- *"Running v2 against a v1 data directory upgrades it in place without losing cookies/profiles/sessions"*
  → T1–T4 + a manual checklist run on a copy of a real v1 data dir (recorded in the phase PR).
- *"`wnscrape doctor` validates binary path, config schema, store permissions"* → T8.
- Parity rule (`00` §4): no v1 schema becomes unreadable. Guard: T1 fixture suite is **never
  allowed to be updated to v2 shapes** — fixtures stay v1 forever; that's what keeps the promise
  enforceable in CI.

## 5. Work breakdown (suggested commit order)

1. `paths.ts` + `atomicWrite.ts` + `Domain.ts` (shared leaf utils; nothing imports yet).
2. Zod schemas + swap into Phase 1's `loadJobFile` (T9).
3. `JsonSessionStore` upgrade: versioned reads, atomic writes (T6) — smallest store, proves the chain runner.
4. `chain.ts` + cookie/profile migrations + full `JsonCookieStore` / `JsonProfileStore` (T4, T5).
5. `YamlConfigStore` + template + migration + `.bak` (T2, T3).
6. `doctor.ts` + tests (T8).
7. v1-fixture generator script + T1 + acceptance run.

**Phase 2 done when:** the fixture suite proves every v1 store readable and round-trippable, a real
v1 data dir upgrades in place with zero data loss, doctor reports accurately on healthy *and* broken
installs, and no module outside `adapters/` imports `fs` for store purposes.
