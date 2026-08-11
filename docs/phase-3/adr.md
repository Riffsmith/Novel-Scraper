# Phase 3 - Architecture Decision Record (post-implementation)

This is the consolidated ADR for Phase 3 ("TUI shell, non-scraping parts"). It records the decisions
that shaped the shipped code: refinements to the sketches in `docs/03-tui-design.md`, and
reconciliations between the roadmap and constraints that post-date it.

For the chronological divergence list see `docs/phase-3/deviation-log.md`. For the top-level project
ADRs (ADR-001 ... ADR-006) see `docs/01-architecture-decisions.md`.

This file is written **after the code landed**; every "Evidence" line below points at shipped files.
Decisions that only crystallized during implementation are recorded as ADR-P3-H / ADR-P3-I and
cross-referenced from the deviation log.

---

## ADR-P3-A - `BrowserPort` gains `contextCookies()` for capture read-back

**Context**

v1's `finishCaptureSession` reads cookies with Playwright's `context.cookies()` (`cookies/capture.ts:84`).
The Phase 1 `BrowserPort` (`src/ports/BrowserPort.ts`) declares `launchEphemeral?` as the only
ephemeral-capture seam ("Phase 1's BrowserPort must merely not preclude it", phase-1 readme §1.6) and
the Playwright adapter implements `launchEphemeral`. But there was **no method to read cookies back
out of a context**, so the capture flow could not be expressed through the port.

**Decision**

Add a named method to `BrowserPort`:

```ts
contextCookies(ctx: ContextHandle): Promise<StoredCookie[]>;
```

- Implemented in `PlaywrightBrowserPort` via `context.cookies()` mapped through `playwrightCookiesToStored`
  (with the `PlaywrightCookieRead` shape) in `cookieMappers.ts`.
- Implemented in `FakeBrowserPort` against an in-memory cookie map (`setContextCookies` seeds it,
  `ephemeralLaunchCount()` counts headed launches for assertions).
- It is a *named* method, never a generic `evaluate()` - the P4 evaluate-as-string invariant stays
  enforced by construction, exactly like `findElement()`/`url()` before it (phase-1 deviation D3).

**Consequences**

- `core/` still imports nothing Playwright-specific; the opaque `ContextHandle` hides the driver.
- The TUI capture flow (`ui-clack/cookieCapture.ts`) depends on the port, not on a browser adapter.
- The interface grows by one method; all three implementers (Playwright, Fake, Null) updated in the
  same commit.

**Evidence**

- `src/ports/BrowserPort.ts:55-73` - `launchEphemeral?` + `contextCookies`.
- `src/adapters/browser-playwright/PlaywrightBrowserPort.ts` (`contextCookies`) and `cookieMappers.ts`
  (`PlaywrightCookieRead`, `playwrightCookiesToStored`).
- `src/adapters/store-memory/FakeBrowserPort.ts` (`setContextCookies`, `contextCookies`,
  `ephemeralLaunchCount`).
- `tests/phase-3-tui.test.ts` T7 (capture replaces profile cookies) drives the whole seam headlessly.

---

## ADR-P3-B - Screens depend on a `PromptProvider` seam, not on `@clack/prompts` directly

**Context**

The roadmap Phase 3 tests are "snapshot tests for screen layout at 80x24" and "headless simulation:
cookie CRUD via a scripted UI adapter". `@clack/prompts` renders directly to the terminal: it cannot
be snapshot-tested and cannot be driven without a TTY. The project already solved this exact problem
for the browser with `FakeBrowserPort` - screens needed the same treatment for prompts.

**Decision**

