# Bug Fix - Discovery Challenge Wait-Out - Deviation Log

Reference design: `docs/fix-issue-tui-url-cleanliness.md` §3 "Sequential
Discovery Closes Browser Without Waiting Out Security Challenges". This file
records every place the implementation diverged from that proposal's design
sketch, with the reason and the consequence. Anything not listed here was
implemented as specified.

ADR-007 (`docs/01-architecture-decisions.md`) is the paired ADR. The bug fix
itself is not a Phase (1 through 7 are the named phases); it is a follow-up
fix against the discovery code path that the original phases shipped without
challenge handling. Phase docs and their deviation logs are unchanged by this
fix.

---

## D-FIX-1 - `ManualDiscoveryScreen` does NOT add a separate `ui.onEvent(challenge.waiting)` handler (the proposal's §3.5.3 redundancy)

**Spec:** `docs/fix-issue-tui-url-cleanliness.md` §3.5.3 specifies that
`ManualDiscoveryScreen` should add a one-handler `ui.onEvent(...)` block
matching the proposal's sketch, so the user sees the wait instead of an
apparent hang during the 30 s in-page poll:

```ts
const ui = new ClackUIAdapter(ctx.prompt);
ui.onEvent((e) => {
  if (e.type === "challenge.waiting") {
    ctx.prompt.log("warn", `Security challenge detected - waiting for it to clear...`);
  }
});
```

**Deviation:** The implementation does NOT add this handler. The user still
sees a warn log row when `challenge.waiting` fires during discovery, via the
existing `ClackUIAdapter.emit` route:

```ts
case "challenge.waiting":
  this.prompt.log("warn", `Anti-bot challenge waiting on ${e.url}`);
  break;
```

at `src/adapters/ui-clack/ClackUIAdapter.ts:57-58`. The proposal doc's §3.5.3
sketch pre-dated that `case` in `ClackUIAdapter`. Adding the §3.5.3 handler
verbatim would produce TWO warn rows for a single `challenge.waiting` event
(one from the §3.5.3 `onEvent` callback, one from the ClackUIAdapter switch's
own `case`). That is duplicate noise, not a fix.

**Reason:** AGENTS.md "Do not add features beyond what was asked" + "Do not
over-engineer. Introduce patterns only when the complexity REALLY justifies
it." The proposal's stated intent ("the user sees the wait instead of an
apparent hang") is already satisfied by the existing ClackUIAdapter log case
that the proposal's investigation missed. Adding a duplicate handler would
have broken the cleanliness goal of the very same proposal doc.

**Consequence:**

- 0 source-line change to `src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts`.
- A user on a stuck-challenge discovery sees one warn row "Anti-bot challenge
  waiting on <url>" (already in `ClackUIAdapter`) per `challenge.waiting`
  event, which the wait-out fires once per attempt (so 3 rows total across
  the 3 retries). Without this deviation, the user would see 6 rows: one
  from `ClackUIAdapter.emit` and one from the §3.5.3 `onEvent` per event.
- `TaskScreen.ts:111-122` (referenced by the proposal as the scrape-phase
  analogue) is unchanged: that handler exists to drive a live spinner
  message, not to log a duplicate row. Discovery (`ManualDiscoveryScreen`)
  does not run a spinner, so the synchronous log row is the right shape
  there. The discovery-phase and scrape-phase paths are already
  asymmetric for the right reason.

No test asserts on the absence of a duplicate `ManualDiscoveryScreen` handler
explicitly (the `tests/discovery-service.test.ts` suite uses `NoopUIAdapter`,
which never routes through `ClackUIAdapter.emit` at all). The path is covered
implicitly by the existing `tests/phase-3-tui.test.ts` suite, which exercises
`ClackUIAdapter.emit`'s `challenge.waiting` case indirectly via its event-
routing parity tests.

**Evidence:**

- `src/adapters/ui-clack/ClackUIAdapter.ts:57-58` `case "challenge.waiting":`
  logs the warn row.
- `src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts` is unchanged from
  before this bug fix; no `ui.onEvent(...)` handler added.
- `src/adapters/ui-clack/screens/TaskScreen.ts:111-122` keeps its scrape-phase
  `onEvent` handler for spinner driving only.

---

## D-FIX-2 - Discovery retry launches 4 browsers before bubble, not 3 (the proposal's §3.7 test comment is ambiguous)

**Spec:** `docs/fix-issue-tui-url-cleanliness.md` §3.7 sketch includes a
test comment:

```ts
expect(fakeBrowser.launches).toBe(DISCOVERY_MAX_RETRIES + 0);  // attempted, never succeeded
```

which reads as "never succeeded" → `DISCOVERY_MAX_RETRIES` total launches.

**Deviation:** The implementation's retry condition is
`attempt <= DISCOVERY_MAX_RETRIES` (where `attempt` starts at 1 and increments
at the top of each loop iteration, mirroring `ScrapeService.ts:238`'s shape
`if (task.retries < maxRetries)` where `task.retries` starts at 0). With
`DISCOVERY_MAX_RETRIES = 3`:

