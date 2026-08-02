# AGENTS.md

## Project
WebNovel Scraper — TUI/CLI web-novel scraper producing EPUB 3 output. Currently mid-migration
from v1 (monolith in `src/index.ts`) to v2 (hexagonal: `core` / `ports` / `adapters` / `app`).
See `docs/04-implementation-roadmap.md` for phases, `docs/phase-*/` for per-phase designs.

## Commands
- `pnpm dev` — run v1 TUI via tsx
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — vitest run (tests live in `tests/`)
- `pnpm build` — `tsc` → `dist/`

## Layout rules (v2, ADR-003)
- `src/core/` — pure domain; imports nothing from `adapters/`, playwright, or fs.
- `src/ports/` — interfaces only.
- `src/adapters/` — one directory per adapter (`browser-playwright`, `store-json`, …).
- `src/app/` — composition root (`runJob.ts`, `cli.ts`).
- v1 code in `src/scraper|queue|epub|sessions|tui` stays **untouched** until Phase 6 —
  it is the reference oracle for parity tests.

## Hard constraints
- New code must depend on `playwright-core`, never `playwright`.
- Any script sent to the browser must be an **evaluate-as-string** (tsx/esbuild wraps closures
  with `__name()`, which does not exist in browser scope — audit P4). `PageHandle` therefore
  exposes only named methods; there is no generic `evaluate()`.
- Session files are deleted only after the EPUB build succeeds.
