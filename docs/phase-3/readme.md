# Phase 3 - TUI Shell (non-scraping parts): Investigation & Design

Roadmap reference: `docs/04-implementation-roadmap.md` §"Phase 3".
Design spec: `docs/03-tui-design.md` (the v2 screen/shell contract).
Governing ADRs: ADR-002 (@clack/prompts + screen-shell), ADR-003 (hexagonal), ADR-005 (non-interactive CLI equivalent).
Hard contract: AGENTS.md - *v1 code in `src/tui/` stays untouched until the Phase 6 cleanup pass*,
and *enquirer is a v1-TUI-only dependency pinned at 2.4.1*.

**Goal in one sentence:** every non-scraping management screen of v1 - cookie manager, settings and
site-profile manager, resume picker, error reporting - plus the brand-new Library screen, runs under
one Clack-based screen shell (`adapters/ui-clack/`) with zero Enquirer imports in the running app,
while the v1 `src/tui/` files stay physically untouched until Phase 6.

---

## 1. Investigation - what Phase 3 must faithfully port

Phase 3 owns parity for audit sections *Cookies UI*, *Config UI*, and *Resume picker UI* (roadmap
traceability table, `04` §"Traceability"). Reading the v1 sources, the concrete behaviors that must
survive are:

### 1.1 Cookie manager (`src/tui/cookieManager.ts`, 753 LOC)

A domain -> profile -> cookie drill-down with four entry methods. Flow inventory:

| Flow | v1 location | Behavior to preserve |
|---|---|---|
| Domain list loop | `manageCookies` `:140-179` | Store path shown; `Add cookies for a new domain` and `Back` sentinel choices. |
| Add domain | `addDomainFlow` `:182-192` | `validateDomain` (`:57-67`): hostname or URL, must contain `.` or equal `localhost`. |
| Domain screen | `manageDomainFlow` `:197-259` | Zero-profile fast path (`:203-207`) skips straight to "add a new profile"; delete-all confirm (`:240-255`). |
| Profile action menu | `manageProfileFlow` `:264-341` | Six actions: add kv, paste header, browser capture, relabel, delete one, delete profile. |
| Add profile | `addProfileFlow` `:349-377` | Name prompt then method select (capture / header / kv / cancel); returns whether a profile was actually created. |
| Profile name | `promptProfileName` `:382-404` | Charset `[a-z0-9_-]` (`validateProfileNameChars` `:72-79`, `PROFILE_NAME_RE` `:70`); first profile suggests `default`, later ones no pre-fill; no-duplicate check. |
| Relabel | `relabelFlow` `:413-465` | Rename + label in one action; label cleared by blank; **uses `setProfileLabel`, not `saveProfileCookies`** - the comment at `:406-412` explains why (blank must clear, not keep). |
| Manual kv entry | `addCookiesFlow` `:468-578` | Loop until blank name; advanced options (path / secure / httpOnly / sameSite / expiry-days) with `-1` = session sentinel. |
| Raw header paste | `pasteHeaderFlow` `:581-629` | `parseCookieHeader` then confirm-save. |
| Browser capture | `captureViaLoginFlow` `:636-703` | Two-step begin/finish; **reuses `appCfg.fingerprintSeed`** so the login device fingerprint matches the later-scraping device (header comment `:631-635`); zero-cookies warn; save replaces profile. |
| Scrape-time resolution | `selectCookieProfileForScrape` `:712-753` | 0 profiles -> none, 1 -> auto-load + `markProfileUsed`, N -> picker with cookie counts and lastUsed. **Ported in Phase 3, consumed by Phase 4** (it reads the store only; it never scrapes). |
| Cookie table | `printCookieTable` `:82-122` | Index, name padded 32, value truncated, expiry (`session` for -1), httpOnly/secure flags. |

Validators (`validateDomain`, `PROFILE_NAME_RE`) and `truncate`/`profileMetaLine` are pure
presentation helpers - they move into the ui-clack adapter (`validation.ts` / `format.ts`), not into
core. `parseCookieHeader` already lives in `core/domain/Cookie.ts` (Phase 2 ADR-P2-D) - the screen
imports it from there, not from a store adapter.

**Store mapping** - every v1 synchronous `cookies/store.ts` call becomes the async `CookieStore` port
method (`src/ports/CookieStore.ts`, Phase 2), so the screens are `await`-aware throughout:

