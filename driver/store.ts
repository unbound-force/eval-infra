/**
 * SQLite storage layer for eval run results.
 *
 * Uses bun:sqlite for synchronous, WAL-mode SQLite access.
 * The database is an artifact (not committed to git) — the
 * committed reference point is baseline.json.
 *
 * All queries use prepared statements per convention SC-004
 * (parameterized queries for external input).
 */

import { Database } from "bun:sqlite"

// ── Types ────────────────────────────────────────────────────

/** A single eval run record matching the runs table schema. */
export interface Run {
  run_id: string
  timestamp: string
  fingerprint: string
  repo: string
  git_sha: string | null
  git_branch: string | null
  command_name: string
  task_id: string
  task_version: string
  rubric_version: string
  profile_id: string
  model: string
  opencode_version: string
  exit_status: string
  error_message: string | null
  composite_score: number | null
  scores_json: string | null
  cost_usd: number | null
  duration_s: number | null
  turns: number | null
  tool_calls_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  diff_bytes: number | null
  workdir_diff: string | null
}

/** Baseline entry for a single fingerprint — latest known-good metrics. */
export interface BaselineEntry {
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  composite_score: number | null
  timestamp: string
  run_id: string
}

// ── Database initialization ──────────────────────────────────

/**
 * Initialize the SQLite database with the runs table schema.
 *
 * Creates the table and indexes if they don't exist. Enables
 * WAL journal mode for better concurrent read performance.
 *
 * @param dbPath - File path for the SQLite database.
 * @returns The initialized Database instance.
 */
export function initDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode = WAL")

  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id                TEXT PRIMARY KEY,
    timestamp             TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,
    repo                  TEXT NOT NULL,
    git_sha               TEXT,
    git_branch            TEXT,
    command_name          TEXT NOT NULL,
    task_id               TEXT NOT NULL,
    task_version          TEXT NOT NULL,
    rubric_version        TEXT NOT NULL,
    profile_id            TEXT NOT NULL DEFAULT 'baseline',
    model                 TEXT NOT NULL,
    opencode_version      TEXT NOT NULL,
    exit_status           TEXT NOT NULL,
    error_message         TEXT,
    composite_score       REAL,
    scores_json           TEXT,
    cost_usd              REAL,
    duration_s            REAL,
    turns                 INTEGER,
    tool_calls_count      INTEGER,
    input_tokens          INTEGER,
    output_tokens         INTEGER,
    cache_read_tokens     INTEGER,
    cache_creation_tokens INTEGER,
    diff_bytes            INTEGER,
    workdir_diff          TEXT,
    reasoning_tokens      INTEGER
  )`)

  // Databases created before reasoning_tokens existed lack the column
  const columns = db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === "reasoning_tokens")) {
    db.exec(`ALTER TABLE runs ADD COLUMN reasoning_tokens INTEGER`)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_fingerprint ON runs(fingerprint)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON runs(timestamp)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repo ON runs(repo)`)

  return db
}

// ── CRUD operations ──────────────────────────────────────────

/**
 * Insert a run record into the database.
 *
 * Uses a prepared statement with named parameters for safety
 * and performance (SC-004: parameterized queries).
 *
 * @param db - The initialized Database instance.
 * @param run - The run record to insert.
 */
export function insertRun(db: Database, run: Run): void {
  const stmt = db.prepare(`
    INSERT INTO runs (
      run_id, timestamp, fingerprint, repo, git_sha, git_branch,
      command_name, task_id, task_version, rubric_version, profile_id,
      model, opencode_version, exit_status, error_message,
      composite_score, scores_json, cost_usd, duration_s,
      turns, tool_calls_count, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, diff_bytes, workdir_diff,
      reasoning_tokens
    ) VALUES (
      $run_id, $timestamp, $fingerprint, $repo, $git_sha, $git_branch,
      $command_name, $task_id, $task_version, $rubric_version, $profile_id,
      $model, $opencode_version, $exit_status, $error_message,
      $composite_score, $scores_json, $cost_usd, $duration_s,
      $turns, $tool_calls_count, $input_tokens, $output_tokens,
      $cache_read_tokens, $cache_creation_tokens, $diff_bytes, $workdir_diff,
      $reasoning_tokens
    )
  `)
  // bun:sqlite named parameters require $ prefix on keys
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(run)) {
    params[`$${key}`] = value
  }
  stmt.run(params as any)
}

/**
 * Retrieve all runs matching a fingerprint, ordered by timestamp ascending.
 *
 * @param db - The initialized Database instance.
 * @param fp - The fingerprint hash to query.
 * @returns Array of matching Run records, oldest first.
 */
export function getRunsByFingerprint(db: Database, fp: string): Run[] {
  const stmt = db.prepare(
    `SELECT * FROM runs WHERE fingerprint = ? ORDER BY timestamp ASC`,
  )
  return stmt.all(fp) as Run[]
}

/**
 * Retrieve the most recent run for a given fingerprint.
 *
 * @param db - The initialized Database instance.
 * @param fp - The fingerprint hash to query.
 * @returns The latest Run record, or null if no runs exist for this fingerprint.
 */
export function getLatestRun(db: Database, fp: string): Run | null {
  const stmt = db.prepare(
    `SELECT * FROM runs WHERE fingerprint = ? ORDER BY timestamp DESC LIMIT 1`,
  )
  return (stmt.get(fp) as Run) ?? null
}

/**
 * Retrieve run history for a given fingerprint, ordered by timestamp descending.
 *
 * Used for drift analysis — comparing current runs against historical
 * trends to detect gradual cost/quality changes.
 *
 * @param db - The initialized Database instance.
 * @param fp - The fingerprint hash to query.
 * @param limit - Maximum number of runs to return (default: 10).
 * @returns Array of matching Run records, newest first.
 */
export function getRunHistory(
  db: Database,
  fp: string,
  limit = 10,
): Run[] {
  const stmt = db.prepare(
    `SELECT * FROM runs WHERE fingerprint = ? ORDER BY timestamp DESC LIMIT ?`,
  )
  return stmt.all(fp, limit) as Run[]
}

/**
 * Get all distinct fingerprints in the database.
 *
 * Used for listing all tracked eval scenarios for drift monitoring
 * and reporting.
 *
 * @param db - The initialized Database instance.
 * @returns Array of distinct fingerprint hash strings.
 */
export function getDistinctFingerprints(db: Database): string[] {
  const stmt = db.prepare(`SELECT DISTINCT fingerprint FROM runs`)
  const rows = stmt.all() as Array<{ fingerprint: string }>
  return rows.map((r) => r.fingerprint)
}

/**
 * Export baseline entries from the database — one entry per fingerprint,
 * using the latest run for each.
 *
 * @param db - The initialized Database instance.
 * @returns Map of fingerprint → BaselineEntry for the latest run of each fingerprint.
 */
export function exportBaseline(
  db: Database,
): Record<string, BaselineEntry> {
  // Use a window function to get the latest run per fingerprint
  const stmt = db.prepare(`
    SELECT * FROM runs
    WHERE rowid IN (
      SELECT rowid FROM runs r2
      WHERE r2.fingerprint = runs.fingerprint
      ORDER BY r2.timestamp DESC
      LIMIT 1
    )
    GROUP BY fingerprint
  `)
  const rows = stmt.all() as Run[]

  const baseline: Record<string, BaselineEntry> = {}
  for (const row of rows) {
    baseline[row.fingerprint] = {
      cost_usd: row.cost_usd,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      composite_score: row.composite_score,
      timestamp: row.timestamp,
      run_id: row.run_id,
    }
  }
  return baseline
}
