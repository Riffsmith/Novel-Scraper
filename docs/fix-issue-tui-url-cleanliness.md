# Fix Proposal: URL Double-Prefix Bug + TUI Cleanliness Pass

Status: proposal only. No business logic changed in this work. Every fix below is
described with handholding detail (exact files, line numbers, snippets, and tests)
so a follow-up commit can land it in one pass.

This doc covers two confirmed problems:

1. **URL double-prefix bug** in the "Log in via browser" cookie-capture flow
2. **TUI noise / cleanliness** - several screens overprint the log region on every
   loop iteration and the Shell never renders the header/footer strips the Phase 3
   design doc calls for

A third topic (cookies not used for metadata/chapter-link scraping) was investigated
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

---

## 3. Out-of-Scope

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
