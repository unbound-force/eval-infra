/**
 * LLM-as-judge quality evaluator for eval fixtures.
 *
 * Parses rubric files (YAML frontmatter + markdown criteria sections),
 * constructs a judge prompt, invokes a model via the OpenCode SDK,
 * and computes a weighted composite quality score.
 *
 * Design decisions:
 * - Single judge model call per fixture (simplicity; multi-judge with
 *   calibration deferred to future iteration per plan.md)
 * - Temperature 0.0 for deterministic scoring
 * - One retry on malformed JSON response (per spec edge case)
 * - Rubric weights are normalized if they don't sum to 1.0
 */

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

// ── Types ────────────────────────────────────────────────────

/** Parsed rubric configuration from YAML frontmatter. */
export interface RubricConfig {
  rubric_version: string
  pass_threshold: number
  weights: Record<string, number>
}

/** Result of a judge evaluation. */
export interface JudgeResult {
  composite: number
  scores: Record<string, number>
  passed: boolean
  reasoning: string
}

/** Internal parsed rubric structure. */
export interface ParsedRubric {
  config: RubricConfig
  criteria: Record<string, string>
}

// ── Rubric parsing ───────────────────────────────────────────

/**
 * Parse a rubric markdown file into config and criteria.
 *
 * Expected format:
 * ```
 * ---
 * rubric_version: "1"
 * pass_threshold: 0.50
 * weights:
 *   completeness: 0.50
 *   correctness: 0.50
 * ---
 *
 * ## completeness
 * Description of what completeness means...
 *
 * ## correctness
 * Description of what correctness means...
 * ```
 *
 * @param content - Raw markdown content of the rubric file.
 * @returns Parsed rubric with config and criteria descriptions.
 * @throws Error if frontmatter is missing or malformed.
 */
export function parseRubric(content: string): ParsedRubric {
  // Extract YAML frontmatter between --- delimiters
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    throw new Error("Rubric missing YAML frontmatter (expected --- delimiters)")
  }

  const config = parseYaml(frontmatterMatch[1]) as RubricConfig
  if (!config.rubric_version) {
    throw new Error("Rubric frontmatter missing rubric_version")
  }
  if (config.pass_threshold == null) {
    throw new Error("Rubric frontmatter missing pass_threshold")
  }
  if (!config.weights || typeof config.weights !== "object") {
    throw new Error("Rubric frontmatter missing or invalid weights")
  }

  // Parse markdown body — extract ## sections as criteria
  const body = content.slice(frontmatterMatch[0].length).trim()
  const criteria: Record<string, string> = {}

  // Split on ## headings and extract name → description
  const sections = body.split(/^## /m).filter(Boolean)
  for (const section of sections) {
    const newlineIdx = section.indexOf("\n")
    if (newlineIdx === -1) {
      // Section with heading only, no body
      const name = section.trim()
      if (name) criteria[name] = ""
      continue
    }
    const name = section.slice(0, newlineIdx).trim()
    const description = section.slice(newlineIdx + 1).trim()
    if (name) {
      criteria[name] = description
    }
  }

  return { config, criteria }
}

// ── Prompt construction ──────────────────────────────────────

/**
 * Build the judge prompt from criteria, transcript, and workdir diff.
 *
 * The prompt instructs the model to score each criterion on a 0.0-1.0 scale
 * and return structured JSON with scores and reasoning.
 */
export function buildJudgePrompt(
  criteria: Record<string, string>,
  transcript: string,
  workdirDiff: string,
): string {
  const criteriaSection = Object.entries(criteria)
    .map(([name, desc]) => `### ${name}\n${desc}`)
    .join("\n\n")

  return `You are an expert evaluator scoring an AI agent's performance.

## Scoring Criteria

${criteriaSection}

## Agent Transcript

<transcript>
${transcript.slice(0, 50_000)}
</transcript>

## Workdir Diff

<diff>
${workdirDiff.slice(0, 20_000)}
</diff>

## Instructions

Score each criterion on a scale from 0.0 to 1.0 where:
- 0.0 = completely failed
- 0.5 = partially met
- 1.0 = fully met

Return ONLY a JSON object with this exact structure (no markdown fencing, no extra text):
{
  "scores": {
    ${Object.keys(criteria).map((k) => `"${k}": <number 0.0-1.0>`).join(",\n    ")}
  },
  "reasoning": "<brief explanation of scores>"
}
`
}

// ── Model invocation ─────────────────────────────────────────

/**
 * Call the judge model and parse the JSON response.
 *
 * Uses a single-turn, no-tools, temperature 0.0 invocation.
 * Retries once on malformed JSON per spec edge case.
 *
 * @param prompt - The constructed judge prompt.
 * @param weights - Criterion weights for validation.
 * @param model - Model identifier to use for judging.
 * @returns Map of criterion name → score (0.0-1.0).
 */
