# Fix Proposal: URL Double-Prefix Bug + TUI Cleanliness Pass + Sequential Discovery Challenge Wait-Out

Status: §3 (Sequential Discovery Challenge Wait-Out) has shipped as a bug-fix
implementation - see `docs/01-architecture-decisions.md` ADR-007 and
`docs/bug-fix-discovery-deviation-log.md` for the ADR + divergence record.
The remaining sections (§1 URL double-prefix, §2 TUI cleanliness) are still
proposal only; no business logic changed for those in this work. Every fix
below is described with handholding detail (exact files, line numbers,
snippets, and tests) so a follow-up commit can land it in one pass.

This doc covers three confirmed problems:

1. **URL double-prefix bug** in the "Log in via browser" cookie-capture flow
2. **TUI noise / cleanliness** - several screens overprint the log region on every
   loop iteration and the Shell never renders the header/footer strips the Phase 3
   design doc calls for
3. **Sequential discovery closes the browser without waiting out security challenges** -
   the manual sequential wizard's discovery phase has no `waitOutChallenge` /
   `SecurityChallengeError` machinery (unlike the scrape phase), so a first-page
   Cloudflare challenge causes the discovery browser to close immediately and the
   user gets back a one-URL (or zero-URL) list with no retry

A fourth topic (cookies not used for metadata/chapter-link scraping) was investigated
and determined to be a non-issue - cookies ARE attached on both the TUI auto-probe
path (`AutoProbeScreen` via `scope.resolveCookiesForScrape`) and the CLI `run`
path (driven by `--cookies-file`). Excluded from this proposal.

---

## 1. URL Double-Prefix Bug in Browser Login Capture

### 1.1 Symptom

User opens the cookie manager, picks "Log in via browser", and the prompt comes
up pre-filled with `https://www.webnovel.com` (or whatever domain). The user
starts typing the full URL `https://www.webnovel.com/login` and ends up with
`https://https://www.webnovel.com/login` in the field. The validator accepts it.
The browser then navigates to a URL whose hostname is literally `https`, which
of course fails to load, and the user is left staring at a "Browser login
capture failed" message with no clear cause.

### 1.2 Root Cause

Two separate defects compose into the bug:

**Defect A - the prompt seed invites the double prefix.**
`src/adapters/ui-clack/screens/CookieManagerScreen.ts:442-446`:

```ts
const loginUrl = await ctx.prompt.text({
  message: "Page to open first:",
  initial: `https://${domain}`,
  validate: validateUrl,
});
```

The `initial` value is the full `https://<domain>` form. When the user wants
to append a path (e.g. `/login`), the natural editing gesture is "click at end
of field, type the path". But many terminal setups also let the user start
typing immediately, in which case the first `h` of `https://` they type gets
spliced after the seed, producing `https://https://...`. Compounding this, the
seed is a visual hint ("here is what a valid URL looks like") but it is also
editable input, so the user is never sure whether to overwrite or append.

**Defect B - the validator accepts the malformed URL.**
`src/adapters/ui-clack/validation.ts:34-41`:

```ts
export function validateUrl(val: string): boolean | string {
  try {
    new URL(val.trim());
    return true;
  } catch {
    return "Please enter a valid URL (include https://)";
  }
}
```

`new URL("https://https://www.webnovel.com/")` does NOT throw. The WHATWG URL
parser treats the segment after the scheme as an opaque "scheme-relative"
authority, so the resulting URL has:

- `protocol === "https:"`
- `hostname === "https"`
- `pathname === "/www.webnovel.com/"`

So `validateUrl` returns `true` for a URL whose hostname is the literal string
`https`. Every downstream consumer (the browser `goto`, the cookie-store
domain matcher, the site-adapter `matches()` regex) proceeds on a URL that can
never satisfy its intent.

### 1.3 Fix Sketch

Two independent edits, both tiny. Land both.

**Fix A: drop the `https://` seed and use a placeholder instead.**

The seed was meant to save typing on the common case (no path, just open the
homepage). But the homepage is also the worst case to suggest typing into -
the user almost always wants to navigate to the actual login page, which is
deeper. Replace the seed with a placeholder that disappears the moment the
user types, and set `validate` to insert the scheme if the user typed a
bare hostname.

`src/adapters/ui-clack/screens/CookieManagerScreen.ts` - replace lines
442-446 with:

```ts
const loginUrl = await ctx.prompt.text({
  message: "Page to open first:",
  placeholder: `https://${domain}/login`,
  validate: validateUrl,
});
```

If the user just hits Enter on the empty field, clack returns the empty
string; `validateUrl` (post-fix B) will reject it with a clear message
rather than silently navigating to `https://${domain}`. If the user types
`www.webnovel.com/login`, the fixed `validateUrl` will prepend `https://`
during normalization so the returned value is well-formed.

**Fix B: tighten `validateUrl` to reject scheme-doubled URLs and to
normalize bare hostnames.**

`src/adapters/ui-clack/validation.ts` - replace `validateUrl` (lines 34-41)
with:

```ts
export function validateUrl(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return "URL cannot be empty";
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "Please enter a valid URL (include https://)";
  }
  if (!parsed.hostname.includes(".")) {
    return "URL hostname looks invalid (no dot in hostname)";
  }
  return true;
}
```

This does three things:

1. **Rejects empty input** with a clear message instead of "Please enter a
   valid URL" (which is misleading when the field is blank).
2. **Prepends `https://` if the user typed a bare hostname** (e.g.
   `www.webnovel.com/login`), so the caller doesn't have to do that
   normalization itself.
3. **Rejects scheme-doubled URLs** by checking the hostname contains a dot.
   `https://https://www.webnovel.com/` would parse with `hostname === "https"`,
   which has no dot, so the validator rejects it with a message that points
   at the actual problem.

However, this fix alone is not enough to actually produce a usable URL - the
caller (`CookieManagerScreen.captureViaLoginFlow`) still receives the user's
raw input (`https://https://...`) because the validator returns `true`/`false`
not the normalized value. Two options:

**Option B1 (recommended): have `validateUrl` return the normalized URL.**
Clack's `text.validate` contract allows returning `string | Error | undefined`
where a `string` is treated as an error message. So the validator cannot
mutate the returned value. Instead, expose a separate helper that the caller
uses to normalize the validated input:

`src/adapters/ui-clack/validation.ts` - add after `validateUrl`:

```ts
export function normalizeUrl(val: string): string {
  const trimmed = val.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}
```

Then `CookieManagerScreen.ts:463` becomes:

```ts
session = await beginCapture(deps, normalizeUrl(loginUrl));
```

(Replace `loginUrl.trim()` with `normalizeUrl(loginUrl)`.) This is a pure
additive helper - no existing caller behavior changes, and the new caller is
the only place that uses it, which is appropriate per AGENTS.md
"introduce patterns only when the complexity REALLY justifies it" - the
complexity here is "we need to normalize URLs in two places: validation
and call site", which is just enough to justify one helper.

**Option B2 (not recommended): have `validateUrl` mutate via a closure.**
Anti-pattern; pure validators should not side-effect. Not pursued.

### 1.4 Testing

