/**
 * Trajectory extraction for deterministic eval assertions.
 *
 * After a command finishes, the driver reads the persisted messages
 * of the root session and every descendant session (subagents spawned
 * via the task tool) and flattens them into an ordered list of tool
 * calls plus the root session's assistant text.
 *
 * Reading persisted messages (rather than reassembling SSE deltas)
 * gives one authoritative record per tool call, already carrying its
 * final state and full input.
 */

import type { TokenData } from "./token-capture.ts"

// ── Types ────────────────────────────────────────────────────

/** One tool invocation observed in the session tree. */
export interface ToolCall {
  sessionID: string
  /** Depth in the session tree — 0 for the root session. */
  depth: number
  tool: string
  status: string
  input: Record<string, unknown>
  /** Tool result text; empty until the call completes. */
  output: string
  /** Structured tool result; plugin tools put their detail here. */
  metadata: unknown
}

/** Per-session usage and timing, for attributing cost to subagents. */
export interface SessionUsage {
  sessionID: string
  depth: number
  /** Agent of the session's first assistant message. */
  agent: string
  model: string
  turns: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  /** Finish reason of the last assistant message ("stop", "length", ...); "" if none. */
  last_finish: string
  /** Characters of non-synthetic assistant text, trimmed; 0 means the session said nothing. */
  text_chars: number
  /** Epoch ms of the first message and of the last completed one. */
  started: number | null
  finished: number | null
}

/** Everything an assertion can inspect about what the agent did. */
export interface Trajectory {
  toolCalls: ToolCall[]
  /** Concatenated assistant text from the root session. */
  text: string
  sessionCount: number
  /**
   * Token usage summed over every assistant message in the session tree.
   * Authoritative: the SSE stream can end (driver stops on idle) before
   * the last message's final token update arrives.
   */
  usage: TokenData
  sessions: SessionUsage[]
}

/** Messages for one session, in the shape session.messages returns. */
export interface SessionMessages {
  sessionID: string
  depth: number
  messages: Array<{ info: any; parts: any[] }>
}

// ── Extraction ───────────────────────────────────────────────

/**
 * Flatten per-session messages into a trajectory.
 *
 * Pure — the network walk lives in {@link collectTrajectory} so this
 * can be unit tested against recorded message payloads.
 *
 * @param sessions - Messages per session, root first.
 * @returns Ordered tool calls and root assistant text.
 */
export function extractTrajectory(sessions: SessionMessages[]): Trajectory {
  const toolCalls: ToolCall[] = []
  const textParts: string[] = []
  const usage: TokenData = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    turns: 0,
    tool_calls_count: 0,
  }

  const perSession: SessionUsage[] = []

  for (const session of sessions) {
    const su: SessionUsage = {
      sessionID: session.sessionID, depth: session.depth, agent: "", model: "",
      turns: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0,
      last_finish: "", text_chars: 0, started: null, finished: null,
    }
    perSession.push(su)
    for (const message of session.messages) {
      const created = toNumber(message.info?.time?.created) || null
      const completed = toNumber(message.info?.time?.completed) || null
      if (created !== null && (su.started === null || created < su.started)) su.started = created
      if (completed !== null && (su.finished === null || completed > su.finished)) su.finished = completed
      const role = message.info?.role
      if (role === "assistant") {
        const info = message.info
        usage.turns += 1
        usage.cost_usd += toNumber(info.cost)
        usage.input_tokens += toNumber(info.tokens?.input)
        usage.output_tokens += toNumber(info.tokens?.output)
        usage.reasoning_tokens += toNumber(info.tokens?.reasoning)
        usage.cache_read_tokens += toNumber(info.tokens?.cache?.read)
        usage.cache_creation_tokens += toNumber(info.tokens?.cache?.write)
        // Same definition as TokenCapture: turns that ended in tool calls
        if (info.finish === "tool-calls") usage.tool_calls_count += 1
        if (!su.agent) su.agent = String(info.agent ?? info.mode ?? "")
        if (!su.model) su.model = [info.providerID, info.modelID].filter(Boolean).join("/")
        su.turns += 1
        su.input_tokens += toNumber(info.tokens?.input)
        su.output_tokens += toNumber(info.tokens?.output)
        su.reasoning_tokens += toNumber(info.tokens?.reasoning)
        su.cache_read_tokens += toNumber(info.tokens?.cache?.read)
        su.last_finish = String(info.finish ?? "")
      }
      for (const part of message.parts ?? []) {
        if (part?.type === "tool") {
          toolCalls.push({
            sessionID: session.sessionID,
            depth: session.depth,
            tool: String(part.tool ?? ""),
            status: String(part.state?.status ?? "unknown"),
            input: (part.state?.input ?? {}) as Record<string, unknown>,
            output: typeof part.state?.output === "string" ? part.state.output : "",
            metadata: part.state?.metadata ?? null,
          })
        } else if (part?.type === "text" && role === "assistant" && !part.synthetic) {
          const text = String(part.text ?? "")
          su.text_chars += text.trim().length
          if (session.depth === 0) textParts.push(text)
        }
      }
    }
  }

  return {
    toolCalls,
    text: textParts.join("\n"),
    sessionCount: sessions.length,
    usage,
    sessions: perSession,
  }
}

/** Coerce to a non-negative finite number (0 otherwise). */
function toNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// ── Collection ───────────────────────────────────────────────

/**
 * Walk the session tree rooted at sessionID and extract its trajectory.
 *
 * @param client - An @opencode-ai/sdk v2 client.
 * @param sessionID - Root session of the eval run.
 */
export async function collectTrajectory(
  client: any,
  sessionID: string,
): Promise<Trajectory> {
  const sessions: SessionMessages[] = []
  const queue: Array<{ id: string; depth: number }> = [{ id: sessionID, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)

    const messages = await client.session.messages({ sessionID: id })
    sessions.push({ sessionID: id, depth, messages: messages.data ?? [] })

    const children = await client.session.children({ sessionID: id })
    for (const child of children.data ?? []) {
      queue.push({ id: child.id, depth: depth + 1 })
    }
  }

  return extractTrajectory(sessions)
}
