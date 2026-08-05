# Phase 3 - Deviation Log (post-implementation)

Reference design: `docs/phase-3/readme.md` (§1 Investigation, §2 Design), `docs/03-tui-design.md`,
`docs/04-implementation-roadmap.md` §Phase 3.

This file lists every place the implementation diverged from those documents, with the reason and the
consequence. It is written **after the code landed**: D1-D6 were anticipated at proposal time and are
now confirmed with final evidence; D7-D9 were discovered during implementation. Anything not listed
here was implemented as specified.

---

## D1 - "Delete `tui/keys.ts` patch" is reinterpreted; the files stay until Phase 6

**Spec:** roadmap §Phase 3 scope: "Replace Enquirer entirely; delete `tui/keys.ts` patch."

**Deviation:** Phase 3 removes Enquirer from the *running product* - the new Clack shell is the only
TUI and no v2 file imports enquirer - but does not physically delete `tui/keys.ts`, `tui/wizard.ts`,
`tui/prompts.ts`, does not touch the enquirer dependency, and keeps `src/index.ts` compiling and
runnable via `pnpm dev`. Physical deletion and the dependency removal land in Phase 6 with the rest
of the v1 cleanup.

**Reason:** AGENTS.md is a standing hard rule ("v1 code under `src/tui/` ... stays untouched until
the Phase 6 cleanup pass") and the roadmap's own Phase 6 is where "the v1 originals" are removed
(phase-1 deviation D1). Deleting `tui/keys.ts` in Phase 3 would break the v1 boot path and destroy
the runnable reference oracle the parity tests depend on.

**Consequence (confirmed):** `src/tui/` is byte-untouched at the end of Phase 3. The roadmap bullet
is honored in intent, not in letter; Phase 6 is unambiguous about the deletion list. ADR-P3-C.

---

## D2 - `BrowserPort` gains `contextCookies()`, which Phase 1's design did not list

**Spec:** phase-1 readme §1.6 said the Phase 1 `BrowserPort` "must merely not preclude" ephemeral
cookie capture. It declared `launchEphemeral?` but no way to read cookies back.

**Deviation:** Phase 3 adds `contextCookies(ctx: ContextHandle): Promise<StoredCookie[]>` to the
`BrowserPort` interface, implemented in `PlaywrightBrowserPort` (via `context.cookies()` mapped
through `playwrightCookiesToStored` in `cookieMappers.ts`) and in `FakeBrowserPort` (an in-memory
cookie map seeded by `setContextCookies`, with `ephemeralLaunchCount()` for assertions).

**Reason:** v1's `finishCaptureSession` reads cookies with `context.cookies()` (`cookies/capture.ts:84`);
without a port method the capture flow cannot be expressed headlessly and the TUI would have to reach
into a Playwright adapter. A named method keeps the P4 evaluate-as-string invariant enforceable by
construction (same rationale as phase-1 deviation D3).

**Consequence (confirmed):** one new named method on the port, three implementers updated in the same
commit. ADR-P3-A.

---

## D3 - `ShellContext` refines 03-tui-design §6's sketch

**Spec:** 03-tui-design §6 sketches `ShellContext` with `config: AppConfig` and
`cookies: CookieService`.

**Deviation:** The normative Phase 3 shape carries the four store ports (`ConfigStore`, `CookieStore`,
`ProfileStore`, `SessionStore`) plus an empty `TaskRegistry` and `navigate`. `config` is the
`ConfigStore` (read/write/reset), not a bare `AppConfig` snapshot, because the Settings screen must
write config, and "CookieService" has no v2 counterpart.

**Reason:** The design doc is a sketch ("component contract", not normative interface text); carrying
values instead of stores would force screens to bypass the store for writes and would leak a stale
config snapshot.

**Consequence (confirmed):** the shell depends on ports only, preserving ADR-003. ADR-P3-D.

---

## D4 - MainScreen and ResumeScreen render Phase-4 actions as stubs

**Spec:** 03-tui-design §4.1 shows "Start a new scrape" in the main menu; ResumeScreen can resume a
session. Roadmap Phase 3 must ship "without touching any scraping flow".

**Deviation:** Phase 3 renders the full menu layout (final from day one) but the two scrape-starting
actions navigate to a "scraping flows arrive in Phase 4" notice and return. The command palette
registers `:new` and renders the same notice while staying in the palette loop (no navigation to a
half-built wizard). No `runJob` wiring exists in Phase 3.

**Reason:** Rendering the complete menu honors the published design; stubbing the actions keeps the
"non-scraping parts" boundary honest and trivially verifiable.

**Consequence (confirmed):** the stubs are removed wholesale in Phase 4, not grown. ADR-P3-E.

---

## D5 - `@clack/prompts` is added as a new dependency (ADR-002 had no install)

**Spec:** ADR-002 chose `@clack/prompts` and the roadmap assumes it; `package.json` does not
contain it.

**Deviation:** Phase 3 adds `@clack/prompts` to `package.json`, pinned at `1.1.0` (first use of the
library in the repo).

**Reason:** No dependency, no screen shell - this is a prerequisite the earlier phases never landed.

**Consequence (confirmed):** enquirer remains in the manifest untouched for the v1 oracle (see D1);
clack is imported in exactly one file (`clackPrompts.ts`) per ADR-P3-B, enforced by the T1 import
isolation test.

---

## D6 - Cancel semantics: a single cancel never quits; pop-from-root is a no-op

**Spec:** 03-tui-design §5: "Ctrl+Q / Ctrl+C: anywhere - graceful quit (flush session, close
browsers)". The proposal-time version of this entry said cancel maps to "back" with "back-from-root =
quit".

