# 04 — Implementation Roadmap

This roadmap takes the project from the current v1.0.0 (7,123 LOC, see `00-current-state-audit.md`)
to a fully-featured v2.0 **with parity in every user-visible capability**, then stops.
Anything listed in "Post-parity backlog" is explicitly out of scope for v2.0.

**Rules every phase must follow**
1. `pnpm build` and `pnpm test` are green at the end of the phase.
2. A phase is not complete until every "Acceptance" bullet is demonstrably true.
3. Feature-parity mapping comes from `00-current-state-audit.md` — nothing on that list may be
   regressed without an ADR.
4. All user data from v1 remains readable (see `05-migration-guide.md`).

---

## Phase 0 — Foundation and scaffolding

**Goal:** new repository layout; no user-visible change.

**Scope**
- Create `src/core/`, `src/ports/`, `src/adapters/`, `src/app/` per ADR-003.
- Set up `vitest` (+ `@vitest/coverage-v8`), TS `strict: true`, ESLint flat config.
- Delete the 12 stray brace-directories in `src/`.
- Merge `.env.example` hints into `config.yaml.example`.
- Add `pnpm typecheck`, `pnpm lint`, `pnpm test` scripts; keep `pnpm dev`, `pnpm build`, `pnpm start`.
- Add `AGENTS.md` skeleton (updated at Phase 6).

**Acceptance**
- `pnpm i && pnpm typecheck && pnpm lint && pnpm test` pass.
- Old code remains **untouched** — this phase only adds the new skeleton.
- A `core/domain/Chapter.ts` file exists and compiles.

**Parity delivered:** none yet (deliberate).

---

## Phase 1 — Headless core engine

**Goal:** the scrape pipeline runs end-to-end without any TUI, driven by a YAML job file.

**Scope**
- Port domain types: `JobConfig`, `Chapter`, `NovelMetadata`, `Session` into `core/domain/`.
- Implement `ports/`: `BrowserPort`, `CookieStore`, `ProfileStore`, `SessionStore`, `EpubWriter`, `UIAdapter`.
- Port (with tests) `scraper/selectors.ts` → `core/services/SelectorService.ts`.
- Port `scraper/chapter.ts`, `scraper/toc.ts`, `scraper/sequential.ts`, and the queue to
  `core/services/ScrapeService.ts`, with progress emitted as **events**, not console writes.