The existing test file for Phase 3 TUI is `tests/phase-3-tui.test.ts`. It
has no test for `validateUrl` or for `captureViaLoginFlow` - both gaps are
worth closing in the same commit that ships the fix.

**Unit tests for the validator (`tests/phase-3-tui.test.ts` or a new
`tests/validation.test.ts`):**

```ts
import { describe, it, expect } from "vitest";
import { validateUrl, normalizeUrl } from "../src/adapters/ui-clack/validation.js";

describe("validateUrl", () => {
  it("accepts a well-formed https URL", () => {
    expect(validateUrl("https://www.webnovel.com/login")).toBe(true);
  });
  it("accepts a bare hostname (no scheme) - caller will prepend https://", () => {
    expect(validateUrl("www.webnovel.com/login")).toBe(true);
  });
  it("rejects empty input", () => {
    expect(validateUrl("")).toBe("URL cannot be empty");
    expect(validateUrl("   ")).toBe("URL cannot be empty");
  });
  it("rejects scheme-doubled URLs", () => {
    expect(validateUrl("https://https://www.webnovel.com/")).toMatch(/hostname looks invalid/);
    expect(validateUrl("https://http://example.com/")).toMatch(/hostname looks invalid/);
  });
  it("rejects a hostname with no dot", () => {
    expect(validateUrl("https://localhost")).toMatch(/hostname looks invalid/);
  });
});

describe("normalizeUrl", () => {
  it("prepends https:// to a bare hostname", () => {
    expect(normalizeUrl("www.webnovel.com/login")).toBe("https://www.webnovel.com/login");
  });
  it("leaves a fully-qualified URL untouched", () => {
    expect(normalizeUrl("https://www.webnovel.com/login")).toBe("https://www.webnovel.com/login");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeUrl("  https://example.com/  ")).toBe("https://example.com/");
  });
});
```

Note: the existing `validateUrl` had NO unit tests at all. Adding them is a
strict improvement; they should pass against the current code for cases 1
and 5, and would have caught the scheme-doubled case before it ever shipped
if they had existed.

**Behavioral test for the capture flow (`tests/phase-3-tui.test.ts`):**

The existing `ScriptedPromptProvider` (`src/adapters/ui-clack/ScriptedPromptProvider.ts`)
records all calls. Combined with a `FakeBrowserPort` whose `goto` actually
records the URL it was called with (see §2.3 below - this is a separate
test-infrastructure fix that the TUI pass needs anyway, so do it first),
write a test that drives `CookieManagerScreen.captureViaLoginFlow` with
scripted inputs and asserts the URL handed to `beginCapture` is correctly
normalized:

```ts
import { ScriptedPromptProvider } from "../src/adapters/ui-clack/ScriptedPromptProvider.js";
import { FakeBrowserPort } from "../src/adapters/store-memory/FakeBrowserPort.js";
// ... other deps

it("does not double-prefix the login URL when the user types https:// again", async () => {
  const prompt = new ScriptedPromptProvider({
    text: [
      { value: "https://www.webnovel.com/login" }, // the login URL prompt
    ],
    // ... other prompts the screen shows
  });
  const browser = new FakeBrowserPort();
  // ... wire ShellContext per the existing makeCtx helper in phase-3-tui.test.ts

  // Drive the screen. After it returns, assert:
  const gotoCall = browser.contexts[0]?.gotoCalls[0];
  expect(gotoCall).toBe("https://www.webnovel.com/login");
});
```

This test cannot pass today because (a) `FakeBrowserPort.goto` discards its
`_url` argument (`src/adapters/store-memory/FakeBrowserPort.ts:25`) and (b)
`FakeBrowserPort.createContext` discards its `_cookies` argument. Fixing
`FakeBrowserPort` is item 2.4 below; do that first, then write this test.

### 1.5 Migration / Compatibility

No data migration. No store schema change. The validator change is a
presentation tighten - any URL that passed under the old validator still
passes under the new one EXCEPT scheme-doubled URLs, which were never
useful to begin with. No deployment risk.

### 1.6 Files Touched

| File | Change |
|------|--------|
| `src/adapters/ui-clack/validation.ts` | Tighten `validateUrl`; add `normalizeUrl` export |
| `src/adapters/ui-clack/screens/CookieManagerScreen.ts:442-446` | Replace `initial` with `placeholder`; call `normalizeUrl(loginUrl)` on line 463 |
| `tests/phase-3-tui.test.ts` OR new `tests/validation.test.ts` | Add validator + capture-flow tests |

### 1.7 Out-of-Scope non-fixes

Do NOT also "fix" `validateDomain` (`validation.ts:11-21`) in the same
pass. It has a different shape (it explicitly handles the `http` prefix
case) and its behavior is correct for its purpose. Touching it in the same
commit muddies the diff; if it needs a parallel tighten later, file it
separately.

---

## 2. TUI Cleanliness Pass

### 2.1 Symptoms

Three observable noises:

1. **The main menu banner reprints on every render.** Open the app, see the
   banner. Pick a menu item, hit Cancel to come back, see the banner again.
   Navigate around the shell and come back, see the banner yet again.
   Each visit pushes the previous banner one screen-height up, swamping the
   log region with redundant header text.

2. **`ChapterListScreen` reprints the entire chapter list on every loop
   iteration.** When the user does "remove chapters by index" then returns
   to the menu, the full list (potentially hundreds of chapters) is logged
   again before the action prompt. The log region grows quadratically with
   the number of review passes.

3. **`SettingsScreen.printProfile` emits ~14 separate `log("info", ...)`
   rows per profile.** Each row is one line of a logical "profile card".
   Nothing ties them together visually; they are indistinguishable from
   normal log lines.

### 2.2 Root Cause

**Common cause: the Phase 3 design doc
(`docs/03-tui-design.md` and `docs/phase-3/readme.md:289`) specifies a
header strip / footer strip / log region as three distinct regions, but
`Shell.ts` never renders them.** The Shell just runs the screen-render
loop and lets each screen dump `log("info", ...)` calls into clack's
streaming log region. There is no banner-once invariant, no fixed header,
no fixed footer.

The screens individually try to compensate by re-emitting "their" header
on each render. `MainScreen.ts:24` does `ctx.prompt.log("info", fmt.banner())`
inline. `ChapterListScreen.ts:66-80` does `ctx.prompt.log("info", cfg.title)`
plus the per-volume summary plus `printChapterList(ctx, current)`
inline. None of these are idempotent across renders because the screen
has no way to ask "have I already printed my header?"

### 2.3 Phase 3 Design Doc Recap

The original design (`docs/03-tui-design.md` §4, "regions"; referenced by
`docs/phase-3/readme.md:289` in the test-plan table) describes a 3-region
layout:

- **Header strip** - the app banner + active session count, always at the
  top, printed ONCE per Shell.run() invocation, NOT per-screen-render.
- **Log region** - clack's streaming log region; screens write status /
  informational rows here.
- **Footer strip** - persistent hint line ("Ctrl+Q to quit, Esc to go back",
  etc.), printed once at shutdown or whenever the region would scroll past
  it.

The current `Shell.ts` (190 lines, full file read above) does none of this.
It just renders screens in a `while (!quitRequested && stack.length > 0)`
loop and lets them emit log rows. The screens have no choice but to
re-emit their headers themselves.

