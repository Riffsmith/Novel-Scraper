# 05 — Migration Guide (v1 → v2)

This guide defines how the v2 rewrite preserves **every byte of user data** produced by the
current v1 builds. The goal is that a user can install v2 over their existing install and
continue exactly where they left off, with **zero manual steps**.

If a migration ever fails, the v1 file is left untouched and a clear error is written to
`logs/error.log`.

---

## 1. File map

| v1 path | v2 path | Action |
|---------|---------|--------|
| `~/.config/webnovel-scraper/config.json` | `~/.config/webnovel-scraper/config.yaml` | **Auto-migrated** on first v2 run; old file kept as `config.json.bak`. |
| `~/.local/share/webnovel-scraper/cookies.json` | same | **Format unchanged.** v2 adds `schemaVersion: 2` inside the file only. |
| `~/.local/share/webnovel-scraper/site-profiles.json` | same | **Format unchanged**; new fields default on read. |
| `~/.local/share/webnovel-scraper/sessions/*.json` | same | v2 adds `schemaVersion`; old sessions remain resumable. |
| `./logs/*.log` | `./logs/*.log` | Kept as-is; v2 appends to the same files. |
| `./output/*.epub` | `./output/*.epub` | Untouched. Library screen reads them. |
| `jobs/*.yaml` | `jobs/*.yaml` | New in v2 — no migration needed. |

> XDG equivalents on macOS (`~/Library/Application Support/webnovel-scraper/`) and Windows
> (`%APPDATA%/webnovel-scraper/`) follow identical rules. Paths come from the existing
> `resolveDataDir()` / `resolveConfigDir()` logic — v2 reuses the same resolution order.

---

## 2. Config migration (`config.json` → `config.yaml`)

Performed automatically by `adapters/config-yaml/` on first launch:

1. Read `~/.config/webnovel-scraper/config.json` (fall back to defaults if unreadable).
2. Merge onto `DEFAULT_CONFIG` (same merge rule as v1's `readConfig`).
3. Write `config.yaml` with **every key present**, commented with its purpose.
4. Preserve unknown keys — v1's `writeConfig` behavior is retained so third-party edits survive.
5. Rename original to `config.json.bak`.

### Example output

```yaml
# ── Output ────────────────────────────────────────────────
defaultOutputDir: ./output

# ── Performance ───────────────────────────────────────────
defaultConcurrency: 2
defaultDelayMin: 1200
defaultDelayMax: 3500

# ── Browser ───────────────────────────────────────────────
headless: true
waitUntil: domcontentloaded  # domcontentloaded | load | networkidle
navigationTimeoutMs: 30000

# ── Stealth (CloakBrowser) ────────────────────────────────
humanize: false
humanPreset: default           # default | careful
fingerprintSeed: null          # null = random every launch

# ── Scraping ──────────────────────────────────────────────
maxRetries: 3

# ── Metadata defaults ─────────────────────────────────────
defaultLanguage: en
defaultAuthor: Unknown
defaultPublisher: WebNovel Scraper

# ── Logging ───────────────────────────────────────────────
logLevel: info                 # error | warn | info | debug

# ── UX ────────────────────────────────────────────────────
askSaveProfile: true
```

**Rollback:** delete `config.yaml`, rename `config.json.bak` back to `config.json`, run v1 build.
v1 remains fully supported side-by-side.

---

## 3. Cookie store migration

The store format already uses **named profiles keyed by domain** (see
`src/cookies/store.ts:80`), so no shape change is required.

v2 makes only two non-breaking additions:

- Top-level `schemaVersion: 2` field.
- Optional `notes` field on `CookieProfile`.

Legacy pre-profile files (flat arrays of cookies) are still readable; v1's migration logic is
ported as-is.

**Guarantees**
- All domains, profiles, cookies, `lastUsedAt`, and labels are preserved.
- Browser-login capture continues to work through the same ephemeral-browser port.

---

## 4. Site profile migration

`site-profiles.json` is a flat `Record<domain, SiteProfile>` (`src/types.ts:60-77`).

v2 additions (all optional, defaulted on read):
- `schemaVersion`.
- `lastUsedAt` (mirrors cookie profiles for consistency).

No action needed; existing profiles pre-fill the new TUI unchanged.

---

## 5. Session checkpoint migration

Sessions (`~/.local/share/webnovel-scraper/sessions/*.json`) are forward-compatible:

- v2 reads both v1 shape and v2 shape (with `schemaVersion`).
- `entryUrl`, `chapterUrls`, `completedChapters`, `config` are untouched — resumes work.
- Deletion rule unchanged: session file is removed only when its EPUB has been built.

> **Test fixture:** Phase 2's test suite includes real v1 session files and asserts
> `listSessions()` returns identical progress counts after upgrade.

---

## 6. Logs and output

- `logs/combined.log`, `logs/error.log`, `logs/exceptions.log`, `logs/rejections.log` continue to
  be appended to; v2 adds structured fields but keeps the same transport layout.
- `output/*.epub` are never modified or renamed.
- New `jobs/` directory (default `./jobs`) is created on demand; v1 has no equivalent, so nothing
  needs to move.

---

## 7. CLI/API compatibility

| v1 surface | v2 equivalent |
|------------|----------------|
| `node dist/index.js` | `wnscrape` (TUI default) |
| `pnpm dev` | `pnpm dev` (now runs TS directly through tsx — unchanged) |
| `pnpm build && pnpm start` | same |
| _(no CLI flags in v1)_ | `wnscrape run|resume|cookies|config|doctor` — all new, non-breaking |

Environment variables `LOG_LEVEL` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME` are honored identically.

---

## 8. What you should double-check after first v2 run

1. `~/.config/webnovel-scraper/config.yaml` exists and reflects your `config.json` values.
2. `~/.config/webnovel-scraper/config.json.bak` still exists.
3. Cookie Manager in the TUI lists every domain and profile you had before.
4. `wnscrape doctor` reports all green.

If any of these fail, restore `config.json.bak` and file an issue with the last 50 lines of
`logs/error.log`.

---

## 9. For contributors

Every store module must implement:

```ts
interface StoreMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(raw: unknown): unknown;
}
```

Phase 2 will land exactly one migration per store (v1 → v2). Each new schema bump adds another
migration to the chain, never an in-place rewrite. This is what makes rollback safe at every step.