| v1 call | CookieStore port method |
|---|---|
| `listDomains()` | `listDomains()` |
| `listProfiles(d)` | `listProfiles(d)` |
| `getProfile(d, p)` | `getProfile(d, p)` |
| `describeProfile(d, p)` | `describeProfile(d, p)` |
| `loadCookiesForProfile(d, p)` | `load(d, p)` (returns `DomainCookie[] \| null`) |
| `saveProfileCookies(d, p, c, label)` | `save(d, p, c, label?)` |
| `upsertProfileCookies(d, p, c)` | `upsert(d, p, c)` |
| `deleteProfileCookie(d, p, n)` | `deleteCookie(d, p, n)` |
| `deleteProfile(d, p)` | `deleteProfile(d, p)` |
| `deleteDomain(d)` | `deleteDomain(d)` |
| `renameProfile(d, o, n)` | `renameProfile(d, o, n)` (no-clobber) |
| `setProfileLabel(d, p, l)` | `setLabel(d, p, l \| undefined)` |
| `markProfileUsed(d, p)` | `markUsed(d, p)` |
| `parseCookieHeader(raw)` | `core/domain/Cookie.parseCookieHeader` (pure) |

### 1.2 Settings & site profiles (`src/tui/configManager.ts`, 698 LOC)

- **Global settings** (`manageSettings` `:43-72` -> `editGlobalSettings` `:77-142`): print the config,
  then a group select - output, browser, perf, metadata, ux, reset, back. `editGroup` (`:145-366`)
  returns only changed keys; validated ranges: `navigationTimeoutMs >= 5000`, `concurrency 1-5`,
  delay `min-max` with `min >= 0`, `maxRetries 0-10`, `fingerprintSeed` blank or positive integer.
  Reset confirms then writes defaults. Unknown-key preservation on write is `ConfigStore.write`'s job
  (Phase 2), not the screen's.
- **Config display** (`printConfig` `:369-411`): 15 rows, values equal to `DEFAULT_CONFIG` shown dim,
  differing values shown cyan-bold with a `*` marker - a user-visible convention worth keeping.
- **Site profiles** (`manageSiteProfiles` `:416-450` -> `editSiteProfile` `:453-619`): list domains
  with `[toc]`/`[seq]` method tag and label; per-profile actions edit label/notes, edit selectors,
  edit perf overrides, delete. Selector edit joins `excludeSelectors` by `, ` and splits back.
  Perf edit keeps `undefined` (use global) when blank.
- **Profile display** (`printProfile` `:622-648`): uses `formatLocator` - **already ported to
  `core/services/SelectorService.ts:22`** (Phase 1), so the screen imports it from core, not from v1's
  `scraper/selectors.ts`.