### 2.4 Fix Sketch

Three independent fixes, each small. They can be landed in any order, but
the third depends on a small test-infrastructure improvement first.

#### 2.4.1 Strip the banner from `MainScreen.render`

`src/adapters/ui-clack/screens/MainScreen.ts:24`:

```ts
ctx.prompt.log("info", fmt.banner());
```

This line should be removed. The banner belongs in the header strip
(rendered once by the Shell - see §2.4.4 below), not re-emitted on every
main-menu render. With the Shell-side header in place, this line is
redundant; without the Shell-side header, it is at best a poor
substitute that reprints on every visit. Either way, delete it.

After the delete, `MainScreen.render` becomes a simple `select` prompt
with no log noise. The cancellation and dispatch logic at lines 42-66
stays untouched.

#### 2.4.2 Stop reprinting the chapter list on every `ChapterListScreen` loop iteration

`src/adapters/ui-clack/screens/ChapterListScreen.ts:61-95` currently does
this on every iteration of its `while (true)` loop:

```ts
ctx.prompt.log("info", cfg.title ?? "Chapter List Review");
ctx.prompt.log("info", `Found ${current.length} chapter(s)`);
if (cfg.volumes && cfg.volumes.length > 0) {
  for (const v of cfg.volumes) {
    ctx.prompt.log("dim", `Volume: ${v.name} - ${v.chapterUrls.length} chapters`);
  }
}
printChapterList(ctx, current);
```

The 4 log calls plus `printChapterList` (which logs one line per chapter)
all fire on every iteration. After the user picks "Remove chapters" and
returns, the entire list reprints. This is the dominant source of TUI
noise.

Fix: print the list ONCE before the loop, then inside the loop only
reprint the list if the user explicitly asked ("view") OR the list
changed (after a remove / add / reverse). The action prompt itself
never needs the list reprinted above it.

Stub sketch:

```ts
async render(ctx: ShellContext, params?: unknown): Promise<ScreenResult> {
  const cfg = params as ChapterListParams;
  let current = [...cfg.urls];

  // Print the list once, up-front.
  ctx.prompt.log("info", cfg.title ?? "Chapter List Review");
  ctx.prompt.log("info", `Found ${current.length} chapter(s)`);
  if (cfg.volumes && cfg.volumes.length > 0) {
    for (const v of cfg.volumes) {
      ctx.prompt.log("dim", `Volume: ${v.name} - ${v.chapterUrls.length} chapters`);
    }
  }
  printChapterList(ctx, current);

  let listDirty = false; // true after remove/add/reverse - reprint then.

  while (true) {
    const action = await ctx.prompt.select<Action>({
      message: "What would you like to do?",
      options: [
        { value: "proceed", label: `Proceed with all ${current.length} chapters` },
        { value: "remove", label: "Remove chapters by index or range" },
        { value: "add", label: "Add chapter URLs" },
        { value: "reverse", label: "Reverse the order (first becomes last)" },
        { value: "view", label: "View the full chapter list" },
        { value: "back", label: "Cancel and go back" },
      ],
    });

    if (action === Cancel || action === "back") return { action: "pop" };

    if (action === "view") {
      printChapterList(ctx, current);
      listDirty = false;
      continue;
    }
    if (action === "proceed") {
      // ... existing proceed handling unchanged
    }
    if (action === "remove") {
      // ... after the remove succeeds:
      listDirty = true;
    }
    // ... etc for add / reverse

    if (listDirty) {
      ctx.prompt.log("info", `Updated: ${current.length} chapter(s)`);
      printChapterList(ctx, current);
      listDirty = false;
    }
  }
}
```

The "full reprint on every iteration" is replaced with "reprint only when
something changed, plus an explicit 'view' affordance". This preserves all
existing user-facing affordances and only removes the redundant noise.

#### 2.4.3 Collapse `SettingsScreen.printProfile` into one `note` call

`src/adapters/ui-clack/screens/SettingsScreen.ts:433-453` currently does:

```ts
private printProfile(ctx: ShellContext, p: SiteProfile): void {
  ctx.prompt.log("info", "");
  const row = (k: string, v: string) => ctx.prompt.log("info", `${k.padEnd(22)} ${v}`);
  row("Domain", p.domain);
  if (p.label) row("Label", p.label);
  row("Method", p.method);
  // ... 10+ more row() calls
}
```

Each `row()` is a separate `log("info", ...)` call, so each becomes a
separate row in clack's streaming log region with no visual grouping.

`@clack/prompts@1.1.0` exports a `note(message?, title?, opts?)` function
(verified: see `node_modules/@clack/prompts/dist/index.d.mts:104` - this
is the only place we'd add a new clack dependency, and clack is already the
prompt library). `note` renders a single boxed region with a title -
exactly the "profile card" visual this function is reaching for.

Fix sketch:

1. Add a `note(message?: string, title?: string): void` method to
   `PromptProvider.ts` (the typed seam). It is a pure UI output (no user
   input), so no Cancel-handling concerns.

2. In `clackPrompts.ts` (the sole allowed `@clack/prompts` import site
   per the T1 isolation test), implement `note` as a one-line wrapper
   around `clack.note`.

3. In `ScriptedPromptProvider.ts`, implement `note` as a stub that records
   the call (so tests can assert on it) and otherwise does nothing. The
   recording mirrors the existing `log` recording pattern.

4. Rewrite `SettingsScreen.printProfile` as:

```ts
private printProfile(ctx: ShellContext, p: SiteProfile): void {
  const lines: string[] = [];
  const row = (k: string, v: string) => lines.push(`${k.padEnd(22)} ${v}`);
  row("Domain", p.domain);
  if (p.label) row("Label", p.label);
  row("Method", p.method);
  row("Content", p.contentSelector);
  row("Sep.title", String(p.separateTitle));
  if (p.titleSelector) row("Title sel.", p.titleSelector);
  if (p.excludeSelectors.length) row("Exclude", p.excludeSelectors.join(", "));
  if (p.nextButtonLocators?.length) {
    p.nextButtonLocators.forEach((l: NextLocator, i: number) => {
      row(i === 0 ? "Next (primary)" : `Next (fallback ${i})`, formatLocator(l));
    });
  }
  if (p.concurrency != null) row("Concurrency", String(p.concurrency));
  if (p.delayMin != null) row("Delay", `${p.delayMin}-${p.delayMax} ms`);
  if (p.notes) row("Notes", p.notes);
  row("Saved", p.savedAt.slice(0, 10));
  row("Updated", p.updatedAt.slice(0, 10));
  ctx.prompt.note(lines.join("\n"), `Profile: ${p.domain}`);
}
```

Each `row()` now pushes to an array instead of emitting a log row. The
whole card is rendered as a single `note(...)` call. Visually: a boxed
region titled "Profile: <domain>" with all the rows inside, distinct from
the surrounding log stream.

#### 2.4.4 Optional: have the Shell render a one-time header strip (design-doc intent)

This is the larger of the four but is the actual root-cause fix the
design doc wanted. It is optional in the sense that even without it,
deleting the `MainScreen.ts:24` banner reprint (§2.4.1) is a strict
improvement - the user just sees no banner at all, which is cleaner than
seeing it ten times.

