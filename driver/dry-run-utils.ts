/**
 * Dry-run cost estimation utilities.
 *
 * Extracted as a pure module for testability — the formatting
 * logic has no I/O dependencies and can be unit tested without
 * a database or filesystem.
 */

// ── Types ────────────────────────────────────────────────────

/** A single entry in the dry-run estimation table. */
export interface DryRunEntry {
  taskId: string
  fingerprint: string
  estimatedCost: number | null
  estimatedTokens: number | null
  source: "historical" | "no estimate available"
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format dry-run entries as a markdown table with projected totals.
 *
 * @param entries - Array of dry-run estimation entries.
 * @returns Formatted markdown table string.
 */
export function formatDryRunTable(entries: DryRunEntry[]): string {
  const lines: string[] = []

  lines.push("## Dry-Run Cost Estimate")
  lines.push("")
  lines.push("| Fixture | Fingerprint | Est. Cost ($) | Est. Tokens | Source |")
  lines.push("| --- | --- | --- | --- | --- |")

  let totalCost = 0
  for (const entry of entries) {
    const cost = entry.estimatedCost != null
      ? entry.estimatedCost.toFixed(4)
      : "N/A"
    const tokens = entry.estimatedTokens != null
      ? String(entry.estimatedTokens)
      : "N/A"
    totalCost += entry.estimatedCost ?? 0

    lines.push(
      `| ${entry.taskId} | ${entry.fingerprint.slice(0, 12)}... | ${cost} | ${tokens} | ${entry.source} |`,
    )
  }

  lines.push("")
  lines.push(`**Projected Total**: $${totalCost.toFixed(4)}`)
  lines.push("")

  return lines.join("\n")
}
