/**
 * OpenCode driver — manages server lifecycle, session creation,
 * command execution, and event-driven completion detection.
 *
 * Uses the @opencode-ai/sdk v2 API with SSE event streams
 * to detect command completion — the same signal that drives
 * the TUI progress bar.
 *
 * Ported from scripted/opencode-driver.ts with additions:
 * - onEvent callback for external event consumers (e.g., token capture)
 * - Configurable log format (json | human)
 */

import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import type { AnswerContext, AnswerResult } from "./answers.js"
import { findAnswer } from "./answers.js"

// ── Types ────────────────────────────────────────────────────

export interface DriverOptions {
  /** Project directory the server operates on */
  projectDir: string
  /** Port for the OpenCode server (default: 4096) */
  port?: number
  /** Server startup timeout in ms (default: 30_000) */
  timeout?: number
  /**
   * Callback invoked for every SSE event received during runCommand.
   * Enables external consumers (e.g., token-capture) to observe the
   * event stream without modifying driver internals.
   */
  onEvent?: (event: any) => void
  /**
   * Log output format.
   * - "human" (default): timestamped human-readable lines
   * - "json": structured JSON lines for machine consumption
   */
  logFormat?: "json" | "human"
}

export interface CommandResult {
  success: boolean
  /** Reason for failure (bail, error, timeout) */
  reason?: string
}

/**
 * PermissionRuleset for headless sessions — allow all tool operations.
 * Without this, the server auto-rejects bash, edit, write, etc.,
 * making it impossible for the agent to commit, push, or create PRs.
 */
const ALLOW_ALL_PERMISSIONS = [
  { permission: "bash", pattern: "*", action: "allow" as const },
  { permission: "edit", pattern: "*", action: "allow" as const },
  { permission: "read", pattern: "*", action: "allow" as const },
  { permission: "write", pattern: "*", action: "allow" as const },
  { permission: "glob", pattern: "*", action: "allow" as const },
  { permission: "grep", pattern: "*", action: "allow" as const },
  { permission: "webfetch", pattern: "*", action: "allow" as const },
  { permission: "task", pattern: "*", action: "allow" as const },
  { permission: "todowrite", pattern: "*", action: "allow" as const },
  { permission: "skill", pattern: "*", action: "allow" as const },
]

// ── Driver class ─────────────────────────────────────────────

export class OpencodeDriver {
  private server: { url: string; close: () => void } | null = null
  private client: OpencodeClient | null = null
  private projectDir: string
  private port: number
  private timeout: number
  private onEvent?: (event: any) => void
  private logFn: (msg: string) => void

  constructor(opts: DriverOptions) {
    this.projectDir = opts.projectDir
    this.port = opts.port ?? 4096
    this.timeout = opts.timeout ?? 30_000
    this.onEvent = opts.onEvent
    // Configurable log format — "json" emits structured JSON lines,
    // "human" (default) emits timestamped human-readable lines.
    this.logFn = opts.logFormat === "json" ? logJson : logHuman
  }

