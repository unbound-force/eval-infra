/**
 * Deterministic assertions over an eval run's trajectory.
 *
 * Fixtures declare assertions in assertions.yaml. Each assertion is a
 * single-key map checked against what the agent actually did — the
 * tool calls in the session tree, the root assistant text, calls made
 * to stubbed executables, and the workdir's git status — rather than
 * graded by a judge model.
 *
 * ```yaml
 * assertions:
 *   - tool_not_called: [dispatch_review_runs, task]
 *   - tool_called: { name: get_progress, max: 1 }
 *   - bash_not_matches: '\bgh\s+pr\b'
 *   - text_matches: { pattern: 'specs', flags: 'i' }
 *   - stub_not_called: gh
 *   - files_unchanged: true
 *   - tool_output_matches: { tool: consolidate_dispatch, pattern: 'REQUEST.CHANGES' }
 *   - sessions_completed: { agent: '^divisor-' }
 * ```
 */

import type { Interactions } from "./opencode-driver.ts"
import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import type { Trajectory } from "./trajectory.ts"

// ── Types ────────────────────────────────────────────────────

/** One call recorded by a stub executable on PATH. */
export interface StubCall {
  name: string
  args: string
}

/** Inputs every assertion is evaluated against. */
export interface AssertionContext {
  trajectory: Trajectory
  stubCalls: StubCall[]
  /** `git status --porcelain` output for the workdir, or null if unavailable. */
  workdirStatus: string | null
  /** Questions and permission asks seen during the run, when recorded. */
  interactions?: Interactions
}

/** Outcome of a single assertion. */
export interface AssertionResult {
  label: string
  passed: boolean
  detail: string
}

type Pattern = string | { pattern: string; flags?: string }
type Assertion = Record<string, unknown>

// ── Parsing ──────────────────────────────────────────────────

const KNOWN_KINDS = new Set([
  "tool_called",
  "tool_not_called",
  "bash_matches",
  "bash_not_matches",
  "text_matches",
  "text_not_matches",
  "stub_called",
  "stub_not_called",
  "files_unchanged",
  "no_permission_asks",
  "no_unanswered_questions",
  "tool_output_matches",
  "tool_output_not_matches",
  "sessions_completed",
])

/**
 * Parse assertions.yaml content into a list of assertions.
 *
 * @throws Error on unknown kinds or entries that are not single-key maps,
 *   so a typo fails the fixture instead of silently passing.
 */
export function parseAssertions(content: string): Assertion[] {
  const doc = parseYaml(content) as { assertions?: unknown }
  const list = doc?.assertions
  if (!Array.isArray(list)) {
    throw new Error("assertions.yaml must contain an `assertions` list")
  }
  for (const [i, entry] of list.entries()) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 1) {
      throw new Error(`assertion #${i + 1} must be a single-key map`)
    }
    const kind = Object.keys(entry)[0]
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(`assertion #${i + 1}: unknown kind '${kind}'`)
    }
  }
  return list as Assertion[]
}

/** Read and parse an assertions.yaml file. */
export function loadAssertions(path: string): Assertion[] {
  return parseAssertions(readFileSync(path, "utf-8"))
}

/**
 * Parse a stub call log. Each line is `<name>\t<args>`, written by the
 * fixture's stub executables to $EVAL_STUB_LOG.
 */
export function parseStubLog(content: string): StubCall[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t")
      return tab === -1
        ? { name: line, args: "" }
        : { name: line.slice(0, tab), args: line.slice(tab + 1) }
    })
}

// ── Evaluation ───────────────────────────────────────────────

/** Evaluate every assertion against the context, in declaration order. */
export function evaluateAssertions(
  assertions: Assertion[],
  ctx: AssertionContext,
): AssertionResult[] {
  return assertions.map((a) => {
    const [kind, value] = Object.entries(a)[0]
    return evaluateOne(kind, value, ctx)
  })
}

