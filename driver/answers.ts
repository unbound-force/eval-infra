/**
 * Pre-scripted answer patterns for AskUserQuestion prompts.
 *
 * Each entry maps a regex (matched against the question text) to
 * either a static answer or a function that computes one from context.
 *
 * The answer is always an array of label strings — matching the
 * QuestionV2Reply.answers format: Array<Array<string>>.
 *
 * Return `null` to bail (reject the question and skip to next issue).
 *
 * Ported from scripted/answers.ts with changes:
 * - AnswerContext generalized to { vars: Record<string, string> }
 * - Added loadFixtureAnswers() for YAML-based pattern overrides
 * - Added mergePatterns() for first-match-wins composition
 */

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

// ── Types ────────────────────────────────────────────────────

/**
 * Context passed to answer functions. Uses a generic vars map
 * so fixtures can inject arbitrary context (issue URLs, change
 * names, etc.) without coupling the answer engine to a specific
 * domain schema.
 */
export interface AnswerContext {
  vars: Record<string, string>
}

export type AnswerResult =
  | { action: "reply"; labels: string[][] }
  | { action: "bail"; reason: string }
  | { action: "done"; reason: string }

export interface AnswerPattern {
  /** Regex to match against the question text */
  match: RegExp
  /** Compute the answer, or return bail */
  answer: (question: string, ctx: AnswerContext) => AnswerResult
}

// ── Base answer patterns ─────────────────────────────────────

/**
 * The ordered list of answer patterns. First match wins.
 *
 * Patterns reference ctx.vars for dynamic values. Callers
 * populate vars with whatever keys their domain needs
 * (e.g., issueUrl, issueTitle, changeName).
 */
export const ANSWER_PATTERNS: AnswerPattern[] = [
  // ── opsx-propose ──────────────────────────────────────────

  // "What change do you want to work on?" — provide the issue URL
  {
    match: /what.*(change|build|work on|implement)/i,
    answer: (_q, ctx) => ({
      action: "reply",
      labels: [[
        `Fix ${ctx.vars.issueUrl ?? ""} — ${ctx.vars.issueTitle ?? ""}. ` +
        `This issue was filed from an audit of confirmation gate weaknesses. ` +
        `Read the issue body for the exact problem description and fix instructions.`
      ]],
    }),
  },

  // Uncommitted/dirty working tree — proceed anyway.
  {
    match: /uncommitted|dirty.*(tree|working)|untracked/i,
    answer: () => ({ action: "reply", labels: [["Yes"]] }),
  },

  // Change already exists — bail
  {
    match: /change.*(already exists|exists)/i,
    answer: () => ({ action: "bail", reason: "Change directory already exists" }),
  },

  // Branch conflict — switch to main first
  {
    match: /branch conflict|already on branch|finish or archive/i,
    answer: () => ({ action: "reply", labels: [["Switch to main first"]] }),
  },

  // ── cobalt-crush / opsx-apply ─────────────────────────────

  // "Which change would you like to apply?" — select the change name
  {
    match: /which change/i,
    answer: (_q, ctx) => ({
      action: "reply",
      labels: [[ctx.vars.changeName ?? ""]],
    }),
  },

  // Task is unclear — bail
  {
    match: /task is unclear|unclear.*task/i,
    answer: () => ({ action: "bail", reason: "Task marked as unclear" }),
  },

  // ── finale ────────────────────────────────────────────────

  // Selective staging — pick recommended option (stage only related files)
  {
    match: /stage only related|selective stag|unrelated.*file|files to commit|not related/i,
    answer: () => ({ action: "done", reason: "Stage only related files" }),
  },

  // Secret files found in staging — bail (never auto-approve secrets)
  {
    match: /secret.*(file|detect|found|staging)|sensitive.*(file|detect|found)/i,
    answer: () => ({ action: "bail", reason: "Secret files detected — requires human review" }),
  },

  // Approve commit message
  {
    match: /commit message|approve.*commit/i,
    answer: () => ({ action: "reply", labels: [["Approve"]] }),
  },

  // Push confirmation — approve pushing to remote
  {
    match: /push.*(branch|remote|origin)|confirm.*push|ready.*push/i,
    answer: () => ({ action: "reply", labels: [["Push to remote"]] }),
  },

  // PR target — upstream (we don't use forks)
  {
    match: /upstream|fork|target.*remote|remote.*target/i,
    answer: () => ({ action: "reply", labels: [["upstream"]] }),
  },

  // Approve PR content
  {
    match: /pr (content|body|description)|approve.*pr|review.*pr/i,
    answer: () => ({ action: "reply", labels: [["Approve"]] }),
  },

  // CI failure — stop
  {
    match: /ci.*(fail|error)|check.*(fail|error)|workflow.*(fail|error)/i,
    answer: () => ({ action: "bail", reason: "CI check failed" }),
  },

  // ── End-of-phase navigation questions ─────────────────────

  // "The proposal is complete. What would you like to do next?"
  {
    match: /proposal.*(complete|done|ready)|what.*like.*do next/i,
    answer: () => ({ action: "done", reason: "Phase complete — script handles next phase" }),
  },

  // "All tasks are complete" / "Implementation complete"
  {
    match: /all tasks.*(complete|done)|implementation.*(complete|done)/i,
    answer: () => ({ action: "done", reason: "Phase complete — script handles next phase" }),
  },

  // Generic "what would you like to do" / "next step"
  {
    match: /what would you like|what.*do.*next|next step/i,
    answer: () => ({ action: "done", reason: "Phase complete — script handles next phase" }),
  },

  // ── Generic patterns ──────────────────────────────────────

  // Any "proceed?" / "continue?" yes/no — say yes
  {
    match: /\b(proceed|continue)\b.*\?/i,
    answer: () => ({ action: "reply", labels: [["Yes"]] }),
  },

  // Any approve/reject choice — approve
  {
    match: /\b(approve|accept)\b/i,
    answer: () => ({ action: "reply", labels: [["Approve"]] }),
  },
]

