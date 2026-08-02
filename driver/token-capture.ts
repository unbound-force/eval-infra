/**
 * Token usage accumulator for SSE event streams.
 *
 * Consumes events emitted by the OpenCode SDK v2 driver's onEvent
 * callback and extracts cumulative token counts, cost, turns, and
 * tool call metrics into a snapshot-able TokenData structure.
 *
 * The SDK v2 SSE stream uses these event types (not step_finish/step_start):
 * - `session.updated` → carries cumulative session-level token/cost totals
 * - `message.updated` → carries per-message token/cost with `finish` field
 *     when a model turn completes (`finish: "end-turn"` or `"tool-calls"`)
 *
 * We track the **latest session.updated totals** for the primary session
 * (not sub-sessions), which gives us the cumulative cost and tokens
 * across all turns. For turns and tool calls, we count completed
 * message.updated events with a `finish` field.
 */

// ── Types ────────────────────────────────────────────────────

/** Accumulated token usage metrics for a single eval run. */
export interface TokenData {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
  turns: number
  tool_calls_count: number
}

// ── TokenCapture class ───────────────────────────────────────

/**
 * Accumulates token usage data from SSE events emitted during
 * an OpenCode session. Designed to be wired into the driver's
 * `onEvent` callback.
 *
 * Uses session.updated events for cumulative token/cost totals
 * and message.updated events with `finish` field for turn/tool counting.
 */
export class TokenCapture {
  private data: TokenData = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    turns: 0,
    tool_calls_count: 0,
  }

  /** Track processed message IDs to avoid double-counting */
  private seenMessageIds = new Set<string>()

  /** Per-session cumulative totals from session.updated events */
  private sessionTotals = new Map<string, {
    cost: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    parentID: string | null
  }>()

  /**
   * Process a single SSE event and accumulate relevant metrics.
   *
   * @param event - Raw SSE event object from the OpenCode SDK v2.
   */
  handleEvent(event: any): void {
    const evtType = event?.type as string | undefined
    if (!evtType) return

    const props = event?.properties ?? {}

    switch (evtType) {
      case "session.updated": {
        // session.updated carries cumulative totals per session.
        // Sub-sessions (e.g., constitution-check agent) have their own
        // cumulative totals. We track all sessions and sum their
        // latest totals in getSnapshot().
        const info = props?.info
        if (!info?.id) break

        this.sessionTotals.set(info.id, {
          cost: toNumber(info.cost),
          input: toNumber(info.tokens?.input),
          output: toNumber(info.tokens?.output),
          cacheRead: toNumber(info.tokens?.cache?.read),
          cacheWrite: toNumber(info.tokens?.cache?.write),
          parentID: info.parentID ?? null,
        })
        break
      }

      case "message.updated": {
        // message.updated with a `finish` field means a model turn completed.
        // These events carry per-message token/cost data.
        const info = props?.info
        if (!info || info.role !== "assistant" || !info.finish) break

        // Only process the final update (time.completed is set).
        // message.updated fires multiple times per message — once with
        // finish, then again with time.completed.
        if (info.time?.completed) {
          this.data.turns += 1
          if (info.finish === "tool-calls") {
            this.data.tool_calls_count += 1
          }

          // Extract per-message token data as a fallback/supplement.
          // Track per-message ID to avoid double-counting.
          const msgId = info.id as string | undefined
          if (msgId && !this.seenMessageIds.has(msgId)) {
            this.seenMessageIds.add(msgId)
            this.data.cost_usd += toNumber(info.cost)
            this.data.input_tokens += toNumber(info.tokens?.input)
            this.data.output_tokens += toNumber(info.tokens?.output)
            this.data.cache_read_tokens += toNumber(info.tokens?.cache?.read)
            this.data.cache_creation_tokens += toNumber(info.tokens?.cache?.write)
          }
        }
        break
      }

      // Intentionally ignore all other event types — they don't
      // carry token metrics.
    }
  }

  /** Return accumulated data using best available source for token/cost data. */
  getSnapshot(): TokenData {
    // Session-level totals (from session.updated — newer opencode versions)
    let sesInput = 0, sesOutput = 0, sesCacheRead = 0, sesCacheWrite = 0, sesCost = 0
    for (const s of this.sessionTotals.values()) {
      sesInput += s.input
      sesOutput += s.output
      sesCacheRead += s.cacheRead
      sesCacheWrite += s.cacheWrite
      sesCost += s.cost
    }

    // Message-level totals (from message.updated — works across versions)
    const msgInput = this.data.input_tokens
    const msgOutput = this.data.output_tokens
    const msgCacheRead = this.data.cache_read_tokens
    const msgCacheWrite = this.data.cache_creation_tokens
    const msgCost = this.data.cost_usd

    // Use whichever source has data (prefer session-level if both have data)
    const hasSessionData = sesCost > 0 || sesInput > 0 || sesOutput > 0
    const hasMessageData = msgCost > 0 || msgInput > 0 || msgOutput > 0

    return {
      input_tokens: hasSessionData ? sesInput : msgInput,
      output_tokens: hasSessionData ? sesOutput : msgOutput,
      cache_read_tokens: hasSessionData ? sesCacheRead : msgCacheRead,
      cache_creation_tokens: hasSessionData ? sesCacheWrite : msgCacheWrite,
      cost_usd: hasSessionData ? sesCost : msgCost,
      turns: this.data.turns,
      tool_calls_count: this.data.tool_calls_count,
    }
  }

  /** Reset all counters to zero for reuse across fixtures. */
  reset(): void {
    this.data = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
      turns: 0,
      tool_calls_count: 0,
    }
    this.sessionTotals.clear()
    this.seenMessageIds.clear()
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Safely coerce a value to a non-negative number.
 * Returns 0 for null, undefined, NaN, or negative values.
 */
function toNumber(value: unknown): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}