If pursued, the Shell renders the banner once at the start of `run()`,
before the first screen-render:

`src/adapters/ui-clack/Shell.ts:79-83` - in `run()`, before the
`while (!quitRequested && this.stack.length > 0)` loop, add:

```ts
async run(startScreen: string, params?: unknown): Promise<void> {
  this.stack.push({ screen: startScreen, params });
  this.installQuitListener();

  // Header strip - printed once per shell session (03-tui-design §4 /
  // readme §2.7). NOT emitted by individual screens.
  this.deps.prompt.log("info", fmt.banner());
  // ... footer could be added on shutdown via clack.outro (see below)
```

This requires adding `import * as fmt from "./format.js"` to `Shell.ts`
(trivial - `format.ts` is already imported elsewhere in the adapter).

The footer strip is simpler still: at the end of `run()` (after the
while loop), or in `shutdown()`, emit a one-line footer via
`clack.outro`. But `clackPrompts.ts` would need an `outro` method and
`PromptProvider.ts` would need to declare it - same shape as the `note`
addition in §2.4.3. Lower priority than the §2.4.1-3 fixes because the
app currently exits cleanly on quit without any footer noise.

Verdict: do §2.4.1 always (it is a one-line delete). Do §2.4.4 only if you
want the banner to remain visible - if a no-banner main menu is
acceptable, skip it and save the Shell-complexity budget.

### 2.5 Test Infrastructure Prerequisite

`src/adapters/store-memory/FakeBrowserPort.ts:25` - the `goto` method
currently discards its `_url` parameter:

```ts
async goto(_url: string): Promise<void> { /* no-op */ }
```

And `createContext` (same file) discards its `_cookies` parameter.

For the §1.4 behavioral test (which asserts what URL the capture flow
actually navigates to) and for any future test that asserts cookies were
attached to a context, `FakeBrowserPort` needs to record these values.

Fix sketch for `FakeBrowserPort.ts`:

```ts
interface FakeContext {
  // ... existing fields
  gotoCalls: string[];
  cookies: Cookie[];
}

async goto(url: string): Promise<void> {
  this.gotoCalls.push(url);
}
```

This is additive only - existing tests that do not assert on `gotoCalls`
or `cookies` keep passing untouched. Verify by running `pnpm test` after
the change; if any existing test breaks, it is because it was relying
on the field not existing (unlikely, since these are new fields).

### 2.6 Testing

**For §2.4.1 (banner removal):** existing `tests/phase-3-tui.test.ts`
already drives `MainScreen` through `ScriptedPromptProvider`. After the
delete, assert that `findLog(prompt, "info", /webnovel-scraper/i)` returns
no matches when `MainScreen.render` is invoked with a scripted "select
Quit" prompt. The existing tests should already mostly cover the
"renders the main menu" path - update them to NOT expect a banner log
row that they currently (implicitly) tolerate.

**For §2.4.2 (chapter list reprint):** add a test that drives
`ChapterListScreen` through two loop iterations (first pick "remove",
then on the next iteration pick "back"). Assert that
`countLogRows(prompt, /Chapter \d+/)` is exactly the chapter count, NOT
double the chapter count. The existing tests do not cover
`ChapterListScreen` at all - this would be a new test in the same file.

**For §2.4.3 (note-based profile card):** add a test that calls
`SettingsScreen.printProfile` (or that drives the screen through
"view profile") and asserts that `prompt.noteCalls` (a new field on
`ScriptedPromptProvider`) has exactly one entry whose title matches
`Profile: <domain>`. Assert NO `log("info", "Domain")` row was
emitted.

**For §2.4.4 (Shell header):** add a test that constructs a `Shell`
with a `ScriptedPromptProvider`, calls `run("main", undefined)` with a
scripted "Quit" selection, and asserts that `prompt.logCalls`
contains exactly one `info` row matching the banner regex.

### 2.7 Files Touched

| File | Change |
|------|--------|
| `src/adapters/ui-clack/screens/MainScreen.ts:24` | Delete the `fmt.banner()` log line |
| `src/adapters/ui-clack/screens/ChapterListScreen.ts:61-95` | Move the title/list prints out of the loop; add `listDirty` reprint gate |
| `src/adapters/ui-clack/screens/SettingsScreen.ts:433-453` | Build a string array; call `ctx.prompt.note(arr.join("\n"), title)` instead of N log rows |
| `src/adapters/ui-clack/PromptProvider.ts` | Add `note(message?: string, title?: string): void` to the interface |
| `src/adapters/ui-clack/clackPrompts.ts` | Implement `note` as `clack.note(...)` |
| `src/adapters/ui-clack/ScriptedPromptProvider.ts` | Add `noteCalls: { message: string; title?: string }[]` recording |
| `src/adapters/ui-clack/Shell.ts` (optional §2.4.4) | Emit banner once in `run()`; add `import * as fmt from "./format.js"` |
| `src/adapters/store-memory/FakeBrowserPort.ts` | Record `gotoCalls: string[]` and `cookies` on context (enables the §1.4 test too) |
| `tests/phase-3-tui.test.ts` | Add tests for §2.4.1 no-banner, §2.4.2 no-reprint, §2.4.3 single `note` call, §2.4.4 banner-once (if shipped) |

### 2.8 Rollout Order

1. **Fix B (`validateUrl` + `normalizeUrl`)** + its unit tests - pure
   additive, no behavioral risk. Land first.
2. **Fix A (CookieManagerScreen prompt change)** + the `FakeBrowserPort`
   recording improvement + the capture-flow behavioral test. Depends on
   step 1 for the normalization.
3. **TUI fixes §2.4.1, §2.4.2, §2.4.3** in any order - they are independent
   of each other and of step 2.
4. **TUI fix §2.4.4** (Shell header strip) - only if a no-banner main
   menu is not acceptable. Lowest priority.

Each step can be its own commit. Steps 1 and 2 close the URL bug; steps
3 and 4 close the TUI noise.

For section 3 (sequential discovery challenge wait-out) the rollout order
within that section is:

1. **`FakeBrowserPort` `gotoCalls` recording** (carried over from §2.5) -
   prerequisite for the §3.7 retry tests. Land first.
2. **`ChapterListService` constructor change + `waitOutChallenge`
   injection** (`§3.5.1`) with the stuck-challenge unit test. Pure
   behavior-preserving on sites that never present a challenge.
3. **`discoverJobChapters` retry loop** (`§3.5.2`) with the
   retry-on-challenge behavioral test using fake timers.
4. **`ManualDiscoveryScreen` `challenge.waiting` UI handler** (`§3.5.3`)
   so the user sees the wait instead of an apparent hang during the
   30-second in-page poll.

Step 2 is the load-bearing seam. Step 3 alone (without 2) would not help
because the existing `ChapterListService` cannot even signal a stuck
challenge - it silently breaks the walk. Step 4 alone (without 3) would
let the user see the wait but the discovery would still give up after one
in-page wait-out rather than retrying. So ship step 2 first, then 3, then 4.
Step 1 is shared with the URL-bug rollout and only needs to land once.

---

## 3. Sequential Discovery Closes Browser Without Waiting Out Security Challenges

