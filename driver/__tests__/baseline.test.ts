/**
 * Unit tests for baseline.ts — regression detection, pass,
 * improvement, no-baseline, quality regression, and null
 * composite_score edge cases.
 */

import { describe, expect, test } from "bun:test"
import { compareRun, compareAllRuns, loadBaseline } from "../baseline.ts"
import type { ComparisonResult } from "../baseline.ts"
import type { Run, BaselineEntry } from "../store.ts"

// ── Test helpers ─────────────────────────────────────────────

/** Create a minimal Run with sensible defaults. */
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "test-run-001",
    timestamp: "2026-08-01T00:00:00Z",
    fingerprint: "abc123",
    repo: "test/repo",
    git_sha: null,
    git_branch: null,
    command_name: "help",
    task_id: "driver-smoke",
    task_version: "1",
    rubric_version: "1",
    profile_id: "baseline",
    model: "test-model",
    opencode_version: "1.2.26",
    exit_status: "success",
    error_message: null,
    composite_score: null,
    scores_json: null,
    cost_usd: 0.05,
    duration_s: 10,
    turns: 3,
    tool_calls_count: 5,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 200,
    cache_creation_tokens: 100,
    diff_bytes: 0,
    workdir_diff: null,
    ...overrides,
  }
}

/** Create a minimal BaselineEntry with sensible defaults. */
function makeBaseline(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    cost_usd: 0.05,
    input_tokens: 1000,
    output_tokens: 500,
    composite_score: null,
    timestamp: "2026-07-30T00:00:00Z",
    run_id: "baseline-run-001",
    ...overrides,
  }
}

const defaultOpts = { epsilon: 0.10, tolerance: 0.05 }

// ── compareRun tests ─────────────────────────────────────────

describe("compareRun", () => {
  test("returns pass when current is within epsilon", () => {
    const current = makeRun({ cost_usd: 0.054, input_tokens: 1050 })
    const baseline = makeBaseline()
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("pass")
  })

  test("detects cost regression when cost exceeds epsilon", () => {
    // baseline cost = 0.05, epsilon = 10%, threshold = 0.055
    const current = makeRun({ cost_usd: 0.06 })
    const baseline = makeBaseline()
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("regression")
    expect(result.details.some((d) => d.includes("Cost regression"))).toBe(true)
  })

  test("detects input token regression when tokens exceed epsilon", () => {
    // baseline tokens = 1000, epsilon = 10%, threshold = 1100
    const current = makeRun({ cost_usd: 0.05, input_tokens: 1200 })
    const baseline = makeBaseline()
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("regression")
    expect(result.details.some((d) => d.includes("Input token regression"))).toBe(true)
  })

  test("detects improvement when cost is lower", () => {
    const current = makeRun({ cost_usd: 0.03, input_tokens: 800 })
    const baseline = makeBaseline()
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("improvement")
    expect(result.details.some((d) => d.includes("Cost improvement"))).toBe(true)
  })

  test("detects quality regression when score drops below tolerance", () => {
    const current = makeRun({ composite_score: 0.60 })
    const baseline = makeBaseline({ composite_score: 0.80 })
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("regression")
    expect(result.details.some((d) => d.includes("Quality regression"))).toBe(true)
  })

  test("passes when quality score is within tolerance", () => {
    const current = makeRun({ composite_score: 0.77 })
    const baseline = makeBaseline({ composite_score: 0.80 })
    const result = compareRun(current, baseline, defaultOpts)
    // 0.77 >= 0.80 - 0.05 = 0.75, so no quality regression
    expect(result.details.some((d) => d.includes("Quality regression"))).toBe(false)
  })

  test("handles null composite_score in current — no quality regression", () => {
    const current = makeRun({ composite_score: null })
    const baseline = makeBaseline({ composite_score: 0.80 })
    const result = compareRun(current, baseline, defaultOpts)
    // null current score should not trigger quality regression
    expect(result.details.some((d) => d.includes("Quality regression"))).toBe(false)
  })

  test("handles null composite_score in baseline — no quality regression", () => {
    const current = makeRun({ composite_score: 0.60 })
    const baseline = makeBaseline({ composite_score: null })
    const result = compareRun(current, baseline, defaultOpts)
    // null baseline score should not trigger quality regression
    expect(result.details.some((d) => d.includes("Quality regression"))).toBe(false)
  })

  test("handles both composite_scores null — no quality regression", () => {
    const current = makeRun({ composite_score: null })
    const baseline = makeBaseline({ composite_score: null })
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.details.some((d) => d.includes("Quality regression"))).toBe(false)
  })

  test("regression takes precedence over improvement", () => {
    // Cost improved but quality regressed — should be regression
    const current = makeRun({ cost_usd: 0.03, composite_score: 0.50 })
    const baseline = makeBaseline({ composite_score: 0.80 })
    const result = compareRun(current, baseline, defaultOpts)
    expect(result.status).toBe("regression")
  })

  test("handles zero baseline cost gracefully", () => {
    const current = makeRun({ cost_usd: 0.05 })
    const baseline = makeBaseline({ cost_usd: 0 })
    const result = compareRun(current, baseline, defaultOpts)
    // Zero baseline cost should not trigger regression (division guard)
    expect(result.status).not.toBe("regression")
  })
})

