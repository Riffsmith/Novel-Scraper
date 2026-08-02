# 03 — TUI Design Specification (v2)

Goal: build an interface that is as **discoverable as the current menu system**, but as
**resilient and predictable as opencode's** — without inheriting Enquirer's fragility or the
complexity of a full Ink application.

Technology: **`@clack/prompts`** (see ADR-002).

---

## 1. Design principles

1. **One shell, many screens.** Nothing clears the terminal except intentional screen transitions.
   A persistent header and footer anchor the user; only the body region changes.
2. **Tasks, not blocking flows.** Starting a scrape creates a cancellable *Task* that owns the
   body region until done. The menu remains aware of it (`Resume`, `[1 running]`).
3. **Every prompt is safe.** `@clack/prompts`'s `isCancel()` is the only "go back" primitive.
   No prototype patching, no global key hooks, no hand-copied combo maps.
4. **Two ways to do everything.** Menus for discoverability, `:` commands for speed
   (`:new`, `:resume`, `:cookies`, `:settings`, `:quit`).
5. **Log lines never corrupt the UI.** A fixed log region above the header receives progress
   lines; the body below never scrolls.

---

## 2. Screen inventory

| Screen | Purpose | Replaces |
|--------|---------|----------|
| `MainScreen` | Top-level menu | `index.ts:mainMenu()` |
| `NewScrapeScreen` | Auto vs Manual entry, entry-URL prompt | `index.ts` lines 162-182 |
| `ManualWizardScreen` | All manual scrape questions | `tui/prompts.ts:gatherConfig` |
| `AutoProbeScreen` | Show adapter-detected metadata/chapter count; confirm fast path | `index.ts:719-746` |
| `AutoCustomizeScreen` | Full pre-flight review/edit | `tui/prompts.ts:gatherAutoConfig` |
| `ChapterListScreen` | Review/edit discovered chapter URLs | `tui/prompts.ts:editChapterLinks` |
| `TaskScreen` | Live progress, chapter count, current file; `q` to quit & checkpoint | progress-bar section in `queue/index.ts` |
| `ResumeScreen` | Pick/checkpoint/delete/resume sessions | `tui/sessionManager.ts` |
| `CookieManagerScreen` | Domain → profile → cookie CRUD + browser capture | `tui/cookieManager.ts` |
| `SettingsScreen` | Edit `config.yaml`, manage site profiles | `tui/configManager.ts` |
| `LibraryScreen` | List generated EPUBs under output dir, open/cleanup | **new** |
| `ErrorScreen` | Readable errors + link to `logs/` | `tui/errors.ts` |

---

## 3. Layout and chrome

```
┌  WebNovel Scraper ──────────────────────────────────────────┐
│  📖 task: Shadow Slave — 1,203/2,500 ch · 48 % · ETA 12 m  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   (current screen body)                                     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  output: ./output · logs: ./logs · : commands · Ctrl+Q quit │
└─────────────────────────────────────────────────────────────┘
```

- **Header** shows a one-line summary of the active task; `task: idle` when nothing is running.
- **Body** is a Clack prompt group or a screen-rendered view (cookie table, settings form, …).
- **Footer** is rebuilt with every screen to keep the hint text current.
- **Log region** sits *above* the header; it is plain stdout, so Winston console transport and
  Clack never fight over rendering the same lines.

---

## 4. Interaction model

### 4.1 Main menu

```text
◆  What do you want to do?
│  ● 📖 Start a new scrape
│  ○ ⏵  Resume (2 sessions)
│  ○ 📚 Library
│  ○ 🍪 Cookies
│  ○ ⚙️  Settings & profiles
│  ○ ✖  Quit
└
```

Keys other than arrows/enter are handled by Clack. A bare `:` on any menu/list screen switches to
command mode; hitting Esc twice in nested prompts returns to this screen.

### 4.2 Manual wizard

Instead of today's 23-step linear wizard (`prompts.ts`), the manual flow is a **grouped Clack group()**:

```text
◆  Source
│  ◇ Method
│  ◇ TOC URL
│
◆  Extraction
│  ◇ Content selector (required)
│  ◇ Separate title? [y/N]
│  ◇ Exclusions (comma separated)
│
◆  Metadata
│  ◇ Title / Author / Language / Publisher
│  ◇ Synopsis (multi-line)
│  ◇ Cover: none | url | file
│
◆  Output & performance
│  ◇ Output dir / Filename
│  ◇ Concurrency [2]  Delay range [1200-3500 ms]
│
◆  Review and confirm?
```