Status: SHIPPED. ADR-007 (`docs/01-architecture-decisions.md`) +
`docs/bug-fix-discovery-deviation-log.md` record the implementation and
divergences from the design sketch here. Sections 3.1-3.10 below are the
original proposal text preserved for reference; the live source of truth for
the shipped behaviour is now the ADR + deviation log + the test files
referenced there (the inline snippets here are the proposal's sketches and
may differ from the landed code in details captured in the deviation log).

### 3.1 Symptom

User runs the manual sequential wizard: they enter a `firstChapterUrl`,
`lastChapterUrl`, and one or more `nextButtonLocators`. The screen then
hands off to discovery (`ManualDiscoveryScreen`), which opens the first
chapter URL. If that first page (or any subsequent page in the next-button
walk) is intercepted by a Cloudflare / anti-bot challenge, the browser
closes immediately without waiting for the challenge to auto-resolve. The
discovery returns a URL list containing only the first URL (or an
incomplete prefix of the chain), and the user is dropped back at the
"Discovered N chapter URL(s)" summary with a misleadingly short list
(or none, depending on the failure shape). The challenge machinery that
the user can observe working during the actual scrape (`"challenge.waiting"`
events, 30-second in-page poll, 45-second `CHALLENGE_BACKOFF_MS` retry)
never fires.

The same defect affects the `toc` discovery method (`discoverTOC`):
 Cloudflare intercepts the TOC URL, the page DOM contains `#challenge-form`
instead of chapter links, `discoverTOC` collects zero links, and the
`finally` block closes the browser. The sequential framing in the user's
report is just the more visible case (`firstChapterUrl` is the only URL the
user can supply, so the whole walk happens on a single chain that starts
at the challenge).

### 3.2 Root Cause

There are two distinct lifecycle phases in `runJob` (`src/app/runJob.ts:54-56`),
and they have asymmetric challenge handling:

1. **Discovery phase** (`discoverJobChapters`) - launches its own browser (
   `DiscoveryService.ts:50-57`), walks the TOC or next-button chain via
   `ChapterListService`, closes the browser in a `finally` block (
   `DiscoveryService.ts:90-92`). **`DiscoveryService` and `ChapterListService`
   do NOT import or call `waitOutChallenge`, `detectChallenge`, or
   `SecurityChallengeError`.** Confirmed by grep: zero matches in either file.

2. **Scrape phase** (`ScrapeService.run`) - launches its own browser (
   `ScrapeService.ts:65-87`), per-chapter extraction calls
   `ChapterExtractor.extract` which calls `waitOutChallenge` after every
   `page.goto` (`ChapterExtractor.ts:169`), and `ScrapeService`'s catch
   block applies the 45-second `CHALLENGE_BACKOFF_MS` retry on
   `SecurityChallengeError` (`ScrapeService.ts:233-275`).

The challenge machinery exists and works. It is just not wired into the
discovery phase at all. `runJob.ts:54-56`:

```ts
if (!job.chapterLinks && !resume) {
  job.chapterLinks = await discoverJobChapters(job, { browser, cookies, ui, log });
}
```

`discoverJobChapters` runs to completion (or failure) and closes its
browser before `ScrapeService` ever gets a chance to handle challenges.
When the user supplies `chapterLinks` directly (pre-resolved list, or
auto-probe flow, or resume from session), `discoverJobChapters` short-
circuits at `DiscoveryService.ts:46-48` and never opens a browser - so
the scrape phase owns challenges end-to-end and the bug does not fire.
The bug is exclusively a discovery-phase defect.

### 3.3 Confirmed Control-Flow Path

The user's report maps to this exact path (file paths and line numbers
quoted verbatim from the current tree):

**`src/adapters/ui-clack/screens/ManualWizardScreen.ts:225-235`** - the
wizard produces a `JobConfig` with empty `chapterLinks` and `method:
"sequential"` plus `firstChapterUrl` / `lastChapterUrl` /
`nextButtonLocators`, then pushes `ManualDiscoveryScreen`.

**`src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts:42-49`** - the
screen calls the shared `discoverJobChapters` helper:

```ts
urls = await discoverJobChapters(job, {
  browser: ctx.browser,
  cookies,
  ui,
  log: ctx.log,
});
```

**`src/core/services/DiscoveryService.ts:59-92`** - the helper opens a
browser, creates one context, builds one page, dispatches to
`ChapterListService`, then unconditionally closes everything in `finally`:

```ts
try {
  const ctx = await deps.browser.createContext(browserHandle, deps.cookies);
  const page = await deps.browser.newPage(ctx);
  const listService = new ChapterListService(deps.log, deps.ui);

  let urls: string[];
  if (job.method === "toc" && job.tocUrl) {
    urls = await listService.discoverTOC(page, job.tocUrl, "domcontentloaded", 30_000);
  } else if (
    job.method === "sequential" &&
    job.firstChapterUrl &&
    job.lastChapterUrl &&
    job.nextButtonLocators
  ) {
    urls = await listService.collectSequential(
      page,
      job.firstChapterUrl,
      job.lastChapterUrl,
      job.nextButtonLocators,
      job.delayMin,
      job.delayMax,
      "domcontentloaded",
      30_000,
    );
  } else {
    throw new Error("Invalid discovery config");
  }

  await page.close();
  await ctx.close();
  return urls;
} finally {
  await browserHandle.close();   // <-- closes regardless of page state
}
```

**`src/core/services/ChapterListService.ts:140-168`** - inside
`collectSequential`, the first iteration pushes `firstChapterUrl` onto
`links` BEFORE doing any challenge check, then calls `page.goto`, then
calls `resolveNext` to find a next-button:

```ts
while (currentUrl && links.length < MAX_CHAPTERS) {
  if (visited.has(currentUrl)) {
    this.log.warn(`Navigation loop detected at ${currentUrl} - stopping`);
    break;
  }
  visited.add(currentUrl);
  links.push(currentUrl);                       // pushed before challenge check

  this.ui.emit({ type: "discovery.progress", found: links.length, pages: visited.size });

  if (currentUrl === lastUrl) {
    this.log.info(`Reached last chapter. Collected ${links.length} URL(s).`);
    break;
  }

  try {
    await page.goto(currentUrl, { waitUntil, timeoutMs: navTimeoutMs });  // challenge page
    await delay(Math.floor(delayMin * 0.4));
  } catch (e) {
    this.log.error(`Navigation failed: ${currentUrl}`, { error: (e as Error).message });
    break;
  }

  const resolved = await this.resolveNext(page, locators, hits, links.length);
  if (!resolved) break;                         // bails - no next-button on a CF page
  // ... never reaches the click/href-walk below ...
```

On a Cloudflare challenge page the DOM contains `#challenge-form` and
similar markers, NOT the site's next-button. `resolveNext` tries each
locator in turn (`findAnchorByRegex` / `findElement` / `findElement` with
`xpath=` prefix) and returns `null` because none of them match the
challenge DOM. The walk breaks on the first iteration. `links` = `[firstChapterUrl]`.
`discoverJobChapters` returns that single-URL list. The `finally` fires
`browserHandle.close()`. The user is presented with a "Discovered 1
chapter URL(s)" summary, and if they proceed, the scrape phase then opens
that same URL in a fresh browser - which may or may not hit the challenge
again (and if it does, `ScrapeService` will wait it out, so the scrape
phase itself is fine once discovery has handed back real URLs).