// ── compareAllRuns tests ─────────────────────────────────────

describe("compareAllRuns", () => {
  test("returns no-baseline for unknown fingerprints", () => {
    const runs = [makeRun({ fingerprint: "unknown-fp" })]
    const baseline = { "other-fp": makeBaseline() }
    const summary = compareAllRuns(runs, baseline, defaultOpts)
    expect(summary.overall).toBe("pass")
    const result = summary.results.get("unknown-fp")
    expect(result?.status).toBe("no-baseline")
  })

  test("overall is fail when any run has regression", () => {
    const runs = [
      makeRun({ fingerprint: "fp-1", cost_usd: 0.05 }),
      makeRun({ fingerprint: "fp-2", cost_usd: 0.10 }),
    ]
    const baseline: Record<string, BaselineEntry> = {
      "fp-1": makeBaseline(),
      "fp-2": makeBaseline({ cost_usd: 0.05 }),
    }
    const summary = compareAllRuns(runs, baseline, defaultOpts)
    expect(summary.overall).toBe("fail")
    expect(summary.results.get("fp-2")?.status).toBe("regression")
  })

  test("overall is pass when all runs pass", () => {
    const runs = [
      makeRun({ fingerprint: "fp-1", cost_usd: 0.05 }),
      makeRun({ fingerprint: "fp-2", cost_usd: 0.04 }),
    ]
    const baseline: Record<string, BaselineEntry> = {
      "fp-1": makeBaseline(),
      "fp-2": makeBaseline(),
    }
    const summary = compareAllRuns(runs, baseline, defaultOpts)
    expect(summary.overall).toBe("pass")
  })

  test("handles mix of pass, improvement, and no-baseline without failing", () => {
    const runs = [
      makeRun({ fingerprint: "fp-1", cost_usd: 0.05 }),
      makeRun({ fingerprint: "fp-2", cost_usd: 0.03 }),
      makeRun({ fingerprint: "fp-3", cost_usd: 0.05 }),
    ]
    const baseline: Record<string, BaselineEntry> = {
      "fp-1": makeBaseline(),
      "fp-2": makeBaseline(),
      // fp-3 has no baseline
    }
    const summary = compareAllRuns(runs, baseline, defaultOpts)
    expect(summary.overall).toBe("pass")
    expect(summary.results.get("fp-1")?.status).toBe("pass")
    expect(summary.results.get("fp-2")?.status).toBe("improvement")
    expect(summary.results.get("fp-3")?.status).toBe("no-baseline")
  })
})

// ── loadBaseline tests ───────────────────────────────────────

describe("loadBaseline", () => {
  test("loads and parses a valid baseline JSON file", () => {
    // Write a temp file for testing
    const tmpPath = "/tmp/test-baseline.json"
    const data: Record<string, BaselineEntry> = {
      "fp-1": makeBaseline(),
    }
    const { writeFileSync } = require("node:fs")
    writeFileSync(tmpPath, JSON.stringify(data))
    const loaded = loadBaseline(tmpPath)
    expect(loaded["fp-1"]).toBeDefined()
    expect(loaded["fp-1"].cost_usd).toBe(0.05)
  })

  test("throws on non-existent file", () => {
    expect(() => loadBaseline("/tmp/nonexistent-baseline.json")).toThrow()
  })
})