Each top-level section is a Clack group; Escape moves to the previous section, not the previous
single question. This removes the "23 backspaces to fix the method" problem without making the
flow non-linear.

### 4.3 Auto-scrape flow

1. `AutoProbeScreen` shows:
   - Site label, title, author, chapter count, first/last link, cover found?
   - An explicit "Content selector" line — **fast path's most important single line.**
2. Confirmations (as today, max 2):
   - *Use these settings and continue?*
   - *Start scraping N chapters now?*
3. If the user declines #1, go to `AutoCustomizeScreen` (Clack group identical to the manual
   wizard but pre-filled from adapter + profile).

### 4.4 Task screen

```text
◆  Scraping — Shadow Slave
│  ████████████████████░░░░░░░░░░░░░░  1,203/2,500 chapters (48 %)
│  Current: ch. 1,203 — https://…
│  Errors: 2 · Retries: 17 · Elapsed: 04:31 · ETA: 05:12
│
│  q: quit & save session · Ctrl+C: same
└
```

- Progress bar is drawn by Clack's `spinner` only for indeterminate phases; queue progress uses
  a custom `progress` renderable (not `cli-progress`), so it composes with the shell.
- After completion the Task screen hands control back to MainScreen showing the summary card.

### 4.5 Chapter-list review

This is **not** a Clack prompt group; it is a table action loop:

```
┌ Chapter list review ─ 2,500 chapters ────────┐
│   1. https://…/chapter-1                      │
│   …                                           │
│  2,500. https://…/chapter-2500                │
├──────────────────────────────────────────────┤
│ [p]roceed · [r]emove · [a]dd · [rev]erse ·  │
│ [v]iew all · Esc: back                        │
└──────────────────────────────────────────────┘
```

- `[r]` accepts `5`, `10-20`, `5, 10-20, 99` (existing `parseRanges` from `prompts.ts:1279`).
- `[rev]` is kept, with a confirm: chapter order is almost always intentional.

---

## 5. Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `↑` / `↓` / `Enter` | any Clask select/confirm | default |
| `Esc` | any prompt group | previous group, then previous screen |
| `Ctrl+Q` / `Ctrl+C` | anywhere | graceful quit (flush session, close browsers) |
| `q` | TaskScreen | graceful quit (same handler as Ctrl+Q) |
| `:` | Main / menu screens | open command palette |
| `Tab` | multi-line input (synopsis) | submit paragraph |

No keybinding may rely on patching a library prototype; any combination that needs a custom
listener is implemented at the screen level (TaskScreen), not globally.

---

## 6. Component contract

**Screen interface (adapters/ui-clack):**

```ts
interface Screen {
  readonly id: string;
  render(ctx: ShellContext): Promise<ScreenResult>;
}

interface ShellContext {
  config: AppConfig;
  cookies: CookieService;
  tasks: TaskRegistry;
  navigate(to: string, params?: unknown): void;
}

type ScreenResult =
  | { action: 'push'; screen: string; params?: unknown }
  | { action: 'pop' }
  | { action: 'replace'; screen: string }
  | { action: 'quit' };
```

**Task contract:**

```ts
interface ScrapeTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  progress: { done: number; total: number };
  cancel(): Promise<void>;
}
```

The core engine emits progress events to `TaskRegistry`; Clack subscribes. This prevents today's
tight coupling where the progress bar is created directly inside `queue/index.ts`.

---

## 7. What we are intentionally not copying from opencode

| opencode pattern | Why not for a scraper |
|------------------|----------------------|
| Full Ink / React tree | Extra runtime + JSX build; no streaming chat to reconcile. |
| Leader-key | Overkill for one command prefix (`:` is enough). |
| Toast stack | Clack's `log.*` API covers the need without overlap semantics. |
| Worker thread for UI | Scraping is I/O-bound; a single process is easier to persist and quit cleanly. |

---

## 8. Accessibility / portability checklist

- Fixed-width tags (`[INFO]`, `[WARN]`) instead of emoji-only status columns.
- Colors must degrade to readable defaults in `NO_COLOR` and 8-color terms.
- All tables must render correctly at 80 columns.
- Every interactive screen must have a non-interactive CLI equivalent (ADR-005) so CI and screen
  readers can drive the whole product.