The `discoverTOC` failure shape is even more obvious: zero links collected
because the challenge DOM has no matching `<a href>` anchors, the screen
shows "No chapter links found on the TOC page", and the user is told to
"add session cookies" when the actual cause is a transient challenge the
app never let clear.

### 3.4 Why the Existing Challenge Machinery Doesn't Catch This

`ChapterExtractor.detectChallenge` and `waitOutChallenge` are the canonical
challenge handlers (`src/core/services/ChapterExtractor.ts:110-153`). They
are ONLY invoked from `ChapterExtractor.extract`, which is ONLY invoked
from `ScrapeService.processTask` (`ScrapeService.ts:177`). The discovery
phase has no seam to call them. There is no `SecurityChallengeError`
thrown from discovery, no 30-second poll, no `challenge.waiting` UI event,
no backoff. The discovery browser just shuts down. This is a load-bearing
asymmetry: the challenge machinery was built for the scrape loop and
never extended to the discovery loop, even though the discovery loop
performs the same `page.goto` on the same domain (often the same URL, if
`firstChapterUrl === chapter[0]`).

### 3.5 Proposed Implementation Design

The minimal, in-pattern fix wires the existing `ChapterExtractor.waitOutChallenge`
into the discovery phase at two seams. No new challenge logic is invented;
the existing constants (`CHALLENGE_MAX_WAIT_MS = 30_000`, `CHALLENGE_POLL_MS
= 2_000`, `CHALLENGE_BODY_TEXT_MAX_LEN = 2_000`) and the existing three-tier
detection from `ChapterExtractor.ts:24-48, 110-133` are reused verbatim.
The fix has three coordinated parts.

#### 3.5.1 Inject challenge wait-out into `ChapterListService.collectSequential`/`discoverTOC`

`ChapterListService` currently takes `(log, ui)` in its constructor
(`ChapterListService.ts:28`). Add an optional `ChapterExtractor` dependency
so the service can wait out a challenge after every `page.goto`.

**`src/core/services/ChapterListService.ts` - constructor change:**

```ts
import { ChapterExtractor } from "./ChapterExtractor.js";
import { SecurityChallengeError } from "../errors.js";

export class ChapterListService {
  constructor(
    private log: Logger,
    private ui: UIAdapter,
    private extractor?: ChapterExtractor,
  ) {}
```

**`src/core/services/ChapterListService.ts` - inside `collectSequential`,
after the `page.goto` at line 160, add the wait-out:**

```ts
try {
  await page.goto(currentUrl, { waitUntil, timeoutMs: navTimeoutMs });
  await delay(Math.floor(delayMin * 0.4));

  if (this.extractor) {
    const challenge = await this.extractor.waitOutChallenge(page);
    if (challenge === "stuck") {
      throw new SecurityChallengeError(currentUrl);
    }
  }
} catch (e) {
  if (e instanceof SecurityChallengeError) throw e;   // propagate, do NOT silently break
  this.log.error(`Navigation failed: ${currentUrl}`, { error: (e as Error).message });
  break;
}
```

The same seam belongs in `discoverTOC` immediately after line 54 (`await
page.goto(current, { waitUntil, timeoutMs: navTimeoutMs });`). For TOC the
"stuck" outcome can reasonably drop the page from the queue and continue
to the next TOC page, but the simpler, consistent behavior is to throw
`SecurityChallengeError` and let the caller decide. The
`DiscoveryService.waitForChallengeToClear` retry loop (3.5.2 below) will
retry the whole discovery, so throwing is the right call.

#### 3.5.2 Add a discovery-phase retry loop in `discoverJobChapters`

`ScrapeService` already has a `maxRetries = 3` + `CHALLENGE_BACKOFF_MS`
loop (`ScrapeService.ts:106, 233-275`). Mirror that shape in
`DiscoveryService` so a stuck challenge backs off and re-attempts the
whole discovery from scratch. The discovery browser is cheap to relaunch
(one context, one page) and the failure mode today is "give up on the
first stuck challenge", so a parallel retry loop is the right design (not
a per-URL retry, which discovery doesn't track because it walks a chain).

**`src/core/services/DiscoveryService.ts` - restructure the body:**

