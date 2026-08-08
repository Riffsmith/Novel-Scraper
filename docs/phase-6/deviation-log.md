# Phase 6 — Deviation Log

Reference design: `docs/phase-6/readme.md` (§1 Investigation, §2 Design, §3 Test plan).
This file lists every place the implementation diverged from that design, with
the reason and the consequence. Anything not listed here was implemented as
specified.

---

## D-P6-A — WTR-Lab / NovelFire live selector verification deferred to user

**Spec:** §2.4 Step 2 + §3 test plan item T6 — implementer fetches the live public
landing pages of a known WTR-Lab novel and a known NovelFire novel, asserts every
selector in `docs/02-site-adapters.md`'s metadata + chapter-list tables resolves to
non-empty content on the current DOM, and records "verified live on <date>" (or a
selector-change entry with the commit hash) here.

**Deviation:** The user elected to perform the live verification manually. The
implementer's contribution to Step 2 stops at collecting the selectors onto this
page; the verification checkboxes below are intentionally left unticked for the
user to fill in based on their own browser run.

**Reason:** User request during the Phase 6 implementation session: "Skip wtr-lab /
novelfire live selector verification. I will do that. Just when writing the docs,
leave space where I will just have to tick to confirm whether it's working or not.
If it's not working, I will write it in detail."

**Consequence:** Phase 6 ships with the adapter selectors unverified against the
live DOM. If a selector broke, the user will document it here (replace the empty
checkbox with a "BROKE — fixed in commit <hash>" entry that names the new
selector + the `docs/02-site-adapters.md` table update). The v2 adapters
(`src/adapters/site-wtr-lab/WtrLabAdapter.ts` + `src/adapters/site-novelfire/
NovelFireAdapter.ts`) are byte-faithful ports of the v1 adapters, so the selectors
in play are exactly the ones listed in `docs/02-site-adapters.md` §1.3 + §1.6
(WTR-Lab) and §2.3 + §2.5 (NovelFire).

### WTR-Lab (`https://wtr-lab.com`) — selectors to verify

Landing page (metadata):
- [ ] `h1.text-base` — title (fallback: `'Unknown Title'`)
- [ ] `p.text-xs` (first match) — author (fallback: `'Unknown'`)
- [ ] `.description` → `innerText` — synopsis (fallback: `''`)
- [ ] `img.relative` `src` — cover (prefix `https://wtr-lab.com` if relative)

TOC page (`?tab=toc`):
- [ ] `<button>` elements matching `/chapter|^\s*\d+\s*-\s*\d+\s*$/i` expand the
      chapter list in batches (click → 400ms wait → next)
- [ ] `a[href*="/chapter-"]` resolves once batches are expanded
- [ ] chapter URL pattern `chapter-(\d+)(?:[-.](\d+))?` recovers true order

Extraction default:
- [ ] `.chapter-content` — chapter body (the long-standing TODO in
      `docs/02-site-adapters.md` §1.6 is closed by this verification)

### NovelFire (`https://novelfire.net`) — selectors to verify

Landing page (metadata):
- [ ] `.novel-title` — title (fallback: `'Unknown Title'`)
- [ ] `.author` — author block; the `<a title="...">` attribute → nested
      `<span>` text → raw block text, in that fallback order
