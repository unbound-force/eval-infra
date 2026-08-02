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
        // Count turns and tool calls from completed assistant messages.
        const info = props?.info
        if (!info || info.role !== "assistant" || !info.finish) break

        // A completed message = one turn
        // But message.updated fires twice for the same message (once with
        // finish, once with time.completed). Only count the first one
        // by checking that time.completed is set (final update).
        if (info.time?.completed) {
          this.data.turns += 1
          if (info.finish === "tool-calls") {
            // Count each tool-calling turn — the actual tool call count
            // isn't directly available per-event, but each tool-calls
            // finish represents at least one tool invocation batch.
            this.data.tool_calls_count += 1
          }
        }
        break
      }

      // Intentionally ignore all other event types — they don't
      // carry token metrics.
    }
  }

  /** Return accumulated data, computing token/cost totals from all sessions. */
  getSnapshot(): TokenData {
    // Sum token/cost totals across all sessions
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0
    for (const s of this.sessionTotals.values()) {
      input += s.input
      output += s.output
      cacheRead += s.cacheRead
      cacheWrite += s.cacheWrite
      cost += s.cost
    }

    return {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      cost_usd: cost,
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