export async function callJudgeModel(
  prompt: string,
  weights: Record<string, number>,
  model: string,
): Promise<{ scores: Record<string, number>; reasoning: string }> {
  // Dynamic import to avoid hard dependency when judge is not used
  const { createOpencodeClient, createOpencodeServer } = await import("@opencode-ai/sdk/v2")

  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0, // Let OS assign port
    timeout: 30_000,
  })

  try {
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: process.cwd(),
    })

    // Create a judge session
    const sessionRes = await client.session.create({ title: "judge" })
    if (!sessionRes.data) {
      throw new Error(`Failed to create judge session: ${JSON.stringify(sessionRes.error)}`)
    }
    const sessionId = (sessionRes.data as any).id as string

    // Send the prompt and collect the response
    let responseText = ""
    const sseResult = await client.event.subscribe()

    client.session.command({
      sessionID: sessionId,
      command: "chat",
      arguments: prompt,
    }).catch(() => {
      // Non-fatal — we read from SSE
    })

    let seenBusy = false
    const deadline = Date.now() + 120_000

    for await (const event of sseResult.stream) {
      if (Date.now() > deadline) break

      const evt = event as any
      const evtType = evt?.type as string | undefined
      const props = evt?.properties ?? {}

      if (!evtType) continue
      if (evtType === "server.heartbeat" || evtType === "server.connected") continue
      if (props.sessionID && props.sessionID !== sessionId) continue

      if (evtType === "session.status") {
        const statusType = props.status?.type
        if (statusType === "busy") seenBusy = true
        if (statusType === "idle" && seenBusy) break
      }
      if (evtType === "session.idle" && seenBusy) break

      // Capture assistant text
      if (evtType === "message.part" || evtType === "assistant.message") {
        responseText += props.content ?? props.text ?? ""
      }
    }

    return parseJudgeResponse(responseText, weights)
  } finally {
    server.close()
  }
}

/**
 * Parse the judge model's JSON response.
 *
 * Extracts JSON from the response text, handling potential markdown
 * code fencing. Validates that all expected criteria are present.
 */
function parseJudgeResponse(
  responseText: string,
  weights: Record<string, number>,
): { scores: Record<string, number>; reasoning: string } {
  // Strip markdown code fences if present
  let jsonText = responseText.trim()
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim()
  }

  // Try to find JSON object in the response
  const braceStart = jsonText.indexOf("{")
  const braceEnd = jsonText.lastIndexOf("}")
  if (braceStart !== -1 && braceEnd !== -1) {
    jsonText = jsonText.slice(braceStart, braceEnd + 1)
  }

  const parsed = JSON.parse(jsonText) as {
    scores: Record<string, number>
    reasoning: string
  }

  if (!parsed.scores || typeof parsed.scores !== "object") {
    throw new Error("Judge response missing 'scores' object")
  }

  // Validate all criteria are present and scores are in range
  const scores: Record<string, number> = {}
  for (const key of Object.keys(weights)) {
    const score = parsed.scores[key]
    if (score == null || typeof score !== "number") {
      throw new Error(`Judge response missing score for criterion: ${key}`)
    }
    scores[key] = Math.max(0, Math.min(1, score))
  }

  return {
    scores,
    reasoning: parsed.reasoning ?? "",
  }
}

// ── Main judge function ──────────────────────────────────────

/**
 * Orchestrate the full judge evaluation pipeline.
 *
 * Steps: parse rubric → build prompt → call model → compute composite.
 * Retries once on malformed JSON response.
 *
 * @param opts - Judge options including rubric path, transcript, diff, and model.
 * @returns JudgeResult with composite score, per-criterion scores, pass/fail, and reasoning.
 */
export async function judge(opts: {
  rubricPath: string
  transcript: string
  workdirDiff: string
  model: string
}): Promise<JudgeResult> {
  const rubricContent = readFileSync(opts.rubricPath, "utf-8")
  const { config, criteria } = parseRubric(rubricContent)

  const prompt = buildJudgePrompt(criteria, opts.transcript, opts.workdirDiff)

  // Attempt model call with one retry on malformed JSON
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { scores, reasoning } = await callJudgeModel(
        prompt,
        config.weights,
        opts.model,
      )

      // Compute weighted composite score
      const weightSum = Object.values(config.weights).reduce((a, b) => a + b, 0)
      let composite = 0
      for (const [key, weight] of Object.entries(config.weights)) {
        const normalizedWeight = weightSum > 0 ? weight / weightSum : 0
        composite += (scores[key] ?? 0) * normalizedWeight
      }

      return {
        composite,
        scores,
        passed: composite >= config.pass_threshold,
        reasoning,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt === 0) {
        // First failure — retry once per spec edge case
        continue
      }
    }
  }

  // Both attempts failed — throw the last error
  throw lastError ?? new Error("Judge evaluation failed")
}
