/**
 * Per-run workdir preparation for fixtures that declare a setup script.
 *
 * A fixture with `setup: setup.sh` in task.yaml gets a fresh temporary
 * workdir. The setup script builds the project state the command runs
 * against (a copy of the consumer repo, a detached HEAD, a dirty tree,
 * ...) and the opencode server is pointed at that workdir instead of
 * the fixture directory.
 *
 * A fixture `stubs/` directory is prepended to PATH so stub executables
 * (e.g. a fake `gh`) shadow the real ones. Stubs append one line per
 * call to $EVAL_STUB_LOG, which lives outside the workdir so it never
 * shows up in the workdir's git status.
 *
 * Setup scripts receive:
 *   EVAL_WORKDIR     — empty directory to populate
 *   EVAL_FIXTURE_DIR — the fixture directory
 *   EVAL_REPO_ROOT   — git toplevel containing the fixture
 *   EVAL_STUB_LOG    — stub call log path
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

// ── Types ────────────────────────────────────────────────────

/** A prepared workdir and the environment the server must run with. */
export interface PreparedWorkdir {
  projectDir: string
  /** Environment overrides (undefined = unset) for the server process. */
  env: Record<string, string | undefined>
  stubLogPath: string | null
  /** True when the workdir was created by a setup script. */
  isolated: boolean
  cleanup: () => void
}

// ── Preparation ──────────────────────────────────────────────

/**
 * Prepare the project directory for a fixture run.
 *
 * Without a setup script the fixture directory itself is the project,
 * preserving the original fixture behavior.
 *
 * @throws Error if the setup script exits non-zero.
 */
export function prepareWorkdir(
  fixtureDir: string,
  setup: string | undefined,
  log: (msg: string) => void,
  /** Extra variables for setup and the server; EVAL_* keys win on conflict. */
  extraEnv: Record<string, string | undefined> = {},
): PreparedWorkdir {
  const stubsDir = join(fixtureDir, "stubs")
  const hasStubs = existsSync(stubsDir)

  if (!setup && !hasStubs) {
    return { projectDir: fixtureDir, env: {}, stubLogPath: null, isolated: false, cleanup: () => {} }
  }

  const runDir = mkdtempSync(join(tmpdir(), "eval-run-"))
  const workdir = join(runDir, "work")
  mkdirSync(workdir)
  const stubLogPath = join(runDir, "stub.log")
  writeFileSync(stubLogPath, "")

  const env: Record<string, string | undefined> = {
    ...extraEnv,
    EVAL_WORKDIR: workdir,
    EVAL_FIXTURE_DIR: resolve(fixtureDir),
    EVAL_REPO_ROOT: gitToplevel(fixtureDir) ?? resolve(fixtureDir),
    EVAL_STUB_LOG: stubLogPath,
  }
  if (hasStubs) {
    env.PATH = `${resolve(stubsDir)}${delimiter}${process.env.PATH ?? ""}`
    // Stubs replace gh; make sure a fall-through to a real gh binary
    // (absolute path, PATH reorder) cannot authenticate.
    env.GH_TOKEN = undefined
    env.GITHUB_TOKEN = undefined
  }

  const cleanup = () => rmSync(runDir, { recursive: true, force: true })

  if (setup) {
    const setupPath = join(fixtureDir, setup)
    log(`Running setup ${setup} → ${workdir}`)
    const result = spawnSync("bash", [setupPath], {
      cwd: fixtureDir,
      env: mergeEnv(process.env, env),
      encoding: "utf-8",
      timeout: 5 * 60_000,
    })
    if (result.status !== 0) {
      cleanup()
      throw new Error(`setup ${setup} failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim().slice(-2000)}`)
    }
  }

  return {
    projectDir: setup ? workdir : fixtureDir,
    env,
    stubLogPath,
    isolated: Boolean(setup),
    cleanup,
  }
}

/** Read the stub log written during the run (empty if none). */
export function readStubLog(prepared: PreparedWorkdir): string {
  if (!prepared.stubLogPath || !existsSync(prepared.stubLogPath)) return ""
  return readFileSync(prepared.stubLogPath, "utf-8")
}

/** `git status --porcelain` for a directory, or null if it is not a repo. */
export function gitStatus(dir: string): string | null {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8", timeout: 10_000 })
  return result.status === 0 ? result.stdout : null
}

/**
 * Apply env overrides to process.env for the duration of fn.
 *
 * createOpencodeServer spawns `opencode serve` with process.env, so
 * this is how PATH stubs and setup variables reach the server and
 * every tool it runs.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function gitToplevel(dir: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf-8" })
  return result.status === 0 ? result.stdout.trim() : null
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}