- attempt 1 → caught + `1 <= 3` true → retry (after `1 * 45_000ms`)
- attempt 2 → caught + `2 <= 3` true → retry (after `2 * 45_000ms`)
- attempt 3 → caught + `3 <= 3` true → retry (after `3 * 45_000ms`)
- attempt 4 → caught + `4 <= 3` false → bubble `SecurityChallengeError`

Total = 4 launches (1 initial + 3 retries).

The proposal's §3.7 test comment is ambiguous / slightly off-by-one: a
"never succeeded" run still does the original attempt, so the expected launch
count is `DISCOVERY_MAX_RETRIES + 1`, not `+ 0`. The implemented condition was
chosen to mirror `ScrapeService.ts:233-275` as the proposal explicitly calls
for - that code uses `if (task.retries < maxRetries)` with `maxRetries = 3`
and `task.retries` starting at 0, so it makes 4 attempts total (the original
plus up to 3 retries). The §3.5.2 sketch's `attempt <= DISCOVERY_MAX_RETRIES`
matches that shape if you read the `attempt++` increment as equivalent to
ScrapeService's pre-increment `task.retries++` before the comparison.

**Reason:** Mirroring the existing ScrapeService retry semantics exactly is
more important than annotating the proposal's inline test-comment arithmetic.
The §3.5.2 sketch stores the retry condition as `attempt <= DISCOVERY_MAX_RETRIES`,
which the implementation honours; the off-by-one is in the §3.7 sketch's testing
comment only, not in the design decision itself.

**Consequence:**

- `tests/discovery-service.test.ts` "retries discovery up to
  DISCOVERY_MAX_RETRIES on a stuck challenge, then bubbles
  SecurityChallengeError" asserts
  `expect(browser.launches).toBe(EXPECTED_MAX_LAUNCHES_STUCK)` where
  `EXPECTED_MAX_LAUNCHES_STUCK = 4`, with an explanatory comment naming the
  contract: "DISCOVERY_MAX_RETRIES + the initial attempt = 4 total launches
  on a stuck challenge (per the §3.5.2 implementation: `attempt <=
  DISCOVERY_MAX_RETRIES` triggers a retry, so attempt 4 bubbles out)."
- The retry math at `discovery-service.test.ts` advances enough fake time
  (8 minutes = 480 s) to cover the cumulative ~390 s of stuck wait-outs +
  backoffs (30 + 45 + 30 + 90 + 30 + 135 + 30 = 390 s) so the rejection
  has fully settled before the assertion.

**Evidence:**

- `src/core/services/DiscoveryService.ts:91` `attempt++;` at the top of the
  loop; `DiscoveryService.ts:104` `if (isChallenge && attempt <=
  DISCOVERY_MAX_RETRIES)` as the retry gate.
- `tests/discovery-service.test.ts` `EXPECTED_MAX_LAUNCHES_STUCK = 4` with
  the comment naming the contract; the test asserts on the actual 4-launch
  bubble behaviour, NOT the proposal's `+ 0` sketch.

---

## D-FIX-3 - Reuse the existing `tests/fixtures/chapter-challenge.html` fixture as-is (no new fixture)

**Spec:** `docs/fix-issue-tui-url-cleanliness.md` §3.7 / §3.9 "Files Touched"
specifies the existing `tests/fixtures/chapter-challenge.html` is reused
unchanged. No new fixture.

**Deviation:** Implementation matches the spec exactly. Listed here only to
record explicitly that no `tests/fixtures/chapter-sequential-*.html` fixture
was added - the cleared-challenge test path uses a test-scoped
`MutableFakePage` defined inside `tests/chapter-list-service.test.ts` that
flips its cheerio API after a configurable `challengeCalls` count rather than
swapping between two html fixtures. This matches the proposal's stated approach
("the clearing case needs a `FakePage` variant, not a new HTML fixture").

**Reason:** Per the proposal's own note - the wait-out poll cadence is what
needs simulating, not a static DOM snapshot. A two-HTML-state page double
matches what the actual wait-out observes: an initial challenge DOM, then a
later clean DOM returned by the same `locatorCount` / `bodyInnerText` /
`title` accessors after the poll cadence advances.

**Consequence:**

- `tests/fixtures/chapter-challenge.html` is byte-identical to before this
  bug fix.
- The `MutableFakePage` test double owns its own `cheerio.load(...)` call
  per state (challenge HTML and clean HTML strings), with a `setCleanHtml`
  hook so the second `goto()` for `ch2` repoints the clean fixture at the
  ch-chapter HTML before `findElement(".next-btn")` runs. Encapsulating the
  flip in the test double (rather than a fixture file) keeps a single source
  of truth for the test scenario.

**Evidence:**

- `tests/chapter-list-service.test.ts` `class MutableFakePage` definition
  (lines 60-180), `setCleanHtml` setter, and the three sequential chapter
  HTML strings (`ch1Html`, `ch2Html`, `ch3Html`) declared inline at the
  top of the test file - NOT loaded from a `tests/fixtures/` file.

---
