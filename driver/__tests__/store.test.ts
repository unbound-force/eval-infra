/**
 * Unit tests for store.ts schema migration.
 *
 * eval.db files outlive driver versions (CI artifacts, local runs), so
 * initDb() must add columns introduced after a database was created.
 */

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDb } from "../store.ts"

describe("initDb", () => {
  test("adds reasoning_tokens to a database created without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-test-"))
    try {
      const path = join(dir, "eval.db")
      const old = new Database(path)
      // Indexed columns must exist, as they do in every real older schema
      old.exec(`CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, timestamp TEXT, fingerprint TEXT, repo TEXT, output_tokens INTEGER
      )`)
      old.exec(`INSERT INTO runs (run_id, output_tokens) VALUES ('r1', 15)`)
      old.close()

      const db = initDb(path)
      const columns = (db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).toContain("reasoning_tokens")
      // Existing rows keep their data and read as NULL for the new column
      expect(db.prepare(`SELECT output_tokens, reasoning_tokens FROM runs`).get()).toEqual({
        output_tokens: 15,
        reasoning_tokens: null,
      })
      // Running it again is a no-op rather than a duplicate-column error
      db.close()
      initDb(path).close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