```ts
import { ChapterExtractor } from "./ChapterExtractor.js";
import { SecurityChallengeError } from "../errors.js";

const DISCOVERY_MAX_RETRIES = 3;
const DISCOVERY_CHALLENGE_BACKOFF_MS = 45_000;

export async function discoverJobChapters(
  job: JobConfig,
  deps: { browser: BrowserPort; cookies: DomainCookie[]; ui: UIAdapter; log: Logger },
): Promise<string[]> {
  if (job.chapterLinks && job.chapterLinks.length > 0) {
    return job.chapterLinks;
  }

  const extractor = new ChapterExtractor(deps.log);
  let attempt = 0;

  while (true) {
    attempt++;
    const browserHandle = await deps.browser.launch({
      headless: job.headless,
      humanize: false,
      humanPreset: "default",
      fingerprintSeed: null,
      timezone: "America/New_York",
      locale: "en-US",
    });
    try {
      const ctx = await deps.browser.createContext(browserHandle, deps.cookies);
      const page = await deps.browser.newPage(ctx);
      const listService = new ChapterListService(deps.log, deps.ui, extractor);

      let urls: string[];
      if (job.method === "toc" && job.tocUrl) {
        urls = await listService.discoverTOC(page, job.tocUrl, "domcontentloaded", 30_000);
      } else if (
        job.method === "sequential" &&
        job.firstChapterUrl &&
        job.lastChapterUrl &&
        job.nextButtonLocators
      ) {
        urls = await listService.collectSequential(
          page, job.firstChapterUrl, job.lastChapterUrl,
          job.nextButtonLocators, job.delayMin, job.delayMax,
          "domcontentloaded", 30_000,
        );
      } else {
        throw new Error("Invalid discovery config");
      }

      await page.close();
      await ctx.close();
      return urls;
    } catch (e) {
      const isChallenge = e instanceof SecurityChallengeError;
      if (isChallenge && attempt <= DISCOVERY_MAX_RETRIES) {
        deps.ui.emit({ type: "challenge.waiting", url: job.firstChapterUrl ?? job.tocUrl ?? "" });
        deps.log.warn(
          `Security challenge during discovery (attempt ${attempt}/${DISCOVERY_MAX_RETRIES}) - retrying after ${attempt * DISCOVERY_CHALLENGE_BACKOFF_MS}ms`,
        );
        await delay(attempt * DISCOVERY_CHALLENGE_BACKOFF_MS);
        continue;   // relaunch the discovery browser and try the walk again
      }
      throw e;       // non-challenge error, or out of retries: bubble to the screen
    } finally {
      await browserHandle.close();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

This mirrors `ScrapeService.ts:233-275` line for line in shape: same
backoff math (`attempt * CHALLENGE_BACKOFF_MS`), same `challenge.waiting`
UI event, same `maxRetries = 3`. A discovery browser that hits a stuck
challenge now waits (in-page 30s poll first, then 45s/90s/135s inter-
attempt backoff with a fresh browser per attempt) before giving up. The
relaunch is critical: a stuck challenge is often transient (site is
rate-limiting the fingerprint), and a fresh browser context gets a fresh
TLS session + fingerprint seed, which is the documented behavioral
contract (`ChapterListService.collectSequential` reusing a single context
across challenge retries would just keep hitting the same fingerprint).

#### 3.5.3 Wire `ChapterExtractor` through from `ManualDiscoveryScreen` / `AutoProbeScreen`

`ManualDiscoveryScreen.ts:44-49` and `runJob.ts:55` already construct
`discoverJobChapters`'s deps inline; no caller change is needed because
step 3.5.2 constructs the `ChapterExtractor` internally. The TUI emits
`discovery.progress` today; the new `challenge.waiting` event during
discovery needs a UI-side handler in `ManualDiscoveryScreen` so the user
sees a message instead of an apparent hang during the 30-second poll.

**`src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts` - inside the
existing `new ClackUIAdapter(ctx.prompt)` block, before the
`discoverJobChapters` call:**

```ts
const ui = new ClackUIAdapter(ctx.prompt);
ui.onEvent((e) => {
  if (e.type === "challenge.waiting") {
    ctx.prompt.log("warn", `Security challenge detected - waiting for it to clear...`);
  }
});
```

`TaskScreen.ts:111-122` already routes the same event to the spinner
message during the scrape phase; this is the discovery-phase analogue.

### 3.6 Why This Design (and Not the Alternatives)

**Rejected alternative A - "just reuse `ScrapeService`'s wait-out by
running discovery inside the scrape loop".** Discovery and scrape have
fundamentally different per-iteration shapes (discovery walks a chain
via `resolveNext`; scrape does `extract` on a known URL). Merging them
would force `ScrapeService` to know about `nextButtonLocators`, which
breaks the existing invariant that `ScrapeService` is method-agnostic
(`grep job.method ScrapeService.ts` returns zero matches; this is a
deliberate boundary). Out of scope and worse than the proposed fix.

**Rejected alternative B - "extend the `BrowserPort` to add a
`gotoAndWaitOutChallenge` method on the port".** This would put
challenge-detection signatures into the port interface, which mixes
domain semantics (challenges are an app-layer concept) into the browser
abstraction. The existing design keeps `waitOutChallenge` in
`ChapterExtractor` (a core service) and call it through `PageHandle`;
that is the right layer. The fix proposed here stays in that layer.

**Rejected alternative C - "add a `SecurityChallengeError` retry loop
inside `ChapterListService.collectSequential` per-URL".** Discovery
walks a chain, not a fixed list, so retrying a single URL mid-walk just
re-hits the same fingerprint on the same context. The fix that actually
works is the full-relaunch retry in `discoverJobChapters`, because it
gets a new context + browser per attempt - matching the documented
fingerprint refresh behavior.

**Why reuse `ChapterExtractor.waitOutChallenge` instead of duplicating
the constants.** AGENTS.md mandates the three-tier ordering and the
2,000-char body-text length gate, and explicitly warns that the
challenge detection logic must not be silently diverged from the v1
baseline. `ChapterExtractor.detectChallenge` / `waitOutChallenge` are
the canonical, tested implementation (`tests/chapter-extractor.test.ts:174-196`
covers both DOM-marker and title-regex detection). Duplicating the
constants or the logic in `ChapterListService` would create a second
source of truth that could drift. Injecting the existing service is the
minimum-change fix that preserves the existing detection semantics
exactly.

**Why construct `ChapterExtractor` inside `discoverJobChapters` rather
than pass it as a dep.** `discoverJobChapters`'s caller (`runJob.ts:55`
and `ManualDiscoveryScreen.ts:44`) already constructs the browser and
log; adding a fourth arg for `ChapterExtractor` is more change at every
caller for no argument-injection benefit (the extractor has no state and
takes only a `Logger`). Constructing it internally matches the pattern
in `ScrapeService.run` (`ScrapeService.ts:67`: `const extractor = new
ChapterExtractor(this.deps.log, this.deps.siteAdapter)`).

### 3.7 Testing

There are currently NO tests for `discoverJobChapters` or
`ChapterListService` (grep `tests/` returns zero matches). The fix should
add the first tests for both, in the parity-test pattern AGENTS.md
specifies for new service code (`tests/epub-archiver.test.ts` /
`tests/session-store.test.ts` are the named patterns).

**Unit tests for `ChapterListService.collectSequential` challenge
wait-out** (`tests/chapter-list-service.test.ts` - new file, modeled on
`tests/chapter-extractor.test.ts:174-196`):

```ts
import { describe, it, expect } from "vitest";
import { ChapterListService } from "../src/core/services/ChapterListService.js";
import { ChapterExtractor } from "../src/core/services/ChapterExtractor.js";
import { SecurityChallengeError } from "../src/core/errors.js";
import { FakePage } from "../src/adapters/store-memory/FakeBrowserPort.js";
import { NoopUIAdapter } from "../src/adapters/ui-noop/NoopUIAdapter.js";

describe("ChapterListService.collectSequential - challenge handling", () => {
  it("throws SecurityChallengeError when the first page is a stuck challenge", async () => {
    const html = fs.readFileSync(path.join(__dirname, "fixtures", "chapter-challenge.html"), "utf8");
    const page = new FakePage(html);
    const extractor = new ChapterExtractor(makeLogger());
    const svc = new ChapterListService(makeLogger(), new NoopUIAdapter(), extractor);

    await expect(
      svc.collectSequential(
        page, "http://test/ch1", "http://test/ch3",
        [{ kind: "css", value: ".next" }], 10, 20, "domcontentloaded", 5_000,
      ),
    ).rejects.toThrow(SecurityChallengeError);
  });

  it("proceeds with the walk when the challenge clears within the wait-out window", async () => {
    // FakePage variant that swaps to a real chapter HTML after N locatorCount calls;
    // assert the returned URL list has length > 1 (i.e. the walk continued).
  });
});
```

Use the existing fixture `tests/fixtures/chapter-challenge.html` for the
stuck case (it already drives `detectChallenge` to `matched: true` in
`chapter-extractor.test.ts:175-186`). The "clears within window" case
needs a `FakePage` variant whose `locatorCount` / `bodyInnerText` flips
from challenge markers to empty after the first poll - that is a small
extension to `FakePage` (a `postPollHtml` field, or a call-counting
override). It is straightforward because `FakePage` is an in-memory mock.

**Behavioral test for `discoverJobChapters` retry loop** (same file):

```ts
import { describe, it, expect, vi } from "vitest";
import { discoverJobChapters } from "../src/core/services/DiscoveryService.js";
import { FakeBrowserPort } from "../src/adapters/store-memory/FakeBrowserPort.js";