// ── Fixture answer loading ───────────────────────────────────

/** Raw shape of a single pattern entry in answers.yaml */
interface RawAnswerEntry {
  match: string
  action: string
  labels?: string[][]
}

/**
 * Load answer patterns from a YAML fixture file.
 *
 * The YAML file contains an array of pattern objects:
 * ```yaml
 * - match: "what.*change"
 *   action: reply
 *   labels: [["my answer"]]
 * - match: "secret.*detected"
 *   action: bail
 * ```
 *
 * Each entry's `match` string is compiled to a case-insensitive RegExp.
 * The `action` field maps to AnswerResult actions (reply, bail, done).
 * The optional `labels` field provides the reply labels for "reply" actions.
 *
 * @param answersYamlPath - Absolute path to the answers.yaml file
 * @returns Array of AnswerPattern objects ready for use with findAnswer
 */
export function loadFixtureAnswers(answersYamlPath: string): AnswerPattern[] {
  const raw = readFileSync(answersYamlPath, "utf-8")
  const entries = parseYaml(raw) as RawAnswerEntry[]

  if (!Array.isArray(entries)) {
    throw new Error(`answers.yaml must contain an array, got ${typeof entries}`)
  }

  return entries.map((entry): AnswerPattern => {
    const regex = new RegExp(entry.match, "i")
    const action = entry.action
    const labels = entry.labels

    return {
      match: regex,
      answer: () => {
        switch (action) {
          case "reply":
            return { action: "reply", labels: labels ?? [[]] }
          case "bail":
            return { action: "bail", reason: `Fixture bail: ${entry.match}` }
          case "done":
            return { action: "done", reason: `Fixture done: ${entry.match}` }
          default:
            // Defensive: treat unknown actions as bail to surface misconfiguration
            return { action: "bail", reason: `Unknown fixture action: ${action}` }
        }
      },
    }
  })
}

/**
 * Merge fixture patterns with base patterns using first-match-wins
 * composition. Fixture patterns are prepended so they take precedence
 * over base patterns — a fixture can override any base behavior by
 * providing a pattern that matches first.
 *
 * @param fixturePatterns - Patterns loaded from answers.yaml (higher priority)
 * @param basePatterns - Base patterns from ANSWER_PATTERNS (lower priority)
 * @returns Combined pattern array with fixture patterns first
 */
export function mergePatterns(
  fixturePatterns: AnswerPattern[],
  basePatterns: AnswerPattern[],
): AnswerPattern[] {
  return [...fixturePatterns, ...basePatterns]
}

// ── Pattern matching ─────────────────────────────────────────

/**
 * Find the matching answer for a question text.
 * Returns a bail result if no pattern matches (unknown question).
 *
 * @param questionText - The question text to match against patterns
 * @param ctx - Answer context with vars for dynamic substitution
 * @param patterns - Optional custom pattern list (defaults to ANSWER_PATTERNS)
 */
export function findAnswer(
  questionText: string,
  ctx: AnswerContext,
  patterns: AnswerPattern[] = ANSWER_PATTERNS,
): AnswerResult {
  for (const pattern of patterns) {
    if (pattern.match.test(questionText)) {
      return pattern.answer(questionText, ctx)
    }
  }
  return { action: "bail", reason: `Unknown question: "${questionText.slice(0, 120)}"` }
}
