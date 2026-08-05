// ─────────────────────────────────────────────────────────────────────────────
//  Migration chain mechanism (phase-2 §2.2 / migration-guide §9).
//
//  Each store has one `StoreMigration` per schema bump. Migrations are
//  applied in order, never in-place: the runner takes the raw parsed JSON
//  and walks from its detected schemaVersion up to the *target* (always the
//  app's current schemaVersion constant). A store file *newer* than the app
//  is a hard error - never a silent passthrough.
//
//  Rules (phase-2 §2.2):
//   1. Read never mutates the file. Migrations produce an in-memory value;
//      the file is only re-written (stamped) on the next genuine write, or
//      by an explicit `doctor --fix`. EXCEPTION: the legacy cookie-array
//      wrap keeps v1's write-immediately behavior (cookies/store.ts:131-136)
//      because migration-guide §3 already promised users that's what
//      happens - changing it would make the guide a liar.
//   2. A store newer than the app is a hard error with version numbers in
//      the message. v1 ignores unknown keys, so v2-stamped files ARE
//      v1-readable; that side-by-side guarantee only holds because every v2
//      addition is additive-optional.
//   3. Unknown keys preserved everywhere - same semantics as v1's
//      writeConfig. The schema's `.passthrough()` enforces this; the
//      migration chain therefore preserves those keys unchanged across a
//      step.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(raw: unknown): unknown;
}

export interface MigrationResult {
  /** Migrated data, structurally identical to `raw` if no migration needed. */
  data: unknown;
  /** Original schemaVersion before any migration, or null if already current. */
  migratedFrom: number | null;
  /** Final schemaVersion after the chain (== target when chain completes). */
  version: number;
}

/**
 * Detect the schemaVersion of a raw parsed store document.
 * Absent `schemaVersion` is implicit v1.
 */
export function detectStoreVersion(raw: unknown): number {
  if (raw && typeof raw === "object" && "schemaVersion" in raw) {
    const v = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 1;
}

/**
 * Run a migration chain from the document's current schemaVersion up to
 * `target`. Returns the (possibly-migrated) data plus a `migratedFrom`
 * null/non-null indicator for telemetry / logging.
 *
 * Behaviour:
 *   - If `version === target`, returns the raw value untouched.
 *   - Otherwise, applies migrations whose `fromVersion === version` in
 *     order; throws if a needed migration is missing or if the document is
 *     from a NEWER schemaVersion than the app's target.
 */
export function runMigrations(
  rawOnEntry: unknown,
  chain: readonly StoreMigration[],
  target: number,
): MigrationResult {
  let raw = rawOnEntry;
  let version = detectStoreVersion(raw);
  const from = version === target ? null : version;

  // Newer-than-app is a hard error (§2.2 rule 2).
  if (version > target) {
    throw new Error(
      `store schemaVersion ${version} is newer than app target ${target}; ` +
        `downgrade the data file or upgrade the app`,
    );
  }

  // Walk forward one migration at a time until we reach the target.
  while (version < target) {
    const step = chain.find((m) => m.fromVersion === version);
    if (!step) {
      throw new Error(
        `no migration registered from schemaVersion ${version} (target ${target})`,
      );
    }
    raw = step.migrate(raw);
    version = step.toVersion;
    if (version > target) {
      // Defensive: a chain step that overshoots target is a programmer error.
      throw new Error(
        `migration overshot: ${step.fromVersion} -> ${step.toVersion} > target ${target}`,
      );
    }
  }

  return { data: raw, migratedFrom: from, version };
}
