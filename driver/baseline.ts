/**
 * Baseline comparison logic for eval run regression detection.
 *
 * Compares current run metrics against a committed baseline.json
 * using configurable epsilon (cost) and tolerance (quality) thresholds.
 *
 * Regression detection:
 * - Token regression: cost or input_tokens exceed baseline by more than epsilon
 * - Quality regression: composite_score drops below baseline by more than tolerance
 * - Improvement: current cost is lower than baseline
 * - No-baseline: fingerprint not found in baseline file
 */

import { readFileSync } from "node:fs"
import type { Run, BaselineEntry } from "./store.ts"

// ── Types ────────────────────────────────────────────────────

/** Result of comparing a single run against its baseline. */
export interface ComparisonResult {
  status: "pass" | "regression" | "improvement" | "no-baseline"
  details: string[]
}

/** Aggregated comparison results across all runs. */
export interface ComparisonSummary {
  overall: "pass" | "fail"
  results: Map<string, ComparisonResult>
}

// ── Baseline loading ─────────────────────────────────────────

/**
 * Load baseline entries from a JSON file.
 *
 * The baseline file is a map of fingerprint → BaselineEntry,
 * exported by `store.exportBaseline()` and committed to the repo.
 *
 * @param baselinePath - Path to the baseline.json file.
 * @returns Map of fingerprint → BaselineEntry.
 */
export function loadBaseline(
  baselinePath: string,
): Record<string, BaselineEntry> {
  const raw = readFileSync(baselinePath, "utf-8")
  return JSON.parse(raw) as Record<string, BaselineEntry>
}

// ── Comparison logic ─────────────────────────────────────────

/**
 * Compare a single run against its baseline entry.
 *
 * Regression logic (per spec):
 * - Token regression: current.cost_usd > baseline.cost_usd * (1 + epsilon)
 *   OR current.input_tokens > baseline.input_tokens * (1 + epsilon)
 * - Quality regression: current.composite_score < baseline.composite_score - tolerance
 *   (only when both scores are non-null)
 * - Improvement: current cost is strictly lower than baseline cost
 * - Pass: within tolerance on all metrics
 *
 * @param current - The current run to evaluate.
 * @param baseline - The baseline entry to compare against.
 * @param opts - Epsilon (cost tolerance ratio) and tolerance (quality tolerance absolute).
 * @returns ComparisonResult with status and detail messages.
 */
export function compareRun(
  current: Run,
  baseline: BaselineEntry,
  opts: { epsilon: number; tolerance: number },
): ComparisonResult {
  const details: string[] = []
  let hasRegression = false
  let hasImprovement = false

  const currentCost = current.cost_usd ?? 0
  const baselineCost = baseline.cost_usd ?? 0
  const currentInputTokens = current.input_tokens ?? 0
  const baselineInputTokens = baseline.input_tokens ?? 0

  // Cost regression check
  if (baselineCost > 0 && currentCost > baselineCost * (1 + opts.epsilon)) {
    const pctIncrease = ((currentCost - baselineCost) / baselineCost * 100).toFixed(1)
    details.push(
      `Cost regression: $${currentCost.toFixed(4)} vs baseline $${baselineCost.toFixed(4)} (+${pctIncrease}%, epsilon=${(opts.epsilon * 100).toFixed(0)}%)`,
    )
    hasRegression = true
  }

  // Input token regression check
  if (
    baselineInputTokens > 0 &&
    currentInputTokens > baselineInputTokens * (1 + opts.epsilon)
  ) {
    const pctIncrease = ((currentInputTokens - baselineInputTokens) / baselineInputTokens * 100).toFixed(1)
    details.push(
      `Input token regression: ${currentInputTokens} vs baseline ${baselineInputTokens} (+${pctIncrease}%, epsilon=${(opts.epsilon * 100).toFixed(0)}%)`,
    )
    hasRegression = true
  }

  // Quality regression check — only when both scores are non-null
  if (current.composite_score != null && baseline.composite_score != null) {
    if (current.composite_score < baseline.composite_score - opts.tolerance) {
      details.push(
        `Quality regression: ${current.composite_score.toFixed(2)} vs baseline ${baseline.composite_score.toFixed(2)} (tolerance=${opts.tolerance})`,
      )
      hasRegression = true
    }
  }

  // Improvement check — cost is lower than baseline
  if (baselineCost > 0 && currentCost < baselineCost) {
    const pctDecrease = ((baselineCost - currentCost) / baselineCost * 100).toFixed(1)
    details.push(
      `Cost improvement: $${currentCost.toFixed(4)} vs baseline $${baselineCost.toFixed(4)} (-${pctDecrease}%)`,
    )
    hasImprovement = true
  }

  if (hasRegression) {
    return { status: "regression", details }
  }
  if (hasImprovement) {
    return { status: "improvement", details }
  }

  details.push("Within tolerance")
  return { status: "pass", details }
}

/**
 * Compare all runs against the baseline, producing an aggregated summary.
 *
 * Each run is matched to its baseline entry by fingerprint. Runs without
 * a matching baseline entry get "no-baseline" status. The overall result
 * is "fail" if any run has a regression.
 *
 * @param runs - Array of current runs to evaluate.
 * @param baseline - Map of fingerprint → BaselineEntry.
 * @param opts - Epsilon and tolerance thresholds.
 * @returns ComparisonSummary with per-fingerprint results and overall status.
 */
export function compareAllRuns(
  runs: Run[],
  baseline: Record<string, BaselineEntry>,
  opts: { epsilon: number; tolerance: number },
): ComparisonSummary {
  const results = new Map<string, ComparisonResult>()
  let hasRegression = false

  for (const run of runs) {
    const baselineEntry = baseline[run.fingerprint]
    if (!baselineEntry) {
      results.set(run.fingerprint, {
        status: "no-baseline",
        details: [`No baseline found for fingerprint ${run.fingerprint.slice(0, 12)}... (task: ${run.task_id})`],
      })
      continue
    }

    const result = compareRun(run, baselineEntry, opts)
    results.set(run.fingerprint, result)
    if (result.status === "regression") {
      hasRegression = true
    }
  }

  return {
    overall: hasRegression ? "fail" : "pass",
    results,
  }
}
