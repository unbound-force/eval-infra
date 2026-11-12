/**
 * Unit tests for workdir.ts.
 *
 * Tests cover:
 * - prepareWorkdir() legacy behavior without setup or stubs
 * - prepareWorkdir() running setup.sh with EVAL_* variables
 * - prepareWorkdir() surfacing setup failures
 * - stubs/ on PATH writing to the stub log via withEnv()
 * - withEnv() restoring and unsetting variables
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitStatus, prepareWorkdir, readStubLog, withEnv } from "../workdir.ts"

const dirs: string[] = []
const noop = () => {}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-fixture-test-"))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    if (path.startsWith("stubs/")) chmodSync(full, 0o755)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("prepareWorkdir", () => {
  test("uses the fixture directory when there is no setup or stubs/", () => {
    const dir = fixture({ "task.yaml": "" })
    const p = prepareWorkdir(dir, undefined, noop)
    expect(p.projectDir).toBe(dir)
    expect(p.isolated).toBe(false)
    expect(p.env).toEqual({})
  })

  test("runs setup.sh against a fresh workdir with EVAL_* variables", () => {
    const dir = fixture({
      "setup.sh": 'cd "$EVAL_WORKDIR" && git init -q && echo "$EVAL_FIXTURE_DIR" > fixture.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm init\n',
    })
    const p = prepareWorkdir(dir, "setup.sh", noop)
    try {
      expect(p.isolated).toBe(true)
      expect(p.projectDir).not.toBe(dir)
      expect(readFileSync(join(p.projectDir, "fixture.txt"), "utf-8").trim()).toBe(dir)
      expect(gitStatus(p.projectDir)).toBe("")
    } finally {
      p.cleanup()
    }
    expect(existsSync(p.projectDir)).toBe(false)
  })

  test("throws with the script's stderr when setup fails", () => {
    const dir = fixture({ "setup.sh": "echo boom >&2; exit 3\n" })
    expect(() => prepareWorkdir(dir, "setup.sh", noop)).toThrow(/exit 3.*boom/s)
  })

  test("stubs/ shadow PATH and log calls", async () => {
    const dir = fixture({
      "stubs/gh": '#!/usr/bin/env bash\nprintf "gh\\t%s\\n" "$*" >> "$EVAL_STUB_LOG"\n',
    })
    const p = prepareWorkdir(dir, undefined, noop)
    try {
      expect(p.env.GH_TOKEN).toBeUndefined()
      expect("GH_TOKEN" in p.env).toBe(true)
      await withEnv(p.env, async () => {
        spawnSync("gh", ["pr", "view", "42"], { env: process.env })
      })
      expect(readStubLog(p)).toBe("gh\tpr view 42\n")
    } finally {
      p.cleanup()
    }
  })
})

describe("withEnv", () => {
  test("sets, unsets, and restores variables", async () => {
    process.env.EVAL_TEST_KEEP = "original"
    delete process.env.EVAL_TEST_NEW
    await withEnv({ EVAL_TEST_KEEP: undefined, EVAL_TEST_NEW: "x" }, async () => {
      expect(process.env.EVAL_TEST_KEEP).toBeUndefined()
      expect(process.env.EVAL_TEST_NEW).toBe("x")
    })
    expect(process.env.EVAL_TEST_KEEP).toBe("original")
    expect(process.env.EVAL_TEST_NEW).toBeUndefined()
    delete process.env.EVAL_TEST_KEEP
  })
})