- [ ] `.content` → `innerText` (excludes `div.expand` so the synopsis-toggle
      label doesn't leak) — synopsis (fallback: `''`)
- [ ] `.cover > img:nth-child(1)` `src` → `data-src` (lazy-load fallback) — cover

TOC page (`<novelUrl>/chapters?page=N`):
- [ ] `.chapter-list` present; `a[href]` inside it resolves to chapter URLs
- [ ] `?page=N` paginates ~100/page; an out-of-range page either has no
      `.chapter-list`, an empty one, or wraps back to page 1 (caught by the
      first-link-repeats check)
- [ ] hard cap at `MAX_TOC_PAGES = 300`

Extraction defaults:
- [ ] `#content` — chapter body
- [ ] `.chapter-title` — separate chapter title (used because
      `defaultSeparateTitle: true`)

### User-filled section

> If a selector broke, document the fix below this line. If all selectors
> resolved, tick the boxes above and write "verified live on <date>" here.

_(user to fill in)_

---

## D-P6-B — Logger factory landed as designed (ADR-P6-B confirmed)

**Spec:** §2.2 Step 0 — add `createDefaultWinstonLogger()` factory to
`src/adapters/logger-winston/WinstonLogger.ts`, port the winston config from
`src/logger/index.ts:54-97`, rewrite the 7 v2 callers + 1 acceptance test, delete
`src/logger/index.ts`, write ADR-P6-B.

**Deviation:** None; this is a confirmation entry. The factory-port landed
exactly as designed: the winston-level / transports / `exceptionHandlers` /
`rejectionHandlers` / `LOG_LEVEL` env read / `chalk` pretty-print / `logs/` mkdir
move verbatim into `WinstonLogger.ts:83-131`. The 7 v2 callers + the acceptance
test swap from `createWinstonLogger(logger)` to `createDefaultWinstonLogger()` and
drop the `import logger from "../logger/index.js"` line. `src/logger/index.ts`
is deleted. `cli.ts:199`'s `try/catch` around `cli.parse(argv)` stays correct
because the handlers register at factory-call time (inside each command handler,
after `cli.parse`), not at import time.

**Reason:** Logged as an entry because ADR-P6-B is the load-bearing decision of
this phase: the singleton import is gone, the winston config survives in the
adapter layer, and the `Logger` port stays the only thing `core/` imports.

**Consequence:** The `rg "from ['\"]../logger|from ['\"]./logger"` sweep
(Step 5 §2.7) returns zero hits repo-wide. The structural assertion in
`tests/phase-6-sweep.test.ts` keeps the v1 logger import from reappearing.

---

## D-P6-C — `slugify` removed alongside the v1-only deps

**Spec:** §2.6 Step 4 + §1.3 read: "Keep: `chalk` ..., `sanitize-html`,
`slugify`, `uuid`, ...". The readme explicitly lists `slugify` as a keep.

**Deviation:** The implementer's runtime-usage audit before the package.json
edit (`rg -n "slugify" src/`) returned zero hits in any v2 file. The package was
a v1-only dep — it lived in `src/epub/builder.ts` (v1) and was not ported to
`src/adapters/epub-archiver/ArchiverEpubWriter.ts` (which uses `uuid` for the
EPUB-identifier and lets `archiver` handle filename safety). It is removed from
`package.json` `dependencies` along with `enquirer`, `cli-progress`, `playwright`,
`ora`, and `@types/cli-progress`.

**Reason:** AGENTS.md "Implementation Scope" rule: "Do not add features beyond
what was asked. Do not add abstractions for single-use code." The inverse applies
here: keep a dep in the manifest only if something imports it. Keeping `slugify`
as an unused dep would violate the spirit of Step 4's "remove deps only v1
needed" instruction, even though the readme's predicted keep-list was wrong.

**Consequence:** `pnpm install` prunes 20 packages (six deps + their transitive
trees: `enquirer`, `cli-progress`, `playwright`, `ora`, `slugify`,
`@types/cli-progress`). Zero v2 files imported `slugify`, so typecheck + lint +
test stay green. `tests/phase-6-sweep.test.ts` codifies the removal so a future
contributor can't re-add it without a test failure.

---

## D-P6-D — `tests/phase-6-sweep.test.ts` created (was optional in the design)

**Spec:** §3 test plan T5 note + §2.7 Step 5 item 4: "Optionally create
`tests/phase-6-sweep.test.ts` codifying T5 + T8 (the structural assertions) so
a future contributor can't regress them." The readme treats the file as
optional.

**Deviation:** The file is created and is not optional — the post-deletion
AGENTS.md (Step 1 update) references it as a load-bearing structural assertion:
"if a new `playwright` import appears, the `tests/phase-6-sweep.test.ts`
structural assertion fails." The readme's "optionally" framing is superseded by
the AGENTS.md contract.

**Reason:** AGENTS.md is the repo's hard-rule document. It already (before this
phase) treated `tests/phase-6-sweep.test.ts` as existing. Shipping the file
makes the documented claim true; leaving it out would let a future contributor
re-add a banned dep or a v1 logger import with no test failing.

**Consequence:** `pnpm test` now runs 27 additional assertion checks
(`T5 — ADR-001 repo-wide`, `T5 — v1 logger path deleted`, `T5 — v1 source tree
physically deleted`, `T8 — package.json has no v1-only deps/scripts`, `T7 —
Phase 6 docs exist and are non-empty`). Test count rises from 117 to 144.