- Implement `adapters/browser-playwright/` (playwright-core + CloakBrowser launch —
  per ADR-001 — with the `evaluate`-as-string constraint documented in the port's docstring).
- Implement `adapters/store-json/` for SessionStore only (Phase 2 adds the rest).
- Implement `adapters/epub-archiver/` (move `builder.ts` + `templates.ts` without editing EPUB XML).
- Provide `app/runJob.ts` — takes a parsed `JobConfig`, returns `ScrapeResult`.

**Tests**
- SelectorService: CSS and XPath resolution, exclusion removal, regex anchor finder (happy path + non-match).
- ScrapeService: a full scrape of a static fixture site served by a local HTTP server (no real network).
- Resume: interrupt a queue mid-run, restart, verify no completed chapter is re-requested and
  EPUB chapter order is unchanged.
- Anti-bot challenge: fixture page sets `<title>Just a moment…</title>` then clears; service waits.

**Acceptance**
- `wnscrape run --job fixtures/job.yaml` (CLI wired directly to `runJob`) produces a valid EPUB
  for a local fixture > 50 chapters.
- A crashed run resumes from its `sessions/*.json` checkpoint and skips already-done chapters.
- Progress events flow through `UIAdapter` into a no-op listener in tests.

**Parity delivered:** `scraper/*`, `queue/*`, `epub/*`, `sessions/*`.

---

## Phase 2 — Persistence and configuration

**Goal:** all user data stores are safe, versioned, and readable from the new architecture.

**Scope**
- `adapters/config-yaml/`: load `config.yaml`, migrate `config.json` on first run (unknown keys preserved).
- `zod` schemas for `AppConfig`, `JobConfig`, `CookieProfile`, `SiteProfile`, `Session`.
- `adapters/store-json/` now implements **CookieStore**, **ProfileStore**, and **SessionStore**
  with `schemaVersion` stamps.
- Transparent migration of legacy flat-array cookies (`cookies/store.ts` historical format).
- Unit tests: load every fixture produced by v1 stores; write → re-read round-trips.

**Acceptance**
- Running v2 against a v1 data directory upgrades it in place without losing cookies/profiles/sessions.
- `wnscrape doctor` validates binary path, config schema, store permissions and reports pass/fail.

**Parity delivered:** `config/*`, `cookies/store.ts`, `sessions/store.ts`, `siteProfiles.ts`.

---

## Phase 3 — TUI shell (non-scraping parts)

**Goal:** new Clack-based UI covers every management screen of v1.

**Scope**
- Implement `adapters/ui-clack/` with the `Screen`/`ShellContext` contract from `03-tui-design.md`.
- `MainScreen`, `ResumeScreen`, `CookieManagerScreen`, `SettingsScreen`, `LibraryScreen`, `ErrorScreen`.
- Cookie login capture flow driving the browser adapter's ephemeral instance.
- Global graceful-quit handler (`Ctrl+Q` / `Ctrl+C` / uncaught exception), wired to SessionStore flush.
- Replace Enquirer entirely; delete `tui/keys.ts` patch.

**Tests**
- Snapshot tests for screen layout at 80×24.
- Headless simulation: cookie CRUD via a scripted UI adapter.

**Acceptance**
- A user can list domains, add/edit/delete cookie profiles, run a browser login capture, and
  manage site profiles — without touching any scraping flow.
- Escape/Ctrl+C behavior matches `03-tui-design.md` §5 on every screen.

**Parity delivered:** `tui/cookieManager.ts`, `tui/configManager.ts`, `tui/sessionManager.ts`.

---

## Phase 4 — Scraping flows in the TUI

**Goal:** full feature-parity for starting, customizing, running, and reviewing a scrape.

**Scope**
- `NewScrapeScreen` (Auto vs Manual entry).
- `ManualWizardScreen` — Clack `group()`s replacing the 23-step `gatherConfig`.
- `AutoProbeScreen` + `AutoCustomizeScreen` — port both adapter flows.
- `ChapterListScreen` — table action loop (proceed / remove / add / reverse / view).
- `TaskScreen` — live progress (`TaskRegistry`-driven), `q` to cancel & checkpoint.
- Post-scrape: summary card + optional profile-save prompt honoring `askSaveProfile`.

**Tests**
- Scripted walkthroughs of both wizard paths ending in a successful `runJob` invocation.
- Chapter list editing (remove range, reverse, add).

**Acceptance**
- All three v1 entry paths (manual, auto fast path, auto with customization) work end-to-end.
- A long scrape shows continuous progress without corrupting log lines.
- Confirming "save profile" writes a v2 profile; decline leaves the store untouched.

**Parity delivered:** `tui/prompts.ts`, `index.ts` remaining flows.

---

## Phase 5 — CLI & automation

**Goal:** full non-interactive control for scripting and CI.

**Scope**
- `cac` wiring in `app/cli.ts` for: `run`, `resume`, `cookies ls`, `cookies add --file`,
  `config get/set`, `profiles ls`, `doctor`.
- `--json` on every read-only command.
- Job-file schema published at `schemas/job.schema.json` (generated from the `zod` schema).

**Acceptance**
- Everything achievable in the TUI is achievable via CLI without prompts.
- JSON output validates against a stable schema (no chalk codes).
- CI job runs `wnscrape run --job fixtures/job.yaml --json` and asserts on exit code + EPUB hash.

**Parity delivered:** none (all new).

---

## Phase 6 — Polish, docs, and benchmarks

**Goal:** close the documentation gap and demonstrate the performance goal.

**Scope**
- Rewrite `README.md` for v2 usage (TUI + CLI + jobs).
- Write `AGENTS.md`, `CONTRIBUTING.md`, `docs/sites/adding-a-site.md`.
- `scripts/benchmark.ts`: measures chapters/minute and peak RSS for a 200-chapter fixture at
  concurrency 1, 2, 4 — compares v1.0.0 baseline against v2.
- Verify WTR-Lab `.chapter-content` TODO from `docs/02-site-adapters.md` §1.6 against a live page.
- Final sweep: no `playwright` imports, only `playwright-core`.

**Acceptance**
- Benchmarks committed as `docs/benchmarks/v2.0.0.md`, showing **≥ v1 speed at equal concurrency**
  (or a recorded ADR explaining any regression).
- Site adapters' metadata selectors all resolve on their live public landing pages.

---

## Post-parity backlog (v2.x, explicitly not v2.0)

- Web/Dashboard UI adapter (`adapters/ui-web/`).
- EPUB theme packs.
- OPDS feed of generated EPUBs.
- Cloud sync of session checkpoints.
- Additional site adapters (RoyalRoad, ScribbleHub, Wuxiaworld).
- Manga page-image mode.

---

## Traceability quick-reference

| Roadmap phase | Audit sections (from 00) it must not regress |
|---------------|----------------------------------------------|
| 1 | Scraping engine, Browser & stealth, Concurrency, EPUB output, Resumability |
| 2 | Config & profiles, Cookies, Session schemas |
| 3 | Cookies UI, Config UI, Resume picker UI |
| 4 | Entry flows, Chapter-list review, Progress bar, Profile-save prompt |
| 5 | (new capability — no parity risk) |
| 6 | Docs |
