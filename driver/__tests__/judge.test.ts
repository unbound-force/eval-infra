/**
 * Unit tests for judge.ts — rubric parsing and prompt construction.
 *
 * Tests cover:
 * - parseRubric() with valid rubric markdown
 * - parseRubric() with missing frontmatter
 * - parseRubric() with weights that don't sum to 1.0
 * - parseRubric() with empty criteria sections
 * - buildJudgePrompt() output structure
 *
 * Note: callJudgeModel() and judge() are integration tests requiring
 * a running opencode server and are not tested here.
 */

import { describe, expect, test } from "bun:test"
import { parseRubric, buildJudgePrompt } from "../judge.ts"

// ── parseRubric tests ────────────────────────────────────────

describe("parseRubric", () => {
  test("parses valid rubric with frontmatter and criteria", () => {
    const content = `---
rubric_version: "1"
pass_threshold: 0.50
weights:
  completeness: 0.50
  correctness: 0.50
---

## completeness
Does the output include helpful information about available commands?

## correctness
Is the information accurate and well-formatted?
`
    const result = parseRubric(content)

    expect(result.config.rubric_version).toBe("1")
    expect(result.config.pass_threshold).toBe(0.50)
    expect(result.config.weights.completeness).toBe(0.50)
    expect(result.config.weights.correctness).toBe(0.50)
    expect(result.criteria.completeness).toContain("helpful information")
    expect(result.criteria.correctness).toContain("accurate")
  })

  test("throws on missing frontmatter", () => {
    const content = `## completeness
Some description
`
    expect(() => parseRubric(content)).toThrow("missing YAML frontmatter")
  })

  test("throws on missing rubric_version", () => {
    const content = `---
pass_threshold: 0.50
weights:
  completeness: 1.0
---

## completeness
Description
`
    expect(() => parseRubric(content)).toThrow("missing rubric_version")
  })

  test("throws on missing weights", () => {
    const content = `---
rubric_version: "1"
pass_threshold: 0.50
---

## completeness
Description
`
    expect(() => parseRubric(content)).toThrow("missing or invalid weights")
  })

  test("handles weights that don't sum to 1.0", () => {
    const content = `---
rubric_version: "1"
pass_threshold: 0.50
weights:
  completeness: 0.30
  correctness: 0.30
  style: 0.30
---

## completeness
Completeness description

## correctness
Correctness description

## style
Style description
`
    // Should parse without error — normalization happens at scoring time
    const result = parseRubric(content)
    expect(result.config.weights.completeness).toBe(0.30)
    expect(result.config.weights.correctness).toBe(0.30)
    expect(result.config.weights.style).toBe(0.30)
    // Sum is 0.90, not 1.0 — this is valid, normalization is done in judge()
  })

  test("handles empty criteria sections", () => {
    const content = `---
rubric_version: "1"
pass_threshold: 0.50
weights:
  completeness: 1.0
---

## completeness
`
    const result = parseRubric(content)
    expect(result.criteria.completeness).toBe("")
  })

  test("parses multiple criteria sections correctly", () => {
    const content = `---
rubric_version: "1"
pass_threshold: 0.70
weights:
  accuracy: 0.40
  completeness: 0.35
  style: 0.25
---

## accuracy
Is the output factually correct?

## completeness
Does the output cover all required aspects?

## style
Is the output well-formatted and readable?
`
    const result = parseRubric(content)
    expect(Object.keys(result.criteria)).toHaveLength(3)
    expect(result.criteria.accuracy).toContain("factually correct")
    expect(result.criteria.completeness).toContain("required aspects")
    expect(result.criteria.style).toContain("well-formatted")
  })
})

// ── buildJudgePrompt tests ───────────────────────────────────

describe("buildJudgePrompt", () => {
  test("includes criteria, transcript, and diff in prompt", () => {
    const criteria = {
      completeness: "Does it cover everything?",
      correctness: "Is it correct?",
    }
    const transcript = "User: help\nAssistant: Here are the commands..."
    const diff = "diff --git a/file.ts b/file.ts\n+new line"

    const prompt = buildJudgePrompt(criteria, transcript, diff)

    expect(prompt).toContain("completeness")
    expect(prompt).toContain("Does it cover everything?")
    expect(prompt).toContain("correctness")
    expect(prompt).toContain("Is it correct?")
    expect(prompt).toContain("Here are the commands")
    expect(prompt).toContain("+new line")
    expect(prompt).toContain("0.0 to 1.0")
    expect(prompt).toContain("JSON")
  })

  test("truncates long transcripts", () => {
    const criteria = { test: "test" }
    const longTranscript = "x".repeat(100_000)
    const prompt = buildJudgePrompt(criteria, longTranscript, "")

    // Should be truncated to 50k chars
    expect(prompt.length).toBeLessThan(100_000)
  })
})
