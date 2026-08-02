/**
 * Unit tests for dry-run cost estimation logic.
 *
 * Tests the formatDryRunTable() helper that generates the
 * dry-run output table from fixture metadata and historical data.
 */

import { describe, expect, test } from "bun:test"
import {
  formatDryRunTable,
  type DryRunEntry,
} from "../dry-run-utils.ts"

describe("formatDryRunTable", () => {
  test("formats entries with historical cost data", () => {
    const entries: DryRunEntry[] = [
      {
        taskId: "driver-smoke",
        fingerprint: "abc123",
        estimatedCost: 0.0512,
        estimatedTokens: 1500,
        source: "historical",
      },
    ]
    const table = formatDryRunTable(entries)
    expect(table).toContain("driver-smoke")
    expect(table).toContain("0.0512")
    expect(table).toContain("1500")
    expect(table).toContain("historical")
  })

  test("formats entries with no historical data", () => {
    const entries: DryRunEntry[] = [
      {
        taskId: "new-fixture",
        fingerprint: "def456",
        estimatedCost: null,
        estimatedTokens: null,
        source: "no estimate available",
      },
    ]
    const table = formatDryRunTable(entries)
    expect(table).toContain("new-fixture")
    expect(table).toContain("N/A")
    expect(table).toContain("no estimate available")
  })

  test("formats mixed entries correctly", () => {
    const entries: DryRunEntry[] = [
      {
        taskId: "fixture-a",
        fingerprint: "fp-a",
        estimatedCost: 0.10,
        estimatedTokens: 5000,
        source: "historical",
      },
      {
        taskId: "fixture-b",
        fingerprint: "fp-b",
        estimatedCost: null,
        estimatedTokens: null,
        source: "no estimate available",
      },
    ]
    const table = formatDryRunTable(entries)
    expect(table).toContain("fixture-a")
    expect(table).toContain("fixture-b")
    expect(table).toContain("Projected Total")
    expect(table).toContain("0.1000")
  })

  test("shows zero projected total when no estimates available", () => {
    const entries: DryRunEntry[] = [
      {
        taskId: "new-a",
        fingerprint: "fp-a",
        estimatedCost: null,
        estimatedTokens: null,
        source: "no estimate available",
      },
    ]
    const table = formatDryRunTable(entries)
    expect(table).toContain("0.0000")
  })
})
