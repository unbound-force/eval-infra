/**
 * Unit tests for trajectory.ts and assertions.ts.
 *
 * Tests cover:
 * - extractTrajectory() flattening tool parts across a session tree
 * - extractTrajectory() keeping only root, non-synthetic assistant text
 * - parseAssertions() rejecting unknown kinds and malformed entries
 * - evaluateAssertions() for every assertion kind, pass and fail
 * - parseStubLog() line format
 */

import { describe, expect, test } from "bun:test"
import { extractTrajectory, type SessionMessages, type Trajectory } from "../trajectory.ts"
import {
  evaluateAssertions,
  parseAssertions,
  parseStubLog,
  type AssertionContext,
} from "../assertions.ts"

// ── Fixtures ─────────────────────────────────────────────────

function toolPart(tool: string, input: Record<string, unknown> = {}, output = "") {
  return { type: "tool", tool, callID: `call-${tool}`, state: { status: "completed", input, output } }
}

const SESSIONS: SessionMessages[] = [
  {
    sessionID: "root",
    depth: 0,
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "/uf.review-council specs 42" }] },
      {
        info: { role: "assistant" },
        parts: [
          toolPart("get_progress", { command: "uf.review-council" }),
          toolPart("bash", { command: "git branch --show-current" }),
          toolPart("consolidate_dispatch", {}, '{"status":"success","review_verdict":{"verdict":"REQUEST CHANGES"}}'),
          { type: "text", text: "Invalid invocation: `specs` cannot be combined with a PR number." },
          { type: "text", text: "injected", synthetic: true },
        ],
      },
    ],
  },
  {
    sessionID: "child",
    depth: 1,
    messages: [
      {
        info: { role: "assistant" },
        parts: [toolPart("read", { filePath: "AGENTS.md" }), { type: "text", text: "child text" }],
      },
    ],
  },
]

function ctx(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    trajectory: extractTrajectory(SESSIONS),
    stubCalls: [],
    workdirStatus: "",
    ...overrides,
  }
}

function run(yaml: string, c: AssertionContext = ctx()) {
  return evaluateAssertions(parseAssertions(yaml), c)
}

// ── extractTrajectory ────────────────────────────────────────

describe("extractTrajectory", () => {
  test("collects tool calls from every session in order with depth", () => {
    const t = extractTrajectory(SESSIONS)
    expect(t.toolCalls.map((c) => [c.tool, c.depth])).toEqual([
      ["get_progress", 0],
      ["bash", 0],
      ["consolidate_dispatch", 0],
      ["read", 1],
    ])
    expect(t.toolCalls[1].input.command).toBe("git branch --show-current")
    expect(t.sessionCount).toBe(2)
  })

  test("sums usage over every assistant message in the tree", () => {
    // Shape and numbers from a real two-turn /uf.review-council run whose
    // SSE-based capture reported only the first turn (19089 in / 15 out)
    const assistant = (input: number, output: number, reasoning: number, read: number, cost: number, finish: string) => ({
      info: { role: "assistant", finish, cost, tokens: { input, output, reasoning, cache: { read, write: 0 } } },
      parts: [],
    })
    const t = extractTrajectory([
      {
        sessionID: "root",
        depth: 0,
        messages: [
          { info: { role: "user", tokens: { input: 999 } }, parts: [] },
          assistant(19089, 15, 4288, 41472, 0.01, "tool-calls"),
          assistant(1353, 280, 612, 59904, 0.02, "stop"),
        ],
      },
      { sessionID: "child", depth: 1, messages: [assistant(10, 5, 7, 0, 0.005, "stop")] },
    ])
    expect(t.usage.input_tokens).toBe(19089 + 1353 + 10)
    expect(t.usage.output_tokens).toBe(15 + 280 + 5)
    // Reasoning is reported apart from output, so it must be summed on its own
    expect(t.usage.reasoning_tokens).toBe(4288 + 612 + 7)
    expect(t.usage.cache_read_tokens).toBe(41472 + 59904)
    expect(t.usage.cost_usd).toBeCloseTo(0.035)
    expect(t.usage.turns).toBe(3)
    expect(t.usage.tool_calls_count).toBe(1)
  })

  test("attributes usage and timing to each session", () => {
    const t = extractTrajectory([
      {
        sessionID: "root",
        depth: 0,
        messages: [
          { info: { role: "user", time: { created: 100 } }, parts: [] },
          { info: { role: "assistant", agent: "build", providerID: "p", modelID: "m", time: { created: 110, completed: 150 }, tokens: { input: 5, output: 2, reasoning: 9 } }, parts: [] },
        ],
      },
      {
        sessionID: "child",
        depth: 1,
        messages: [
          { info: { role: "assistant", agent: "divisor-guard", finish: "stop", time: { created: 120, completed: 400 }, tokens: { input: 7, output: 3, reasoning: 1 } }, parts: [{ type: "text", text: " ok \n" }] },
        ],
      },
    ])
    expect(t.sessions).toEqual([
      { sessionID: "root", depth: 0, agent: "build", model: "p/m", turns: 1, input_tokens: 5, output_tokens: 2, reasoning_tokens: 9, cache_read_tokens: 0, last_finish: "", text_chars: 0, started: 100, finished: 150 },
      { sessionID: "child", depth: 1, agent: "divisor-guard", model: "", turns: 1, input_tokens: 7, output_tokens: 3, reasoning_tokens: 1, cache_read_tokens: 0, last_finish: "stop", text_chars: 2, started: 120, finished: 400 },
    ])
    // Child text counts toward its session but stays out of the root text.
    expect(t.text).toBe("")
  })

  test("reports zero usage for an empty tree", () => {
    expect(extractTrajectory([]).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
      turns: 0,
      tool_calls_count: 0,
    })
  })

  test("keeps only root non-synthetic assistant text", () => {
    const t = extractTrajectory(SESSIONS)
    expect(t.text).toContain("Invalid invocation")
    expect(t.text).not.toContain("injected")
    expect(t.text).not.toContain("child text")
    expect(t.text).not.toContain("/uf.review-council")
  })
})