describe("discoverJobChapters - challenge retry", () => {
  it("retries discovery up to DISCOVERY_MAX_RETRIES on a stuck challenge, then bubbles", async () => {
    const fakeBrowser = new FakeBrowserPort(/* scenario */);
    const job = makeSequentialJob({ firstChapterUrl: "http://test/ch1", ... });

    await expect(
      discoverJobChapters(job, { browser: fakeBrowser, cookies: [], ui, log }),
    ).rejects.toThrow(SecurityChallengeError);

    expect(fakeBrowser.launches).toBe(DISCOVERY_MAX_RETRIES + 0);  // attempted, never succeeded
  });

  it("returns the URL list on the second attempt if the first hits a stuck challenge that clears on retry", async () => {
    // scenario: first launch serves challenge HTML, second launch serves real chapters.
  });
});
```

The `FakeBrowserPort` already implements `PageHandle` (`store-memory/FakeBrowserPort.ts:18-141`)
and supports `locatorCount` / `bodyInnerText` / `title`, so a discovery
retry test is achievable without a real browser. The retry test must use
fake timers (`vi.useFakeTimers()`) to advance the 30-second poll and
45-second backoff without wall-clock waits; this is the existing pattern
the acceptance tests use (`tests/acceptance.test.ts` is gated on
`CLOAKBROWSER_BINARY_AVAILABLE=1` precisely so the unit test layer
doesn't have to wait real seconds).

**The `FakeBrowserPort` recording improvement from 2.5 is a
prerequisite.** `FakeBrowserPort.goto` currently discards its `_url`
(`store-memory/FakeBrowserPort.ts:25`); to assert "the discovery walk
re-tried the same `firstChapterUrl`", the test needs to inspect
`page.gotoCalls` (or `fakeBrowser.contexts[0].pages[0].gotoCalls`).
Without that recording improvement, the discovery retry tests can only
assert on the launch count and the eventual rejection, not on which URL
was attempted. Land 2.5 first, then this section's tests.

### 3.8 Migration / Compatibility

No data migration. No store schema change. No `JobConfig` shape change.
The fix is purely behavioral (discovery side-effect ordering). The user-
observable change is: discovery that previously failed silently with a
short/wrong URL list now waits up to ~30s + 3x45s for a Cloudflare
challenge to clear, mirroring the scrape phase's existing behavior. Users
on sites that never present a challenge see no change. Users on sites
that do present a transient challenge get the discovery to actually
succeed instead of returning garbage.

The `challenge.waiting` event during discovery is a new event on the
discovery code path, but the event type itself already exists in the
`ScrapeEvent` union (`core/services/events.ts`) - the same event fires
during the scrape phase. No new event type is invented; the UI adapter
already knows how to render it. The TUI side has to route it from the
discovery-specific UI adapter (ManualDiscoveryScreen's local
`ClackUIAdapter`) instead of from TaskScreen's, which is the
one-handler addition in 3.5.3. NoopUIAdapter already no-ops it.

### 3.9 Files Touched

| File | Change |
|------|--------|
| `src/core/services/ChapterListService.ts` | Add optional `extractor: ChapterExtractor` to constructor; call `extractor.waitOutChallenge(page)` after every `page.goto` in both `discoverTOC` and `collectSequential`; throw `SecurityChallengeError` on "stuck"; import `ChapterExtractor` + `SecurityChallengeError` |
| `src/core/services/DiscoveryService.ts` | Wrap the discovery body in a `while (true) { attempt++ }` loop; construct a `ChapterExtractor` internal to the function; on `SecurityChallengeError`, if `attempt <= DISCOVERY_MAX_RETRIES`, emit `challenge.waiting`, back off `attempt * 45_000ms`, relaunch a fresh browser and retry; else bubble |
| `src/adapters/ui-clack/screens/ManualDiscoveryScreen.ts` | Add a `ui.onEvent` handler for `challenge.waiting` that logs a warn row so the user sees the wait |
| `tests/chapter-list-service.test.ts` (new) | Add the first tests for `ChapterListService`: stuck-challenge throws `SecurityChallengeError`; cleared-challenge proceeds with walk |
| `tests/discovery-service.test.ts` (new) | Add the first tests for `discoverJobChapters`: retry-on-challenge behavior, eventual bubble after `DISCOVERY_MAX_RETRIES`, fresh-browser-per-attempt |
| `tests/fixtures/chapter-challenge.html` (unchanged) | Reused as-is; no new fixture needed for the stuck case (the clearing case needs a `FakePage` variant, not a new HTML fixture) |

### 3.10 Out-of-Scope For This Section

These were considered and excluded:

- **Auto-probe flow's challenge handling** (`AutoProbeScreen.ts:95-160`):
  The auto flow uses per-domain `SiteAdapter.scrapeChapterLinks` /
  `scrapeMetadata`, which call `page.goto` themselves and have no
  challenge wait. That is a parallel defect on a different code path
  (the user's report is specifically the manual sequential wizard).
  Fixing the auto-probe flow requires adding challenge wait-out to each
  site adapter's `scrapeChapterLinks`, which is a larger, scattergun
  change and out of scope for this sequential-discovery fix. The
  `ChapterExtractor.waitOutChallenge` seam introduced in 3.5.1 could
  be reused by individual site adapters later; the foundation is laid
  but the wiring is not.
- **Per-URL retry inside `ChapterListService.collectSequential`** rather
  than whole-discovery retry in `discoverJobChapters`. See 3.6 rejected
  alternative C.
- **Bumping `CHALLENGE_MAX_WAIT_MS` or `CHALLENGE_BACKOFF_MS`**.
  AGENTS.md mandates these constants are ported line-for-line from v1
  and that any change requires a deviation-log entry against the
  relevant phase design doc. The proposed fix reuses them as-is; no
  threshold tuning. If real-world Cloudflare flows need longer, that is
  a separate deviation task with its own evidence and ADR entry, not
  bundled into this fix.
- **Persisting a partial discovery result across the retry** so a 100-
  chapter walk does not have to restart from chapter 1 after a mid-walk
  challenge. That is a real enhancement (and would mirror
  `JsonSessionStore`'s scrape-phase checkpointing), but it requires a
  new partial-discovery persistence layer that does not exist today
  (`ChapterListService` is stateless and returns the full list at the
  end). Out of scope for fixing the immediate "browser closes without
  waiting" bug; the proposed whole-discovery retry is the minimum
  viable fix.

---

## 4. Out-of-Scope

These were considered and excluded:

- **Cookie auto-loading in CLI `run` path**: investigated, non-issue.
  The CLI `run` command takes `--cookies-file` per AGENTS.md / `runJob.ts:39`
  `opts.cookies ?? []`. The TUI auto-probe path (`AutoProbeScreen.ts`)
  attaches cookies via `scope.resolveCookiesForScrape`. Both paths
  work; no fix needed. (A separate enhancement - auto-loading cookies
  from the named-profile store in the CLI path, matching what the TUI
  does - was discussed but is a feature, not a fix, and is out of scope
  for this proposal.)
- **Phase 3 header/footer strips as a full region manager**: only the
  minimum needed to stop the banner reprint is proposed. A full
  region manager (scrolling log region with a persistent header
  painted separately, etc.) is a larger Phase 3 follow-up, not a fix.
- **`FakeBrowserPort.createContext` cookie recording**: mentioned in
  §2.5 because it is in the same file as the `goto` recording fix, but
  no test in this proposal actually asserts on it. Land it anyway if
  you are already touching the file - it is one extra array field and
  costs nothing.
