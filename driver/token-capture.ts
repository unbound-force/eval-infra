/**
 * Token usage accumulator for SSE event streams.
 *
 * Consumes events emitted by the OpenCode driver's onEvent callback
 * and accumulates token counts, cost, turns, and tool call metrics
 * into a snapshot-able TokenData structure.
 *
 * Event property paths use optional chaining throughout to handle
 * missing or renamed properties gracefully (RQ-1 resilience).
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
 * Event types handled:
 * - `step_finish` → accumulates token counts and cost from usage metadata
 * - `step_start` → increments turn counter (one turn per model invocation)
 * - `tool_use` → increments tool call counter
 *
 * All property access uses optional chaining to tolerate missing
 * or renamed event properties without throwing.
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

  /**
   * Process a single SSE event and accumulate relevant metrics.
   *
   * @param event - Raw SSE event object from the OpenCode driver.
   *   Shape varies by event type; all property access is guarded
   *   with optional chaining.
   */
  handleEvent(event: any): void {
    const evtType = event?.type as string | undefined
    if (!evtType) return

    const props = event?.properties ?? {}

    switch (evtType) {
      case "step_finish": {
        // Token counts live under properties.usage or properties.metadata.usage
        // depending on SDK version. Check both paths for resilience.
        const usage = props?.usage ?? props?.metadata?.usage ?? {}
        this.data.input_tokens += toNumber(usage?.input_tokens ?? usage?.inputTokens)
        this.data.output_tokens += toNumber(usage?.output_tokens ?? usage?.outputTokens)
        this.data.cache_read_tokens += toNumber(
          usage?.cache_read_tokens ?? usage?.cacheReadTokens ?? usage?.cache_read_input_tokens,
        )
        this.data.cache_creation_tokens += toNumber(
          usage?.cache_creation_tokens ?? usage?.cacheCreationTokens ?? usage?.cache_creation_input_tokens,
        )

        // Cost may be at properties.cost, properties.usage.cost, or properties.metadata.cost
        const cost = props?.cost ?? usage?.cost ?? props?.metadata?.cost
        this.data.cost_usd += toNumber(cost)
        break
      }

      case "step_start": {
        // Each step_start represents a new model invocation turn
        this.data.turns += 1
        break
      }

      case "tool_use": {
        this.data.tool_calls_count += 1
        break
      }

      // Intentionally ignore all other event types — they don't
      // carry token metrics. No default case needed per convention
      // CS-006: unhandled event types are not errors here.
    }
  }

  /** Return a defensive copy of the current accumulated data. */
  getSnapshot(): TokenData {
    return { ...this.data }
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