function evaluateOne(kind: string, value: unknown, ctx: AssertionContext): AssertionResult {
  const calls = ctx.trajectory.toolCalls
  const label = `${kind}: ${JSON.stringify(value)}`

  switch (kind) {
    case "tool_called": {
      const spec = typeof value === "string" ? { name: value } : (value as { name: string; min?: number; max?: number })
      const count = calls.filter((c) => c.tool === spec.name).length
      const min = spec.min ?? 1
      const max = spec.max ?? Infinity
      return {
        label,
        passed: count >= min && count <= max,
        detail: `${spec.name} called ${count} time(s), expected ${min}..${max === Infinity ? "∞" : max}`,
      }
    }

    case "tool_not_called": {
      const names = toList(value)
      const hits = calls.filter((c) => names.includes(c.tool)).map((c) => c.tool)
      return {
        label,
        passed: hits.length === 0,
        detail: hits.length === 0 ? "none called" : `called: ${unique(hits).join(", ")}`,
      }
    }

    case "bash_matches":
    case "bash_not_matches": {
      const re = toRegExp(value as Pattern)
      const commands = calls
        .filter((c) => c.tool === "bash")
        .map((c) => String(c.input.command ?? ""))
      const hits = commands.filter((cmd) => re.test(cmd))
      return matchResult(label, kind.endsWith("not_matches"), hits, `${commands.length} bash call(s)`)
    }

    case "text_matches":
    case "text_not_matches": {
      const re = toRegExp(value as Pattern)
      const hit = re.test(ctx.trajectory.text)
      const negate = kind.endsWith("not_matches")
      return {
        label,
        passed: negate ? !hit : hit,
        detail: hit ? `matched ${re}` : `no match for ${re}`,
      }
    }

    case "stub_called":
    case "stub_not_called": {
      const spec = typeof value === "string" ? { name: value } : (value as { name: string; args_matches?: Pattern })
      const re = spec.args_matches ? toRegExp(spec.args_matches) : null
      const hits = ctx.stubCalls
        .filter((s) => s.name === spec.name && (!re || re.test(s.args)))
        .map((s) => `${s.name} ${s.args}`.trim())
      return matchResult(label, kind === "stub_not_called", hits, `${ctx.stubCalls.length} stub call(s)`)
    }

    case "tool_output_matches":
    case "tool_output_not_matches": {
      // Passes for _matches when any call's output matches; for
      // _not_matches when none does. Zero calls fails _matches only.
      const spec = value as { tool: string; pattern: string; flags?: string }
      const re = toRegExp(spec)
      // Plugin tools often return a one-line summary and put findings in
      // metadata, so search both
      const outputs = calls
        .filter((c) => c.tool === spec.tool)
        .map((c) => (c.metadata == null ? c.output : `${c.output}\n${JSON.stringify(c.metadata)}`))
      const hits = outputs.filter((o) => re.test(o)).map((o) => excerpt(o, re))
      return matchResult(label, kind.endsWith("not_matches"), hits, `${outputs.length} ${spec.tool} output(s)`)
    }

    case "no_permission_asks": {
      const asks = ctx.interactions?.permissionAsks ?? []
      return {
        label,
        passed: asks.length === 0,
        detail: asks.length === 0
          ? "configuration decided every permission"
          : asks.map((a) => `${a.permission} (${a.patterns.join(", ")})`).join("; "),
      }
    }

    case "no_unanswered_questions": {
      const open = (ctx.interactions?.questions ?? []).filter((q) => q.status !== "answered")
      return {
        label,
        passed: open.length === 0,
        detail: open.length === 0
          ? `${ctx.interactions?.questions.length ?? 0} question(s) answered`
          : open.map((q) => `${q.status}: ${q.questions[0]?.header ?? ""}`).join("; "),
      }
    }

    case "sessions_completed": {
      // A subagent that hits its output limit, or ends without saying
      // anything, can still be reported upstream as a successful run (a
      // reviewer with no findings reads as an approval). Every session
      // whose agent matches must have produced text and stopped on its own.
      const spec = value && typeof value === "object" ? (value as { agent?: Pattern }) : {}
      const re = spec.agent === undefined ? null : toRegExp(spec.agent)
      const sessions = ctx.trajectory.sessions.filter((s) => re === null || re.test(s.agent))
      const bad = sessions.flatMap((s) => {
        const why = s.turns === 0 ? "no response"
          : s.last_finish === "length" ? `hit the output limit (reasoning ${s.reasoning_tokens}, output ${s.output_tokens})`
          : s.text_chars === 0 ? `no text (finish ${s.last_finish || "unknown"})`
          : null
        return why === null ? [] : [`${s.agent || "?"} ${s.sessionID}: ${why}`]
      })
      if (sessions.length === 0) {
        return { label, passed: false, detail: "no session matched" }
      }
      return {
        label,
        passed: bad.length === 0,
        detail: bad.length === 0 ? `${sessions.length} session(s) completed with text` : bad.join("; "),
      }
    }

    case "files_unchanged": {
      if (ctx.workdirStatus === null) {
        return { label, passed: false, detail: "workdir git status unavailable" }
      }
      const changed = ctx.workdirStatus.trim()
      return {
        label,
        passed: changed === "",
        detail: changed === "" ? "clean" : `changed:\n${changed}`,
      }
    }
  }

  return { label, passed: false, detail: `unknown kind '${kind}'` }
}

// ── Helpers ──────────────────────────────────────────────────

function matchResult(label: string, negate: boolean, hits: string[], scope: string): AssertionResult {
  const passed = negate ? hits.length === 0 : hits.length > 0
  const detail = hits.length === 0 ? `no match in ${scope}` : `matched: ${hits.slice(0, 3).join(" | ")}`
  return { label, passed, detail }
}

/** A short window of text around the first match, for failure details. */
function excerpt(text: string, re: RegExp): string {
  const m = re.exec(text)
  if (!m) return text.slice(0, 80)
  const start = Math.max(0, m.index - 40)
  return text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ")
}

function toRegExp(p: Pattern): RegExp {
  return typeof p === "string" ? new RegExp(p) : new RegExp(p.pattern, p.flags ?? "")
}

function toList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