  // ── Server lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    this.logFn("Starting OpenCode server...")
    this.server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: this.port,
      timeout: this.timeout,
    })
    this.logFn(`Server listening at ${this.server.url}`)

    this.client = createOpencodeClient({
      baseUrl: this.server.url,
      directory: this.projectDir,
    })

    // Verify health
    const health = await this.client.global.health()
    if (!health.data) {
      throw new Error("Server health check failed")
    }
    this.logFn("Server healthy")
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.logFn("Stopping OpenCode server...")
      this.server.close()
      this.server = null
      this.client = null
    }
  }

  // ── Session lifecycle ──────────────────────────────────────

  async createSession(title: string): Promise<string> {
    const c = this.requireClient()
    const res = await c.session.create({
      title,
      permission: ALLOW_ALL_PERMISSIONS,
    })
    if (!res.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(res.error)}`)
    }
    const id = (res.data as any).id as string
    this.logFn(`Created session ${id} — "${title}" (all permissions allowed)`)
    return id
  }

  // ── Command execution via SSE events ───────────────────────

  /**
   * Send a slash command and wait for completion using the SSE
   * event stream — the same signal that drives the TUI progress bar.
   *
   * The event stream emits:
   *   session.status { type: "busy" }  → command is running
   *   session.status { type: "idle" }  → command finished
   *   question.asked / question.v2.asked → needs answer
   *   permission.asked → needs approval
   *
   * We subscribe to the /event stream and filter by sessionID.
   */
  async runCommand(
    sessionID: string,
    command: string,
    args: string,
    answerCtx: AnswerContext,
    commandTimeout = 15 * 60_000,
  ): Promise<CommandResult> {
    const c = this.requireClient()

    this.logFn(`Sending /${command} ${args.slice(0, 80)}...`)

    // Subscribe to SSE events — must create a new subscription per
    // command because the async generator is consumed and exhausted
    // when we break out of the for-await loop.
    const sseResult = await c.event.subscribe()

    // Fire the command without awaiting — session.command() blocks
    // until the agent finishes, but we want to process SSE events
    // concurrently. The SSE stream tells us when it's done.
    c.session.command({
      sessionID,
      command,
      arguments: args,
    }).catch((err: unknown) => {
      this.logFn(`Command error (non-fatal): ${err}`)
    })

    // Process events until we see session.status { type: "idle" }
    // for our session, which means the command completed.
    // This is the same signal that drives the TUI progress bar.
    const deadline = Date.now() + commandTimeout
    let seenBusy = false

    this.logFn("Waiting for SSE events...")
    try {
      for await (const event of sseResult.stream) {
        // Emit every event to the external callback for consumers
        // like token-capture that need the full event stream.
        this.onEvent?.(event)

        if (Date.now() > deadline) {
          return { success: false, reason: `Timeout after ${commandTimeout / 1000}s` }
        }

        // Events have shape: { id, type, properties: { sessionID?, ... } }
        const evt = event as any
        const evtType = evt?.type as string | undefined
        const props = evt?.properties ?? {}

        // Skip heartbeats and non-session events
        if (!evtType || evtType === "server.heartbeat" || evtType === "server.connected") continue

        // Filter to our session
        if (props.sessionID && props.sessionID !== sessionID) continue

        switch (evtType) {
          case "session.status": {
            const statusType = props.status?.type
            if (statusType === "busy") {
              if (!seenBusy) this.logFn("Session busy — processing")
              seenBusy = true
            } else if (statusType === "idle") {
              if (seenBusy) {
                this.logFn("Session idle — command complete")
                return { success: true }
              }
              // Haven't seen busy yet — might be a stale idle, keep waiting
            } else if (statusType === "retry") {
              seenBusy = true
              this.logFn(`Session retrying: ${props.status?.message ?? ""}`)
            }
            break
          }

          case "session.idle": {
            if (seenBusy) {
              this.logFn("Session idle (dedicated event) — command complete")
              return { success: true }
            }
            break
          }

          case "question.asked":
          case "question.v2.asked": {
            seenBusy = true
            const result = await this.handleQuestion(c, props, answerCtx)
            if (result?.action === "bail") {
              return { success: false, reason: result.reason }
            }
            break
          }

          case "permission.asked":
          case "permission.v2.asked": {
            seenBusy = true
            await this.handlePermission(c, props)
            break
          }
        }
      }
    } finally {
      // SSE stream cleanup — the for-await loop handles this
    }

    return { success: false, reason: "SSE stream ended unexpectedly" }
  }

  // ── Question handling ──────────────────────────────────────

  private async handleQuestion(
    c: OpencodeClient,
    props: any,
    answerCtx: AnswerContext,
  ): Promise<AnswerResult | null> {
    const requestID = props.id
    if (!requestID) return null

    // Get the question text
    const questions = props.questions ?? []
    const firstQuestion = questions[0]
    const questionText = firstQuestion?.question ?? ""
    const header = firstQuestion?.header ?? ""
    const options = firstQuestion?.options ?? []

    const optionLabels = options.map((o: any) => o.label).join(", ")
    this.logFn(`Question: [${header}] ${questionText.slice(0, 200)}`)
    if (optionLabels) this.logFn(`  Options: ${optionLabels}`)

    // Find the answer — match against both header and question text
    const matchText = header ? `${header}: ${questionText}` : questionText
    const result = findAnswer(matchText, answerCtx)

    if (result.action === "bail") {
      this.logFn(`Bailing: ${result.reason}`)
      await c.question.reject({ requestID })
      return result
    }

    if (result.action === "done") {
      // Pick "Done" or "Recommended" or first option
      const doneLabel = options.find(
        (o: any) => /\bdone\b/i.test(o.label),
      )?.label
      const recommendedLabel = options.find(
        (o: any) => /recommended/i.test(o.label),
      )?.label
      const terminalLabel = doneLabel ?? recommendedLabel ?? options[0]?.label ?? "Done for now"
      this.logFn(`Phase done: selecting "${terminalLabel}" — ${result.reason}`)
      await c.question.reply({
        requestID,
        answers: [[terminalLabel]],
      })
      return result
    }

    // Reply with the matched answer
    this.logFn(`Answering: ${JSON.stringify(result.labels)}`)
    await c.question.reply({
      requestID,
      answers: result.labels,
    })
    return result
  }

  // ── Permission handling ────────────────────────────────────

  private async handlePermission(
    c: OpencodeClient,
    props: any,
  ): Promise<void> {
    const requestID = props.id
    if (!requestID) return

    const permission = props.permission ?? "unknown"
    const patterns = props.patterns ?? []
    this.logFn(`Permission: auto-approving ${permission} (${patterns.join(", ")})`)
    await c.permission.reply({
      requestID,
      reply: "once",
    })
  }

  // ── Helpers ────────────────────────────────────────────────

  private requireClient(): OpencodeClient {
    if (!this.client) {
      throw new Error("Driver not started — call start() first")
    }
    return this.client
  }
}

// ── Utilities ────────────────────────────────────────────────

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Human-readable log line with HH:MM:SS timestamp prefix.
 * Default log format for interactive / local dev usage.
 */
export function logHuman(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

/**
 * Structured JSON log line for machine consumption.
 * Emits { ts, msg } on a single line for easy parsing.
 */
export function logJson(msg: string): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg }))
}

/**
 * Default log function — human-readable format.
 * Exported for backward compatibility with callers that
 * import `log` directly.
 */
export const log = logHuman