- **`promptSaveProfile`** (`:654-698`) is the post-scrape save-profile prompt. **It lives in this file
  but is a Phase 4 deliverable** (roadmap Phase 4: "Post-scrape: summary card + optional profile-save
  prompt honoring `askSaveProfile`"). Phase 3 ports `manageSettings` and `manageSiteProfiles` only;
  `promptSaveProfile` is listed here so the Phase 4 boundary is explicit.

Store mapping: `readConfig`/`writeConfig`/`resetConfig` -> `ConfigStore.read()/write()/reset()`
(Phase 2); `siteProfiles.ts` calls -> `ProfileStore.load()/save()/list()/delete()`.

### 1.3 Resume picker (`src/tui/sessionManager.ts`, 83 LOC)

- `pickResumableSession` `:24-58`: list sessions by `updatedAt` desc, each line
  `title (completed/total chapters · domain · updated)`, plus `Delete a saved session` and `Back`.
- `deleteSessionFlow` `:60-83`: pick one to delete, confirm-less (delete is non-destructive to
  downloads - only the checkpoint goes).
- v2 store: `SessionStore.list()` already returns `SessionSummary[]` (id, novelTitle, domain,
  totalChapters, completedCount, updatedAt) sorted `updatedAt` desc (Phase 1 `session-store` parity),
  so the picker renders summaries directly; `delete(id)` for the delete flow.
- **Boundary:** the "resume" action (feed the session into `runJob`) is Phase 4. Phase 3 ships
  list/delete/details; the resume action is stubbed (see §2.4).

### 1.4 Error reporting (`src/tui/errors.ts`, 46 LOC)

- `reportError(context, e)` `:21-35`: log to Winston, render the message + the first 4 stack lines,
  then **block on a keypress** so the error can't scroll away.
- `reportNotice(lines)` `:37-46`: warn-render lines, block on keypress.
- v2: the Logger port replaces the winston import; the keypress block becomes a
  `PromptProvider`-driven acknowledge step (clack text/confirm), or - for the headless CLI
  equivalent - a plain return. The blocking semantics ("a failure can never disappear before it is
  read") are the parity contract.

### 1.5 Display & formatting (`src/tui/display.ts`, 136 LOC)

- `banner`, `section`, fixed-width `[INFO]/[OK]/[WARN]/[ERROR]` tags (`info/success/warn/err/dim`),
  `printParagraphs`, `printChapterList` - pure formatting, become `format.ts` in ui-clack. Fixed-width
  text tags (not emoji) and NO_COLOR degradation are 03-tui-design §8 requirements.
- `spinner` - the cookie capture flow uses "Launching browser..." -> clack's `spinner()`.
- `createProgressBar` and `summary` are **Phase 4** (TaskScreen, post-scrape card).

### 1.6 Ephemeral browser login capture (`src/cookies/capture.ts`, 102 LOC)

Two-step begin/finish/abort API so the TUI controls *when* to prompt, and each half is leak-safe:

- `beginCaptureSession(loginUrl, appCfg)`: launch headed (`headless: false`), `humanize: false`,
  reuse `appCfg.fingerprintSeed` (device-identity coherence, see `cookieManager.ts:631-635`),
  timezone `America/New_York`, locale from `defaultLanguage` (`en` -> `en-US`), open `loginUrl` with
  `domcontentloaded` and `appCfg.navigationTimeoutMs`. On any post-launch failure the browser is
  closed before the error propagates.
- `finishCaptureSession(session)`: read all context cookies (`context.cookies()`, no URL filter -
  unrelated cookies are inert on replay), map to `StoredCookie`, close the browser in `finally`.
- `abortCaptureSession(session)`: close browser (defensive escape hatch).

**v2 gaps found in the port surface:**
1. `BrowserPort.launchEphemeral?` is declared (`src/ports/BrowserPort.ts:62`) **and already
   implemented** in the Playwright adapter (`PlaywrightBrowserPort.ts:155` - it calls `launch`).
2. **There is no cookie read-back method on `BrowserPort`.** `finishCaptureSession` needs
   `context.cookies()`, which the port cannot express today. Phase 3 must add a named
   `contextCookies(ctx: ContextHandle): Promise<StoredCookie[]>` method (interface + Playwright impl
   + `FakeBrowserPort`). This is the one Phase 1 seam that was "merely not precluded" and now needs
   real shape - see ADR-P3-A. It is a *named* method (P4-safe by construction, same rule as
   `findElement`/`url` in Phase 1 deviation D3).
3. The capture module itself moves into ui-clack (`cookieCapture.ts`) and orchestrates
   `BrowserPort.launchEphemeral` + `newPage` + the new `contextCookies`, keeping the same
   begin/finish/abort contract. It belongs to the adapter, not core: it is browser lifecycle + the
   TUI's pacing, with no domain logic beyond mapping Playwright `Cookie` -> `StoredCookie` (which is
   already the adapter's `cookieMappers.ts` territory).

### 1.7 Boundary - what Phase 3 deliberately does NOT own

Roadmap Phase 3 scope is "non-scraping parts". Explicitly deferred to Phase 4:

- `NewScrapeScreen`, `ManualWizardScreen`, `AutoProbeScreen`, `AutoCustomizeScreen`,
  `ChapterListScreen`, `TaskScreen` (and the whole `tui/prompts.ts` / `tui/wizard.ts` /
  `tui/scrapeKeys.ts` surface).
- `promptSaveProfile` (post-scrape).
- The *consumption* of `selectCookieProfileForScrape` and the resume action (both ported/readied here).
- TaskRegistry population and the live progress rendering.

Phase 3 touches none of the scraping flow. The queue, discovery, EPUB, and session-flush-on-EPUB
deletion logic in `core/` is untouched.

### 1.8 Constraint reconciliation - roadmap says "delete tui/keys.ts", AGENTS.md says don't

Roadmap §Phase 3 scope includes "Replace Enquirer entirely; delete `tui/keys.ts` patch." AGENTS.md is
a standing hard rule: *v1 code under `src/tui/` stays untouched until the Phase 6 cleanup pass* - the
same Phase 6 that the roadmap itself reserves for "remove the v1 originals" (Phase 1 deviation D1).
These conflict on the word "delete".

**Reconciliation (see ADR-P3-C):** Phase 3 makes the running app Enquirer-free - the new shell is the
only TUI, no v2 file imports enquirer - but does **not** physically delete `tui/keys.ts` (or
`wizard.ts` / `prompts.ts`), does not unpin enquirer from `package.json`, and keeps `src/index.ts`
(v1 boot) compiling, so the v1 reference oracle stays runnable. Physical deletion and the enquirer
dependency removal land in Phase 6 with the rest of the v1 cleanup. The roadmap bullet is
reinterpreted as "remove Enquirer from the running product".

### 1.9 Missing dependency: `@clack/prompts`

ADR-002 chose `@clack/prompts`, but it is **not in `package.json` and not installed**. Phase 3 adds
it (plus its `@clack/core` transitives). Two library facts shape the design:

- `isCancel()` is the only "go back" primitive (ADR-002 decision #3) - there is no
  `CANCEL_SIGNAL`/prototype patch to carry over from `tui/keys.ts`.
- clack's **default cancel key is Ctrl+C**, which 03-tui-design §5 wants to mean *graceful quit*.
  Resolving this needs a deliberate keybinding decision (§2.6, ADR-P3-H): clack's cancel signal maps
  to "back one screen", and quitting happens only when the shell has nothing left to pop, while
  Ctrl+Q is handled by a shell-level raw-mode listener (not a library prototype patch).

---

## 2. Design

### 2.1 Module layout (`src/adapters/ui-clack/`)

```
src/adapters/ui-clack/
├── Shell.ts                  # shell chrome: header, footer, log region, screen stack,
│                             #   command-palette hook, graceful-quit listener
├── ShellContext.ts           # the context handed to Screen.render() (§2.2)
├── screens/
│   ├── MainScreen.ts         # top-level menu + ':' palette
│   ├── ResumeScreen.ts       # session list / delete / details (resume action stubbed)
│   ├── CookieManagerScreen.ts# domain -> profile -> cookie drill-down + capture
│   ├── SettingsScreen.ts     # global settings + site profiles (two sub-flows)
│   ├── LibraryScreen.ts      # NEW - list/open/delete EPUBs under output dir
│   └── ErrorScreen.ts        # reportError / reportNotice ports
├── PromptProvider.ts         # typed prompt seam around clack (§2.3) - the only clack import
├── ScriptedPromptProvider.ts # test double; shipped here so tests import one thing (or in store-memory)
├── cookieCapture.ts          # begin/finish/abort over BrowserPort.launchEphemeral + contextCookies
├── format.ts                 # deterministic 80-col chrome/table/tag renderers (§2.8)
├── validation.ts             # validateDomain / validateProfileNameChars / validateUrl
├── commandPalette.ts         # ':' command mode
└── ClackUIAdapter.ts         # ports/UIAdapter impl -> routes events to the log region
```

`src/app/tui.ts` is the composition root (§2.9): it wires `ConfigStore`, `CookieStore`,
`ProfileStore`, `SessionStore`, `BrowserPort`, and the `Logger` into the `Shell` and runs it.

The `Screen`/`ShellContext` contract stays in the adapter, exactly as the roadmap and 03-tui-design §6
place it - no new port file. `core/` gains nothing in Phase 3.

### 2.2 The Screen / ShellContext contract (from 03-tui-design §6, refined)

03-tui-design §6 gives a sketch; this is the normative Phase 3 shape:

```ts
// adapters/ui-clack/ShellContext.ts
export interface ShellContext {
  config:    ConfigStore;    // not a bare AppConfig - the Settings screen must write
  cookies:   CookieStore;
  profiles:  ProfileStore;
  sessions:  SessionStore;
  tasks:     TaskRegistry;   // type-only stub; populated in Phase 4
  navigate(to: string, params?: unknown): void;
}

export interface Screen {
  readonly id: string;
  render(ctx: ShellContext): Promise<ScreenResult>;
}

export type ScreenResult =
  | { action: 'push';   screen: string; params?: unknown }
  | { action: 'pop' }
  | { action: 'replace'; screen: string }
  | { action: 'quit' };
```

Refinements vs. the design doc, all flagged in ADR-P3-D:
- `config` is the `ConfigStore` port, not an `AppConfig` value (screens both read and write).
- The design's `cookies: CookieService` maps to the existing `CookieStore` port; `profiles` /
  `sessions` ports are added the same way. The shell depends on **ports only** - hexagonal direction
  is preserved (adapter -> ports -> core).
- `tasks: TaskRegistry` stays in the contract as a minimal, empty type so Phase 4's TaskScreen slots
  in without changing the interface. Phase 3 ships an empty registry implementation.

Navigation is an explicit stack inside `Shell`: `render()` returns a `ScreenResult`, the shell pushes
or pops, and re-renders the active screen. This replaces v1's recursive `mainMenu()` loop, which is
exactly the "stack of screens, not a cascade of standalone prompt() calls" ADR-002 asked for.

### 2.3 PromptProvider seam - screens never import @clack/prompts

clack renders straight to the terminal; it cannot be snapshot-tested and cannot be driven headlessly.
The roadmap's Phase 3 tests ("snapshot tests for screen layout", "headless simulation: cookie CRUD
via a scripted UI adapter") require the screen layer to be testable without a TTY. So:

```ts
// adapters/ui-clack/PromptProvider.ts
export interface PromptProvider {
  select<T extends string>(opts: { message: string; options: Array<{ value: T; label: string }>;
                                     initial?: T; hint?: string }): Promise<T | Cancel>;
  confirm(opts: { message: string; initial?: boolean }): Promise<boolean | Cancel>;
  text(opts: { message: string; initial?: string; placeholder?: string;
               hint?: string; validate?(v: string): boolean | string }): Promise<string | Cancel>;
  spinner(): { start(text: string): void; stop(text?: string): void };
  log(kind: 'info' | 'success' | 'warn' | 'error' | 'dim', msg: string): void;
}

export const Cancel = Symbol('cancel');   // isCancel() equivalent
```

- The real implementation (`clackPrompts.ts`) wraps `@clack/prompts` one-to-one and translates
  `isCancel()` to `Cancel`. `@clack/prompts` is imported **only here** - the whole adapter, and
  therefore the whole app, has one clack import site.
- `ScriptedPromptProvider` (test double, same pattern as `FakeBrowserPort`) records every
  `{ message, options, initial, validate }` descriptor it was offered and returns answers from a
  script. Screens cannot tell the difference, so walkthrough tests are plain vitest - no TTY, no
  timing, no snapshot flake from clack's internal rendering.
- `log` maps to clack's `log.*` API for body-level notices; the shell's log **region** (header strip,
  03-tui-design §3) is separate and fed by the `Logger`/UIAdapter path (§2.7).

This mirrors the established test-double precedent (`adapters/store-memory/FakeBrowserPort.ts`) and
keeps ADR-003 intact: clack is an adapter concern, invisible to core and to the rest of the app.

### 2.4 The six screens, navigation, and command palette

Screen ids: `main`, `resume`, `cookies`, `settings`, `library`, `error`. Registration table:

| id | Screen | Renders | Actions |
|---|---|---|---|
| `main` | MainScreen | 03-tui-design §4.1 menu + `task: idle` header | `resume`, `cookies`, `settings`, `library`, `quit`; `Start a new scrape` = stub notice |
| `resume` | ResumeScreen | sessions via `sessions.list()` (updatedAt desc) | pick for details, `delete`, back; `Resume now` = stub notice |
| `cookies` | CookieManagerScreen | §1.1 flow, async store calls | full CRUD + capture |
| `settings` | SettingsScreen | §1.2 global + site profiles | group edits, reset, profile edits |
| `library` | LibraryScreen | EPUBs under `config.defaultOutputDir` | open (platform opener), delete (confirm), back |
| `error` | ErrorScreen | reportError / reportNotice | block on acknowledge, then pop |

**Phase-4 stubs (ADR-P3-E):** the two actions that would start a scrape - MainScreen's
"Start a new scrape" and ResumeScreen's "Resume now" - navigate to a short notice ("scraping flows
arrive in Phase 4") rendered via the log region / ErrorScreen notice, then return. This keeps the
menu layout final from day one (per 03-tui-design §4.1) without half-wiring any scraping code.

**Command palette** (`commandPalette.ts`): a bare `:` on MainScreen (and any menu screen) opens a
clack text prompt; commands `:resume`, `:cookies`, `:settings`, `:library`, `:quit` map to the same
navigation as the menu. `:new` is registered but stubbed until Phase 4. Unknown commands render a
one-line warn and loop.

### 2.5 Cookie login capture through BrowserPort

`cookieCapture.ts` preserves v1's two-step contract, driving the ports instead of `scraper/browser.ts`:

```ts
beginCapture(ctx: ShellContext, loginUrl: string): Promise<CaptureSession>
finishCapture(session: CaptureSession): Promise<CaptureResult>
abortCapture(session: CaptureSession): Promise<void>
```

- `beginCapture` -> `browser.launchEphemeral({ headless: false, humanize: false,
  humanPreset: cfg.humanPreset, fingerprintSeed: cfg.fingerprintSeed, timezone: "America/New_York",
  locale: cfg.defaultLanguage === "en" ? "en-US" : cfg.defaultLanguage })`, then
  `createContext(browser)` (no cookies), `newPage`, `goto(loginUrl, domcontentloaded, navTimeout)`.
  Any post-launch failure closes the browser before propagating (v1 `capture.ts:64-75`).
- `finishCapture` -> `browser.contextCookies(ctx)` -> `StoredCookie[]` via the adapter's existing
  Playwright->StoredCookie mapping, count distinct `domain`s for the confirmation line, close the
  browser in a `finally` (v1 `capture.ts:80-94`).
- `abortCapture` -> close the browser (v1 `:98-102`).

The `CaptureSession` is `{ browser: BrowserHandle; context: ContextHandle }` - opaque handles, no
Playwright types leak out of the adapter. The screen keeps control of *when* the "press Enter when
done" prompt appears, exactly like v1 (`cookieManager.ts:667-675`).

**Port change required:** `BrowserPort` gains `contextCookies(ctx: ContextHandle):
Promise<StoredCookie[]>` (ADR-P3-A). `FakeBrowserPort` implements it with an in-memory cookie map so
capture tests are headless.

### 2.6 Graceful quit and keybinding semantics (ADR-P3-H)

03-tui-design §5: `Ctrl+Q` / `Ctrl+C` anywhere = graceful quit; `Esc` on a prompt group = previous
group, then previous screen. clack only gives us a cancel signal (Ctrl+C by default). Phase 3's
resolution:

- **Escape / clack cancel = back.** Any `Cancel` from a `PromptProvider` call pops one screen (the
  "previous group, then previous screen" rule collapses to screen-level since Phase 3 has no
  multi-group wizard; the group-level split arrives with Phase 4's `group()` wizards). On the
  `main` screen there is nothing to pop, so cancel there is treated as a no-op (or a confirm-to-quit),
  matching v1's "Escape on the main menu does nothing harmful".
- **Ctrl+C**: clack's default cancel key -> same "back" semantics. Because back-from-root is a no-op,
  a single Ctrl+C never accidentally kills the app mid-session-list; this is strictly safer than v1.
- **Ctrl+Q = graceful quit from anywhere.** clack does not bind Ctrl+Q, so the `Shell` installs its
  own stdin keypress listener (via `readline.emitKeypressEvents`, raw-mode scoped to shell lifetime)
  exactly like v1's `scrapeKeys.ts` pattern - a standalone listener, **not** a prototype patch, which
  03-tui-design §5 explicitly allows ("any combination that needs a custom listener is implemented at
  the screen level"). It is installed once at boot in `app/tui.ts`.
- The quit handler runs, in order: `sessions.flush` hook (Phase 3: nothing is mid-scrape, but the
  hook exists so Phase 4 can call `ScrapeService.cancel()` + final checkpoint), `browser.closeAll()`
  (kills any open capture browser, matching v1 `index.ts:98` "can't orphan a Chromium process"),
  then exits 0. `uncaughtException` / `unhandledRejection` route through the same handler after
  logging, matching v1 `index.ts:66-100`.

### 2.7 Log region and `ClackUIAdapter`

Per 03-tui-design §3 the log region sits **above** the header and is plain stdout - the winston
console transport keeps writing there, so the logger and clack never fight over the same lines.
Phase 3 keeps this simple:

- `ClackUIAdapter` (`src/adapters/ui-clack/ClackUIAdapter.ts`) implements `ports/UIAdapter` and
  routes each `ScrapeEvent` to a one-line status in the log region. Phase 3 emits no scrape events
  (nothing scrapes), but the adapter is the seam Phase 4's TaskScreen extends; it also gives the
  cookie-capture spinner a home.
- The `Shell` reserves the header strip; screens that need to surface transient status use
  `PromptProvider.log`, which renders below the header in the body, not in the log region.

No new port is introduced for the log region - the existing `Logger` port is what the winston
console transport feeds, and the shell simply tolerates stdout lines above its chrome.

### 2.8 Deterministic formatting (`format.ts`)

All box drawing, tables, tag columns, and truncation live in `format.ts` and are **pure string
functions at a given width** (default 80). `banner`/`section`/tags from v1 `display.ts` become
`format.banner()`, `format.section(title)`, `format.tag(kind, msg)`, `format.cookieTable(...)`,
`format.profileTable(...)`, `format.sessionLine(...)`. This is what makes the snapshot tests
deterministic: they snapshot `format.*` output at width 80, not clack's terminal pixels. NO_COLOR and
8-color degradation (03-tui-design §8) are handled by passing a color-on/off flag; `chalk` is already
a dependency.

### 2.9 TUI entry point (`src/app/tui.ts`)

- `app/tui.ts` is the Phase 3 composition root: constructs `JsonConfigStore`-family adapters
  (`YamlConfigStore`, `JsonCookieStore`, `JsonProfileStore`, `JsonSessionStore`), `PlaywrightBrowserPort`,
  `WinstonLogger`, the `ScriptedPromptProvider`-less real clack provider, installs the graceful-quit
  listener, and runs `Shell` starting at `main`.
- `pnpm dev` gains a `pnpm dev:tui` (`tsx src/app/tui.ts`) alongside the existing `pnpm dev` (v1).
- The `wnscrape` bin stays pointing at v1's `dist/index.js` **until Phase 5** wires the full cac CLI
  ("wnscrape with no subcommand = launch TUI", ADR-005). Repointing the bin now would silently break
  `wnscrape run --job` (today that path lives in `src/app/cli.ts`); unifying TUI-default and
  subcommands is a Phase 5 composition-root decision, not a Phase 3 one.

### 2.10 Deliberately deferred to Phase 4

`TaskRegistry` population + TaskScreen; `NewScrapeScreen`/wizard/auto screens; `ChapterListScreen`;
`promptSaveProfile`; consumption of `selectCookieProfileForScrape` and the resume action;
`tui/prompts.ts` / `wizard.ts` / `scrapeKeys.ts` replacement; physical deletion of v1 `src/tui/` and
the enquirer dependency (Phase 6).

---

## 3. Test plan

| # | Test | Fixture / harness | Asserts |
|---|---|---|---|
| T1 | **Shell chrome snapshots at 80x24** | `format.ts` renderers, width pinned to 80 | header/footer/log-region text byte-identical to golden strings for every screen; NO_COLOR produces plain text |
| T2 | **MainScreen + palette** | `ScriptedPromptProvider` | menu choices match 03-tui-design §4.1 exactly; `:resume`/`:cookies`/`:settings`/`:library`/`:quit` navigate; unknown command warns and loops; cancel on main is a no-op |
| T3 | **CookieManager CRUD walkthrough** | `ScriptedPromptProvider` + `JsonCookieStore` on temp XDG dir | domain add, profile add (default suggestion, charset + no-duplicate validation), kv add with advanced options, header paste via `parseCookieHeader`, relabel clearing a label (setLabel, not save), delete-one, delete-profile, delete-domain prunes the key, delete-all confirm - final store state matches v1 behavior table |
| T4 | **Cookie capture flow** | `FakeBrowserPort` (with `contextCookies`) + temp store | `launchEphemeral` called with `headless:false`/`fingerprintSeed` passed through; `contextCookies` results saved via `save()` (replaces profile); zero captured cookies -> warn + nothing saved; `abortCapture` closes the browser |
| T5 | **Global settings editor** | scripted prompts + `YamlConfigStore` on temp XDG | each of the 5 groups produces the expected `Partial<AppConfig>`; validators reject out-of-range values (navTimeout < 5000, concurrency 0/6, delay min>max, maxRetries 11, bad seed); reset writes `DEFAULT_CONFIG`; unknown keys survive the round-trip |
| T6 | **Site profile manager** | scripted prompts + `JsonProfileStore` | list with `[toc]`/`[seq]` tags, edit label/notes, edit selectors (comma join/split), edit perf (blank -> undefined), delete confirm; `formatLocator` renders next-button locators from `core/services/SelectorService` |
| T7 | **ResumeScreen** | temp `JsonSessionStore` with 3 seeded sessions | `updatedAt` desc ordering; delete removes the file; zero sessions -> back immediately; session line shape matches `sessionLine` |
| T8 | **ErrorScreen** | `ScriptedPromptProvider` + recording Logger | `reportError` logs, renders message + stack excerpt, blocks until acknowledged; `reportNotice` renders warn lines and blocks |
| T9 | **LibraryScreen** | temp output dir with a mix of `*.epub` / other files | lists only EPUBs with size/mtime at 80 cols; open invokes the platform opener (injected, not executed in test); delete confirms then removes; missing dir -> empty state, no throw |
| T10 | **Graceful quit** | shell booted under a fake stdin stream | Ctrl+Q fires the quit handler (flush hook called, `closeAll` called, exit 0); clack-cancel on a nested screen pops instead of quitting; cancel on main is a no-op |
| T11 | **Escape semantics on every screen** | scripted prompts returning `Cancel` at each decision point | every screen returns to its caller per §2.6; no unhandled rejection, no partial store mutation |

All tests are unit-level with `ScriptedPromptProvider` + store adapters on isolated XDG dirs (the
`phase-2-stores.test.ts` isolation pattern). No real TTY, no clack terminal rendering, no public
internet, no CloakBrowser binary. The one real-binary path (an actual headed capture window) is
manual QA, not CI - same rationale as Phase 1 D9.

## 4. Acceptance mapping (roadmap Phase 3)

- *"A user can list domains, add/edit/delete cookie profiles, run a browser login capture, and
  manage site profiles - without touching any scraping flow"* -> T3, T4, T5, T6. `main`/`resume`
  actions that would scrape are stubs (§2.4), so no scraping code is reachable.
- *"Escape/Ctrl+C behavior matches `03-tui-design.md` §5 on every screen"* -> T2, T11. The §5 table
  is realized as: Esc/cancel = back (pop), Ctrl+C = back with quit-from-root, Ctrl+Q = graceful
  quit via the shell-level listener.
- Snapshot tests for screen layout at 80x24 -> T1. Headless cookie CRUD via a scripted UI adapter ->
  T3 (via `ScriptedPromptProvider`).
- Parity delivered (`tui/cookieManager.ts`, `tui/configManager.ts`, `tui/sessionManager.ts`) -> T3/T4,
  T5/T6, T7. Error handling parity (`tui/errors.ts`) -> T8. Library is new (no v1 oracle) -> T9.
- v1 oracle safety: `src/index.ts`, `src/tui/*`, `src/cookies/capture.ts`, and the enquirer pin all
  stay untouched and compiling (ADR-P3-C); `pnpm dev` still runs v1.

## 5. Work breakdown (suggested commit order)

1. Add `@clack/prompts` to `package.json`; add `pnpm dev:tui`; commit the `PromptProvider` seam +
   `ScriptedPromptProvider` test double (nothing imports clack yet outside the one wrapper).
2. `format.ts` + `Shell` chrome + screen stack + `MainScreen` + `app/tui.ts` boot + T1/T2.
3. `ErrorScreen` (reportError / reportNotice port) + T8.
4. `BrowserPort.contextCookies` (interface + Playwright impl + `FakeBrowserPort`) +
   `cookieCapture.ts` + T4.
5. `CookieManagerScreen` + `validation.ts` + T3.
6. `SettingsScreen` (global + site profiles) + T5/T6.
7. `ResumeScreen` + T7.
8. `LibraryScreen` + T9.
9. Graceful-quit listener + cancel semantics sweep + T10/T11.
10. Manual QA checklist run (headed capture against a real site) + acceptance walkthroughs; record
    any divergences in `deviation-log.md`.

**Phase 3 done when:** `pnpm typecheck` / `pnpm test` / `pnpm build` are green with the new suite
(11 tests above), a maintainer can drive every management screen of v1 through the new shell with no
Enquirer anywhere in the running app, the v1 `src/tui/` oracle is byte-untouched, and the Escape /
Ctrl+C / Ctrl+Q matrix matches §2.6 on every screen.