**Deviation (as actually shipped):** `@clack/prompts` binds Ctrl+C as its cancel key. Phase 3 maps
clack's cancel to "pop one screen"; **pop from the root is a no-op**, so a single Escape/Ctrl+C on the
main menu never quits the app. Graceful quit happens only via the explicit "Quit" menu action, the
`:quit` palette command, or Ctrl+Q (shell-level raw-mode listener). This is strictly safer than both
v1 (which patched a library prototype so any Ctrl+C quit from anywhere) and the proposal-time wording
("back-from-root = quit").

**Reason:** Honoring clack's documented cancel behavior (ADR-002: "isCancel() is the only go-back
primitive") conflicts with the letter of §5; the shell-level listener pattern 03-tui-design §5 itself
permits ("any combination that needs a custom listener is implemented at the screen level"). Making
root-cancel a no-op removes the only accidental-quit path from the app.

**Consequence (confirmed):** `Shell.applyResult` implements the no-op; the nested-pop case is verified
by the "nested cancel pops (returns to caller); root cancel is a no-op" test, and the Ctrl+Q path by
the graceful-quit test. The proposal-time "back-from-root = quit" wording in the earlier draft of this
log is superseded by this entry. ADR-P3-H.

---

## D7 - Cookie-capture "site count" is simplified because `StoredCookie` drops `domain`

**Spec:** readme §2.5 and v1 `cookies/capture.ts` show a confirmation line counting distinct cookie
`domain`s captured (`finishCapture` returns "Captured N cookie(s) across M site(s)").

**Deviation:** `StoredCookie` (the store shape) deliberately carries no `domain` field - the bare
hostname is the store key and is reattached only on `CookieStore.load`. The Playwright `Cookie.domain`
is therefore lost in the `StoredCookie` mapping, so `countSites` in `cookieCapture.ts` cannot count
distinct domains. It returns `1` when any cookie was captured and `0` otherwise.

**Reason:** A per-site login capture produces exactly one meaningful domain; the multi-site case is
unusual and would require rethreading `domain` through the store type (a migration-guide-visible
change) for a confirmation-line nicety.

**Consequence (confirmed):** the "across M site(s)" line reads "across 1 site(s)" for any non-empty
capture. If a real user reports the multi-site miss, Phase 4 rethreads it; the simplification is
called out in `cookieCapture.ts:120-130`. ADR-P3-I.

---

## D8 - `ScriptedPromptProvider` mirrors clack's re-prompt on validation failure

**Spec:** readme §3 describes scripted walkthroughs where "a validator rejects" ends the test.

**Deviation:** a rejected value does not throw - the provider consumes the *next* scripted answer and
re-validates, exactly like clack re-renders a prompt whose validator returns a string. A walkthrough
of a bad-then-good input therefore scripts both answers (e.g. T4's domain "bad_domain" then
"example.com"). Only a validator that keeps rejecting until the script runs out raises.

**Reason:** Real clack never throws on validation failure; throwing in the double would force every
happy-path script to skip the rejection case entirely, losing the coverage the readme's
validator-rejection cases (T5) ask for.

**Consequence (confirmed):** validator rejection coverage exists (T4), and a script that drives the
TUI into an unbounded re-prompt loop fails loudly instead of hanging. Noted in
`ScriptedPromptProvider.ts:104-117`.

---

## D9 - The test suite is 24 tests, not the planned 11; snapshots assert structure, not golden bytes

**Spec:** readme §3 plans an "11-test suite (snapshots, scripted CRUD, capture, quit semantics)" with
"golden strings byte-identical to reference output" for T1.

**Deviation:** `tests/phase-3-tui.test.ts` ships 24 tests. The design's T1-T11 map onto it as: T1
chrome+architecture (including the `@clack/prompts` import-isolation scan), T2/T3 MainScreen+palette,
T4/T5/T6/T7 CookieManager CRUD + capture, T8/T9 Settings (global + site profiles), T10 Library,
T11 Resume + error reporter, plus two Shell-level navigation tests and the chrome unit tests.

**Reason:** The extra tests cover branches the 11-item plan implied but did not enumerate (shell stack
semantics, the Ctrl+Q listener, empty-directory library state, error-stack rendering). Chrome
snapshots assert *structure* (exact box width at 80 columns, border characters, row presence) rather
than byte-identical golden files because there is no fixed terminal in CI; width is pinned by
`FormatOpts` defaults, so a structural assertion is the terminal-independent equivalent.

**Consequence (confirmed):** `pnpm test` stays green in any environment (the acceptance suite remains
gated on `CLOAKBROWSER_BINARY_AVAILABLE=1`); the suite doubles as a living map of every screen's
decision points.