`adapters/ui-clack/PromptProvider.ts` defines a minimal typed prompt interface (`select`, `confirm`,
`text`, `spinner`, `log`) whose cancel channel is a single `Cancel` symbol. The real implementation
(`clackPrompts.ts`) is the **only file in the repository that imports `@clack/prompts`**, and it
translates `isCancel()` to `Cancel`. `ScriptedPromptProvider` is the test double: it records every
prompt descriptor and returns scripted answers, re-consuming an answer when a validator rejects
(mirroring clack's re-prompt; deviation D8).

**Consequences**

- ADR-003 holds: clack is an adapter-local concern, invisible to core and to the rest of the app.
- Tests assert on `format.*` output and on recorded prompt descriptors - deterministic, no terminal,
  no timing, no clack-rendering flakes.
- Phase 4 wizards compose through the same seam; a future `ui-web` adapter gets prompts for free.
- Cost: one thin indirection layer; the seam mirrors the project's existing test-double pattern.

**Evidence**

- `src/adapters/ui-clack/PromptProvider.ts`, `clackPrompts.ts`, `ScriptedPromptProvider.ts`.
- `tests/phase-3-tui.test.ts` T1 enforces the single-file clack import by scanning `src/`.
- `docs/04-implementation-roadmap.md` §Phase 3 Tests; `src/adapters/store-memory/FakeBrowserPort.ts`
  is the established double pattern.

---

## ADR-P3-C - Enquirer patch files are NOT deleted in Phase 3

**Context**

Roadmap §Phase 3 scope says "Replace Enquirer entirely; delete `tui/keys.ts` patch." AGENTS.md is a
standing hard rule: *v1 code under `src/tui/` stays untouched until the Phase 6 cleanup pass*, and
the roadmap's own Phase 6 is where "the v1 originals" get removed (phase-1 deviation D1). Deleting
`tui/keys.ts` in Phase 3 would break `src/index.ts` compilation and destroy the v1 TUI as a runnable
reference oracle.

**Decision**

Phase 3 makes the **running product** Enquirer-free - the new shell is the only TUI, and no v2 file
imports enquirer - but it does not physically delete `tui/keys.ts`, `tui/wizard.ts`,
`tui/prompts.ts`, does not touch the enquirer dependency in the manifest, and keeps `src/index.ts`
compiling and runnable via `pnpm dev`. Physical deletion and the dependency removal happen in Phase 6
with the rest of the v1 cleanup. The roadmap bullet is read as "remove Enquirer from the running
product".

**Consequences**

- The v1 reference oracle stays alive for parity testing (the standing AGENTS.md guarantee).
- The roadmap's delete bullet is reinterpreted, not silently dropped; this file is the record.
- Phase 6 has a concrete, pre-audited deletion list and no ambiguity about enquirer.

**Evidence**

- AGENTS.md "v1 code under src/tui/ is the reference oracle ... stays untouched until the Phase 6
  cleanup pass."
- `docs/phase-1/deviation-log.md` D1 ("Phase 6 cleanup will remove the v1 originals").
- `package.json` (enquirer entry unchanged), `src/tui/` (byte-untouched); verified at the end of
  Phase 3 (deviation D1).

---

## ADR-P3-D - `ShellContext` carries the four store ports, not a bare `AppConfig`

**Context**

03-tui-design §6 sketches `ShellContext` with `config: AppConfig` and `cookies: CookieService`. But
the Settings screen must **write** config (v2's `ConfigStore.write`), not just read a snapshot, and
"CookieService" has no v2 counterpart - Phase 2 gave us the `CookieStore` port. Passing an
`AppConfig` value would force screens to bypass the store for writes.

**Decision**

```ts
interface ShellContext {
  config:   ConfigStore;   // read/write/reset - not a bare AppConfig value
  cookies:  CookieStore;
  profiles: ProfileStore;
  sessions: SessionStore;
  browser:  BrowserPort;
  log:      Logger;
  prompt:   PromptProvider; // injected by the Shell, same instance for every screen
  tasks:    TaskRegistry;   // empty type stub; populated in Phase 4
  navigate(to: string, params?: unknown): void;
}
```

Screens read current `AppConfig` values through `config.read()` at render time, matching v1's
"re-read before every group edit" behavior (`configManager.ts:134`).

**Consequences**

- The shell depends on **ports only** (adapter -> ports -> core); hexagonal direction is preserved.
- The design doc's sketch is refined, not contradicted - it is a spec, not normative interface text.
- Phase 4 adds a live `TaskRegistry` without touching the interface shape.

**Evidence**

- `docs/03-tui-design.md` §6 (the sketch).
- `src/adapters/ui-clack/ShellContext.ts` (the shipped shape, incl. `browser`/`log`/`prompt`).
- `src/ports/ConfigStore.ts`, `CookieStore.ts`, `ProfileStore.ts`, `SessionStore.ts`.

---

## ADR-P3-E - Phase-4 actions render as stubs in MainScreen and ResumeScreen

**Context**

03-tui-design §4.1's main menu includes "Start a new scrape"; ResumeScreen can resume a session.
Roadmap Phase 3 must deliver "without touching any scraping flow".

**Decision**

Phase 3 renders the full menu layout (so it is final from day one) but the two actions that would
start a scrape - MainScreen's "Start a new scrape" and ResumeScreen's "Resume now" - navigate to a
short "scraping flows arrive in Phase 4" notice and return. The command palette registers `:new` and
renders the same notice while staying in the palette loop. No `runJob` wiring, no half-built wizard,
no session-into-engine path exists in Phase 3.

**Consequences**

- The acceptance test "can do all of the above without touching any scraping flow" is trivially
  honest: there is no scraping path to touch.
- The stubs are removed wholesale in Phase 4, not grown.
- The menu structure matches the published design from the first release.

**Evidence**

- `docs/03-tui-design.md` §4.1, §4.2 (menu + resume).
- `src/adapters/ui-clack/screens/MainScreen.ts`, `ResumeScreen.ts`, `commandPalette.ts`.
- `tests/phase-3-tui.test.ts` T2/T3 (main menu), palette, and the resume Phase-4 notice test.

---

## ADR-P3-F - LibraryScreen is adapter-side and uses the platform opener

**Context**

Library is a brand-new screen with no v1 oracle (03-tui-design §2 marks it "new"). It must list EPUBs
under the output dir and open them in the system viewer. No core service exists or should exist for
this - it is presentation plus a filesystem/process concern, both adapter territory.

**Decision**

`LibraryScreen` scans `config.read().defaultOutputDir` for `*.epub`, lists them with size and mtime,
and opens via the platform opener (`xdg-open` / `open` / `start`) through `child_process` in the
adapter. Delete is guarded by a confirm and performs a real `fs.unlinkSync`. Both the listing and the
opener are injectable so tests run without spawning a viewer (the delete path still exercises the
real filesystem against a temp directory).

**Consequences**

- No new port, no new core service - the screen is thin and entirely adapter-local.
- Cross-platform open is contained in one helper; tests inject a no-op opener.
- The output-dir default comes from the same config store every other screen uses.

**Evidence**

- `docs/03-tui-design.md` §2 ("LibraryScreen ... new").
- `src/adapters/ui-clack/screens/LibraryScreen.ts` (`ListEpubsFn`/`OpenEpubFn` injection,
  `defaultOpenEpub`).
- `tests/phase-3-tui.test.ts` T10 (open + delete against a temp dir) and the empty-dir test.

---

## ADR-P3-G - TUI boots from `app/tui.ts`; the bin repoint waits for Phase 5

**Context**

ADR-005 says `wnscrape` (no args) should launch the TUI and Phase 5 wires the full cac CLI. Today
`package.json` `bin` points at v1 `dist/index.js`, and `src/app/cli.ts` handles only
`run --job`. Repointing the bin to the new shell now would silently drop `wnscrape run --job` until
Phase 5.

**Decision**

Phase 3 adds `src/app/tui.ts` as the TUI composition root (YamlConfigStore + JsonCookieStore +
JsonProfileStore + JsonSessionStore + PlaywrightBrowserPort + Winston logger + clack prompt provider +
Shell with the six registered screens) and exposes it via a new `pnpm dev:tui` script. The `wnscrape`
bin and `pnpm dev` (v1 TUI) stay untouched. Phase 5 unifies: cac falls through to the TUI when no
subcommand is given, per ADR-005.

**Consequences**

- Phase 3 is reachable (`pnpm dev:tui`) without breaking the v1 boot path or the existing CLI.
- The bin unification is a single, well-scoped Phase 5 composition-root decision, not a Phase 3
  surprise.
- `app/tui.ts` mirrors `app/runJob.ts` as a sibling composition root - same wiring pattern.

**Evidence**

- `docs/01-architecture-decisions.md` ADR-005 (TUI default + CLI subcommands).
- `src/app/tui.ts` (registered screen ids: main, resume, cookies, settings, library, error).
- `package.json` `scripts.dev:tui`; the `wnscrape` bin is unchanged.

---

## ADR-P3-H - Cancel semantics and Ctrl+Q on the shell

**Context**

03-tui-design §5 wants `Ctrl+Q` / `Ctrl+C` to mean graceful quit "anywhere", and Escape to mean
"back". `@clack/prompts` binds Ctrl+C as its cancel key and does not bind Ctrl+Q. Blindly treating
clack's cancel as "quit" would make a single Ctrl+C kill the app mid-menu; ignoring clack's cancel
would break its documented behavior. The old `tui/keys.ts` prototype patch is off the table
(ADR-002 decision #3, ADR-P3-C).

**Decision**

- **Escape / clack cancel = pop one screen.** `Shell.applyResult` pops when the stack has more than
  one frame; **pop from the root is a no-op** (a single Escape/Ctrl+C on the main menu never quits).
  This is strictly safer than v1 and matches "isCancel is the only go-back primitive".
- **Ctrl+C** stays clack's cancel key, therefore "back"; quitting is reached only via the explicit
  Quit menu action, the `:quit` palette command, or Ctrl+Q.
- **Ctrl+Q** is handled by a shell-level stdin keypress listener (`readline.emitKeypressEvents`,
  raw-mode scoped to the shell lifetime, restored on shutdown) - the `scrapeKeys.ts` pattern, which
  03-tui-design §5 explicitly permits ("any combination that needs a custom listener is implemented
  at the screen level", not a library prototype patch).
- The quit sequence: session flush hook (`flushOnQuit`, a Phase 3 no-op default) -> `browser.closeAll()`
  -> exit; all wired re-entrant-safe so shutdown fires once.

**Consequences**

- No prototype patching anywhere; the keybinding matrix in readme §2.6 is testable.
- Ctrl+C semantics differ from v1 in one safe direction: it never quits mid-menu on the first press.
- Phase 4's TaskScreen reuses the same shell-level listener for `q`.

**Evidence**

- `docs/03-tui-design.md` §5 (keybindings, "no prototype patch").
- `src/adapters/ui-clack/Shell.ts` (`applyResult` pop/no-op, `installQuitListener`/`shutdown`).
- `tests/phase-3-tui.test.ts` - nested-pop/root-pop/quit sequence test and the Ctrl+Q graceful-quit
  test under a fake stdin stream.
- `src/tui/scrapeKeys.ts` - the standalone-listener pattern being reused.

---

## ADR-P3-I - Cookie-capture "site count" is a 1/0 signal, not a distinct-domain count

**Context**

v1's capture confirmation line counts distinct cookie `domain`s ("Captured N cookie(s) across M
site(s)"). In v2 the store shape `StoredCookie` deliberately drops `domain` (the bare hostname is the
store key, reattached only on `CookieStore.load`), so the Playwright `Cookie.domain` is unavailable
at capture-finish time.

**Decision**

`finishCapture` reports `siteCount = cookies.length > 0 ? 1 : 0`. The capture flow keeps its
"save/replace profile" contract and its warning for zero captured cookies; only the multi-site count
in the confirmation line is simplified.

**Consequences**

- A per-site login capture (the normal path) reads correctly: "across 1 site(s)".
- The unusual multi-site capture undercounts on the confirmation line only; the cookies themselves
  are saved untouched. Rethreaded in Phase 4 if a real user reports it.

**Evidence**

- `src/adapters/ui-clack/cookieCapture.ts:120-130` (`countSites`, with the rationale comment).
- `tests/phase-3-tui.test.ts` T7 (asserts "Captured 2 cookie(s) across 1 site(s).").
- `docs/phase-3/deviation-log.md` D7.

---

## ADR-P3-FIX-URL - `validateUrl` tightened to reject scheme-doubled URLs and accept bare hostnames; `normalizeUrl` helper added

**Context**

A user opening the cookie manager's "Log in via browser" capture path (`CookieManagerScreen.captureViaLoginFlow`) saw the URL prompt pre-filled with `https://${domain}`. The natural editing gesture when adding a path (`/login`) was to start typing, which spliced the second `https://` after the seed and produced `https://https://www.webnovel.com/login`. The existing `validateUrl` accepted that value because `new URL("https://https://www.webnovel.com/")` does not throw - the WHATWG parser treats the segment after the scheme as an opaque authority, yielding `hostname === "https"`. The browser then navigated to a URL whose hostname was literally `https`, which never loaded.

Two defects composed: (A) the `initial` seed invited the double prefix, and (B) the validator accepted the malformed URL. The fix proposal `docs/fix-issue-tui-url-cleanliness.md` §1 sketched two matched edits and `normalizeUrl` as a helper the call site uses to prepend the scheme for bare hostnames.

**Decision**

- **`validateUrl`** (`src/adapters/ui-clack/validation.ts`) rejects empty input ("URL cannot be empty"), prepends `https://` to a schemeless candidate inside its own parse attempt (so a bare hostname like `www.webnovel.com/login` validates), and rejects any URL whose `hostname` has no dot ("URL hostname looks invalid (no dot in hostname)") which catches `https://https://...` (its hostname is the literal `https`).
- **`normalizeUrl`** is a new additive helper in the same file: trim, then prepend `https://` when the trimmed input has no scheme, return the trimmed input otherwise. The validator cannot mutate the caller's value (clack's `validate` returns `boolean | string` - a non-`true` is an error message), so the helper is the call site's normalization path.
- **`CookieManagerScreen.captureViaLoginFlow`** uses `placeholder: "https://${domain}/login"` instead of `initial: "https://${domain}"` so the seed no longer invites appending, and calls `beginCapture(deps, normalizeUrl(loginUrl))` instead of `loginUrl.trim()`.
- **Every other `validateUrl` call site** that previously did `r.trim()` was updated to `normalizeUrl(r)` so the new "accept bare hostnames" validator semantics cannot leak a schemeless URL into code that uses `new URL(...)` downstream (`NewScrapeScreen.hostnameFrom`, `ChapterListService.discoverTOC` via `new URL(tocUrl).origin`, etc.). Five sites: `NewScrapeScreen.ts:70` (`entryUrl`), `wizardGroups.ts` `tocUrl` / `firstChapterUrl` / `lastChapterUrl` / `coverUrl`. This matches the proposal's framing of the `validateUrl` + `normalizeUrl` rollout as "pure additive, no behavioral risk" - the matched-pair application at every call site is what keeps that framing honest.
- The old `validateUrl`'s header comment claimed it was "byte-identical to v1 prompts.ts:16-23"; that no longer holds, so the file header now states which helpers are still v1-identical and which diverged.

**Consequences**

- A user typing `www.webnovel.com/login` gets past validation and the browser navigates to `https://www.webnovel.com/login` (cleaner UX; previously rejected because `new URL("www.webnovel.com/login")` throws).
- A user who types `https://https://...` in any URL prompt now sees "URL hostname looks invalid (no dot in hostname)" with no mysterious downstream failure.
- `validateDomain` is intentionally NOT touched (per proposal §1.7 - different shape, its own `http` prefix handling, behavior correct for its purpose). Touching it would muddy the diff.
- No data migration, no store schema change. Any URL that passed the old validator still passes the new one, except scheme-doubled URLs that were never useful to begin with.
- The behavior-change footprint - "accept bare hostnames" - is paid for by `normalizeUrl` at every call site, so no wizard or scrape-config field can carry a schemeless URL downstream.

**Evidence**

- `src/adapters/ui-clack/validation.ts` - `validateUrl` and `normalizeUrl` with the rationale documented inline.
- `src/adapters/ui-clack/screens/CookieManagerScreen.ts:442-447, 463` - `placeholder` + `normalizeUrl(loginUrl)`.
- `src/adapters/ui-clack/screens/NewScrapeScreen.ts:19, 70` - `normalizeUrl(rawUrl)` for `entryUrl`.
- `src/adapters/ui-clack/wizardGroups.ts:29, 116, 125, 134, 335` - `normalizeUrl` applied at the four wizard URL sites.
- `tests/phase-3-tui.test.ts` - "validateUrl (tightened)" (6 cases: empty, scheme-doubled, dotless, https, bare-hostname, etc.), "normalizeUrl" (3 cases), "CookieManager capture flow URL handling" (behavioral: `FakeBrowserPort.lastPage.gotoCalls[0] === "https://www.webnovel.com/login"` for both the explicit-scheme and bare-hostname inputs).
- `docs/phase-3/deviation-log.md` D10.

---

## ADR-P3-FIX-TUI - TUI cleanliness pass: banner-once, ChapterListScreen reprint gate, `note()`-boxed profile card

**Context**

`docs/03-tui-design.md` §4 specifies a three-region layout: header strip (banner printed ONCE per `Shell.run()`), log region (clack's streaming log), footer strip (one-line hint at shutdown). The shipped `Shell.ts` rendered no header strip; instead `MainScreen.render` re-emitted `fmt.banner()` on every visit, so each navigation back to the main menu pushed a duplicate banner row into the log region. `ChapterListScreen` reprinted the entire chapter list on every `while (true)` iteration - after a "remove chapters" action the user returned to an action prompt above a freshly re-dumped list that could be hundreds of rows. `SettingsScreen.printProfile` emitted ~14 separate `log("info", ...)` rows per profile card, one row per field, indistinguishable from the surrounding log stream.

The fix proposal `docs/fix-issue-tui-url-cleanliness.md` §2 four-independent-fixes sketch: §2.4.1 delete MainScreen's banner reprint; §2.4.2 introduce a `listDirty` gate so the chapter list reprints only when something changed; §2.4.3 collapse `printProfile` into a single `clack.note` call via a new `PromptProvider.note` method; §2.4.4 (optional) move the banner into `Shell.run()` so it appears once per session. Per user instruction in this bug-fix pass: ship §2.4.4 so the banner remains visible exactly once.

**Decision**

- **§2.4.1 (`MainScreen.ts`)**: delete the `ctx.prompt.log("info", fmt.banner())` line and the now-unused `import * as fmt from "../format.js"`. The screen header comment explains the move to the Shell.
- **§2.4.2 (`ChapterListScreen.ts`)**: hoist the title / chapter-count / per-volume summary / `printChapterList` calls out of the `while (true)` loop so they fire once up-front. Introduce a `listDirty` boolean set after `reverse` / `remove` / `add`. At the bottom of each loop iteration, if `listDirty`, emit one summary line ("Updated: N chapter(s)") and reprint the list, then clear the flag. The explicit `view` action reprints unconditionally (unchanged affordance). No partial state can drift out of sync because every mutation that changes the list also sets the flag.
- **§2.4.3 (`PromptProvider.ts` seam + `SettingsScreen.printProfile`)**: add `note(message?: string, title?: string): void` to the `PromptProvider` interface; implement it in `clackPrompts.ts` as `clack.note(message, title)` (one line, scope-clean - clack is already the only allowed import in that file); implement it in `ScriptedPromptProvider.ts` as a recording push to a new `noteCalls` array and the existing `calls` array. Rewrite `SettingsScreen.printProfile` to build a `lines: string[]`, push individual rows into it, and emit one `ctx.prompt.note(lines.join("\n"), "Profile: <domain>")` call. The visual output is a single boxed region titled "Profile: <domain>" with every field row inside it, distinctly grouped from the surrounding log stream.
- **§2.4.4 (`Shell.ts`)**: add `import * as fmt from "./format.js"` and emit `this.deps.prompt.log("info", fmt.banner())` exactly once at the top of `run()`, before the `while (!quitRequested && this.stack.length > 0)` loop. The banner now appears once per session (header strip), never per-screen-render. No footer-strip implementation - app currently exits cleanly on quit, and a footer is lower priority per the proposal §2.4.4 verdict.

**Consequences**

- Banner appears once per TUI session start; navigating back to the main menu no longer adds a banner row.
- `ChapterListScreen` scrolls the log region at most O(N) over a session (one initial print + one reprint per mutation + explicit view), not O(N * iterations) - the previous dominant noise source is gone.
- A profile card is visually grouped (clack `note` renders a titled box) and asserts can target `noteCalls` directly instead of grepping the log stream for individual field-label substrings.
- The `PromptProvider` interface grows by one method; both implementations updated in the same change. `ScriptedPromptProvider.note` acquires no input (no Cancel path, no scripted answer consumed).
- `MainScreen` no longer depends on `format.ts`; `Shell.ts` now does (mirroring the design doc's separation: header chrome is shell-owned, not screen-owned).
- No v2-or-later migration concerns; these are presentation-only changes with no schema involvement.

**Evidence**

- `src/adapters/ui-clack/screens/MainScreen.ts` - banner line removed; header comment documents the move.
- `src/adapters/ui-clack/screens/ChapterListScreen.ts` - hoisted prints, `listDirty` gate.
- `src/adapters/ui-clack/PromptProvider.ts` - `note(message, title)` on the interface.
- `src/adapters/ui-clack/clackPrompts.ts` - `clack.note(message, title)` wrapper.
- `src/adapters/ui-clack/ScriptedPromptProvider.ts` - `noteCalls` recording + `RecordedCall.kind === "note"`.
- `src/adapters/ui-clack/screens/SettingsScreen.ts` - `printProfile` builds an array and emits one `note()`.
- `src/adapters/ui-clack/Shell.ts` - `fmt.banner()` once at the top of `run()`.
- `tests/phase-3-tui.test.ts` - "T2: renders with zero sessions" (asserts MainScreen emits NO banner), "ChapterListScreen reprint gate" (two cases: post-remove-no-third-reprint and explicit-view-triggers-reprint), "SettingsScreen printProfile boxed note" (asserts exactly two `note()` calls with the expected title and no row-by-row log lines), "Shell banner-once (header strip)" (asserts exactly one banner row across multiple root-pop iterations).
- `docs/phase-3/deviation-log.md` D11.

---

## Summary of Phase 3 deliverables (delivered)

| Design item | Status | Evidence |
|---|---|---|
| `adapters/ui-clack/` shell (Shell, ShellContext, screens x6, PromptProvider, format, validation, cookieCapture, commandPalette, ClackUIAdapter) | delivered | `src/adapters/ui-clack/**` |
| `BrowserPort.contextCookies` (interface + Playwright + Fake) | delivered | ADR-P3-A |
| `app/tui.ts` composition root + `pnpm dev:tui` | delivered | ADR-P3-G |
| Enquirer removed from the running product, files kept until Phase 6 | delivered | ADR-P3-C, D1 |
| 24-test suite (chrome snapshots, scripted CRUD, capture, shell semantics) | delivered | `tests/phase-3-tui.test.ts`, D9 |

**Hard constraints upheld by the shipped code:**
- No new code imports `playwright` (only `playwright-core`); `@clack/prompts` is imported in exactly
  one file (`clackPrompts.ts`) - enforced by the T1 import-isolation test.
- v1 code in `src/tui/`, `src/index.ts`, `src/cookies/capture.ts` stays byte-untouched; the enquirer
  entry in the manifest is unchanged.
- `core/` imports nothing from adapters, clack, fs, or chalk/ora - Phase 3 adds zero imports to core.
- No scraping flow is reachable or modified in Phase 3.