// ── parseAssertions ──────────────────────────────────────────

describe("parseAssertions", () => {
  test("rejects a document without an assertions list", () => {
    expect(() => parseAssertions("foo: 1")).toThrow("assertions")
  })

  test("rejects unknown kinds so typos cannot silently pass", () => {
    expect(() => parseAssertions("assertions:\n  - tool_not_caled: task")).toThrow("unknown kind")
  })

  test("rejects multi-key entries", () => {
    expect(() => parseAssertions("assertions:\n  - { tool_called: a, tool_not_called: b }")).toThrow("single-key")
  })
})

// ── evaluateAssertions ───────────────────────────────────────

describe("evaluateAssertions", () => {
  test("tool_called honours default min 1 and explicit bounds", () => {
    const [a, b, c] = run(`assertions:
  - tool_called: get_progress
  - tool_called: { name: get_progress, max: 0 }
  - tool_called: { name: read, min: 1, max: 1 }`)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(false)
    expect(c.passed).toBe(true)
  })

  test("tool_not_called sees subagent calls and accepts a list", () => {
    const [a, b] = run(`assertions:
  - tool_not_called: [dispatch_review_runs, task]
  - tool_not_called: read`)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(false)
    expect(b.detail).toContain("read")
  })

  test("bash_matches and bash_not_matches inspect bash commands", () => {
    const [a, b, c] = run(`assertions:
  - bash_matches: '^git branch'
  - bash_not_matches: '\\bgh\\b'
  - bash_not_matches: 'git'`)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(true)
    expect(c.passed).toBe(false)
  })

  test("text_matches supports flags and text_not_matches negates", () => {
    const [a, b, c] = run(`assertions:
  - text_matches: { pattern: 'INVALID INVOCATION', flags: i }
  - text_matches: 'INVALID INVOCATION'
  - text_not_matches: 'APPROVE'`)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(false)
    expect(c.passed).toBe(true)
  })

  test("stub_called and stub_not_called filter by name and args", () => {
    const c = ctx({ stubCalls: parseStubLog("gh\tpr view 42 --json headRefOid\ngit\tstatus\n") })
    const [a, b, d] = run(`assertions:
  - stub_called: { name: gh, args_matches: '^pr view' }
  - stub_not_called: gh
  - stub_not_called: { name: gh, args_matches: '^pr comment' }`, c)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(false)
    expect(d.passed).toBe(true)
  })

  test("files_unchanged fails on dirty or unavailable status", () => {
    const yaml = "assertions:\n  - files_unchanged: true"
    expect(run(yaml, ctx({ workdirStatus: "" }))[0].passed).toBe(true)
    expect(run(yaml, ctx({ workdirStatus: " M README.md\n" }))[0].passed).toBe(false)
    expect(run(yaml, ctx({ workdirStatus: null }))[0].passed).toBe(false)
  })

  test("tool_output_matches inspects the named tool's results", () => {
    const [a, b, c, d] = run(`assertions:
  - tool_output_matches: { tool: consolidate_dispatch, pattern: 'REQUEST.CHANGES' }
  - tool_output_not_matches: { tool: consolidate_dispatch, pattern: '"APPROVE' }
  - tool_output_matches: { tool: consolidate_dispatch, pattern: 'approve$' }
  - tool_output_matches: { tool: dispatch_review_runs, pattern: '.' }`)
    expect(a.passed).toBe(true)
    expect(a.detail).toContain("REQUEST CHANGES")
    expect(b.passed).toBe(true)
    expect(c.passed).toBe(false)
    // No calls at all is a failure for a positive match, not a vacuous pass
    expect(d.passed).toBe(false)
  })

  test("tool_output_matches also searches structured metadata", () => {
    const t = extractTrajectory([{
      sessionID: "root",
      depth: 0,
      messages: [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          tool: "dispatch_review_runs",
          state: { status: "completed", input: {}, output: "dispatch_review_runs: ok — 4 completed", metadata: { findings: [{ title: "Command injection via sh -c" }] } },
        }],
      }],
    }])
    const [a] = run("assertions:\n  - tool_output_matches: { tool: dispatch_review_runs, pattern: injection, flags: i }", ctx({ trajectory: t }))
    expect(a.passed).toBe(true)
  })

  test("no_permission_asks fails on any undecided permission", () => {
    const yaml = "assertions:\n  - no_permission_asks: true"
    expect(run(yaml, ctx({ interactions: { questions: [], permissionAsks: [] } }))[0].passed).toBe(true)
    const [a] = run(yaml, ctx({
      interactions: { questions: [], permissionAsks: [{ sessionID: "child", permission: "external_directory", patterns: ["/etc/*"] }] },
    }))
    expect(a.passed).toBe(false)
    expect(a.detail).toContain("/etc/*")
  })

  test("no_unanswered_questions fails unless every question was answered", () => {
    const question = (status: "answered" | "unanswered") => ({
      requestID: "q", sessionID: "root", status, answers: null, askedAt: 0,
      questions: [{ header: "Continue or stop", question: "?", options: [] }],
    })
    const yaml = "assertions:\n  - no_unanswered_questions: true"
    expect(run(yaml, ctx({ interactions: { questions: [question("answered")], permissionAsks: [] } }))[0].passed).toBe(true)
    const [a] = run(yaml, ctx({ interactions: { questions: [question("unanswered")], permissionAsks: [] } }))
    expect(a.passed).toBe(false)
    expect(a.detail).toContain("Continue or stop")
  })

  test("sessions_completed fails on length-cut or silent matching sessions", () => {
    const session = (id: string, agent: string, finish: string, text: string): SessionMessages => ({
      sessionID: id,
      depth: 1,
      messages: [{
        info: { role: "assistant", agent, finish, tokens: { output: text ? 50 : 0, reasoning: 32000 } },
        parts: text ? [{ type: "text", text }] : [{ type: "reasoning", text: "thinking" }],
      }],
    })
    const tree = (...children: SessionMessages[]) => extractTrajectory([SESSIONS[0], ...children])
    const yaml = "assertions:\n  - sessions_completed: { agent: '^divisor-' }"

    const ok = run(yaml, ctx({ trajectory: tree(session("a", "divisor-guard", "stop", "verdict"), session("e", "explore", "stop", "")) }))
    expect(ok[0].passed).toBe(true)
    expect(ok[0].detail).toContain("1 session(s)")

    const cut = run(yaml, ctx({ trajectory: tree(session("b", "divisor-adversary", "length", "")) }))
    expect(cut[0].passed).toBe(false)
    expect(cut[0].detail).toContain("divisor-adversary b: hit the output limit")

    const silent = run(yaml, ctx({ trajectory: tree(session("c", "divisor-testing", "stop", "  ")) }))
    expect(silent[0].passed).toBe(false)
    expect(silent[0].detail).toContain("no text (finish stop)")

    const none = run(yaml, ctx({ trajectory: tree(session("e", "explore", "stop", "x")) }))
    expect(none[0].passed).toBe(false)
    expect(none[0].detail).toBe("no session matched")
  })

  test("an empty trajectory fails positive assertions", () => {
    const empty: Trajectory = extractTrajectory([])
    const [a, b] = run(`assertions:
  - tool_called: get_progress
  - tool_not_called: task`, ctx({ trajectory: empty }))
    expect(a.passed).toBe(false)
    expect(b.passed).toBe(true)
  })
})

// ── parseStubLog ─────────────────────────────────────────────

describe("parseStubLog", () => {
  test("splits name and args on the first tab and skips blank lines", () => {
    expect(parseStubLog("gh\tpr view\t42\n\ngh\n")).toEqual([
      { name: "gh", args: "pr view\t42" },
      { name: "gh", args: "" },
    ])
  })
})
