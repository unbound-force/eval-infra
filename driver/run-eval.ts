/**
 * CLI entrypoint for the eval driver.
 *
 * Discovers fixtures, executes each against an opencode session,
 * captures token usage metrics, stores results in SQLite, and
 * generates a markdown summary report.
 *
 * Usage:
 *   bun run-eval.ts --fixtures ../.eval/fixtures \
 *     --model google-vertex-anthropic/claude-opus-4-6@default \
 *     --repo jflowers/eval-infra \
 *     --output ../eval-out
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { Glob } from "bun"

import { OpencodeDriver } from "./opencode-driver.ts"
import {
  ANSWER_PATTERNS,
  loadFixtureAnswers,
  mergePatterns,
  type AnswerContext,
  type AnswerPattern,
} from "./answers.ts"
import { TokenCapture } from "./token-capture.ts"
import { fingerprint, type FingerprintParts } from "./fingerprint.ts"
import {
  initDb,
  insertRun,
  exportBaseline,
  getLatestRun,
  getRunHistory,
  type Run,
} from "./store.ts"
import {
  loadBaseline,
  compareRun,
  compareAllRuns,
  type ComparisonSummary,
} from "./baseline.ts"
import { judge } from "./judge.ts"
import { formatDryRunTable, type DryRunEntry } from "./dry-run-utils.ts"

// ── Types ────────────────────────────────────────────────────

/** Parsed task.yaml fixture metadata. */
interface TaskConfig {
  task_id: string
  task_version: string
  description: string
  exec_mode: string
  command: string
  timeout_seconds: number
}

/** Parsed answers.yaml fixture structure. */
interface AnswersConfig {
  patterns: Array<{
    match: string
    action: string
    labels?: string[][]
  }>
}

/** Parsed CLI arguments. */
interface CliArgs {
  fixtures: string
  baseline: string
  model: string
  profile: string
  profiles: string[]
  repo: string
  gitSha: string
  gitBranch: string
  output: string
  timeout: number
  exportBaseline: boolean
  dryRun: boolean
  epsilon: number
  tolerance: number
}

/** Profile configuration loaded from profiles/<name>.json. */
interface ProfileConfig {
  description: string
  config_override: Record<string, unknown>
}

// ── Arg parsing ──────────────────────────────────────────────

/**
 * Parse CLI arguments from process.argv.
 *
 * Uses manual parsing — no external arg parsing library needed
 * per spec guidance. Supports --flag value and --flag=value forms.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixtures: ".eval/fixtures",
    baseline: "",
    model: "google-vertex-anthropic/claude-opus-4-6@default",
    profile: "baseline",
    profiles: [],
    repo: "",
    gitSha: "",
    gitBranch: "",
    output: "eval-out",
    timeout: 900,
    exportBaseline: false,
    dryRun: false,
    epsilon: 0.10,
    tolerance: 0.05,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]

    switch (arg) {
      case "--fixtures":
        args.fixtures = next ?? args.fixtures
        i++
        break
      case "--baseline":
        args.baseline = next ?? args.baseline
        i++
        break
      case "--model":
        args.model = next ?? args.model
        i++
        break
      case "--profile":
        args.profile = next ?? args.profile
        i++
        break
      case "--profiles":
        // Comma-separated list of profile names for matrix mode
        args.profiles = (next ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        i++
        break
      case "--repo":
        args.repo = next ?? args.repo
        i++
        break
      case "--git-sha":
        args.gitSha = next ?? args.gitSha
        i++
        break
      case "--git-branch":
        args.gitBranch = next ?? args.gitBranch
        i++
        break
      case "--output":
        args.output = next ?? args.output
        i++
        break
      case "--timeout":
        args.timeout = Number(next) || args.timeout
        i++
        break
      case "--epsilon":
        args.epsilon = Number(next) || args.epsilon
        i++
        break
      case "--tolerance":
        args.tolerance = Number(next) || args.tolerance
        i++
        break
      case "--export-baseline":
        args.exportBaseline = true
        break
      case "--dry-run":
        args.dryRun = true
        break
    }
  }

  return args
}

// ── Fixture discovery ────────────────────────────────────────

/**
 * Discover fixture directories by globbing for task.yaml files.
 *
 * @param fixturesDir - Root directory to search for fixtures.
 * @returns Array of absolute paths to fixture directories.
 */
async function discoverFixtures(fixturesDir: string): Promise<string[]> {
  const glob = new Glob("**/task.yaml")
  const fixtureDirs: string[] = []

  for await (const match of glob.scan({ cwd: fixturesDir, absolute: true })) {
    fixtureDirs.push(dirname(match))
  }

  // Sort for deterministic execution order
  fixtureDirs.sort()
  return fixtureDirs
}

// ── Profile loading ──────────────────────────────────────────

/**
 * Load a profile configuration from profiles/<name>.json.
 *
 * Searches for the profile file relative to the driver directory,
 * then relative to the project root (one level up from driver/).
 *
 * @param profileName - Profile name (e.g., "baseline", "dcp-soft").
 * @returns The parsed profile config, or null if not found.
 */
function loadProfile(profileName: string): ProfileConfig | null {
  // Try relative to driver/ first, then project root
  const candidates = [
    join(process.cwd(), "profiles", `${profileName}.json`),
    join(process.cwd(), "..", "profiles", `${profileName}.json`),
    resolve("profiles", `${profileName}.json`),
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8")
      return JSON.parse(raw) as ProfileConfig
    }
  }

  return null
}

/**
 * Apply a profile's config_override to the environment.
 *
 * Sets OPENCODE_CONFIG_CONTENT env var with the serialized config
 * override, which takes higher precedence than file-based config
 * per the design decision in plan.md.
 *
 * @param profile - The profile configuration to apply.
 */
function applyProfile(profile: ProfileConfig): void {
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(profile.config_override)
}

/**
 * Clear any previously applied profile from the environment.
 */
function clearProfile(): void {
  delete process.env.OPENCODE_CONFIG_CONTENT
}

// ── Fixture execution ────────────────────────────────────────

/**
 * Execute a single fixture and return the run record.
 *
 * Orchestrates: parse task → load prompt → load answers → start driver →
 * create session → send command → capture metrics → compute fingerprint →
 * run judge (if rubric exists) → build run record.
 */
async function executeFixture(
  fixtureDir: string,
  args: CliArgs,
  db: ReturnType<typeof initDb>,
  profileOverride?: string,
): Promise<Run> {
  const activeProfile = profileOverride ?? args.profile
  const fixtureName = basename(fixtureDir)
  const runId = randomUUID()
  const timestamp = new Date().toISOString()

  // Parse task.yaml
  const taskPath = join(fixtureDir, "task.yaml")
  const taskRaw = readFileSync(taskPath, "utf-8")
  const task = parseYaml(taskRaw) as TaskConfig

  // Read prompt.md
  const promptPath = join(fixtureDir, "prompt.md")
  const prompt = readFileSync(promptPath, "utf-8").trim()

  // Load answers — merge fixture overrides with base patterns
  const answersPath = join(fixtureDir, "answers.yaml")
  let patterns: AnswerPattern[] = ANSWER_PATTERNS
  if (existsSync(answersPath)) {
    const answersRaw = readFileSync(answersPath, "utf-8")
    const answersConfig = parseYaml(answersRaw) as AnswersConfig
    if (answersConfig?.patterns && Array.isArray(answersConfig.patterns) && answersConfig.patterns.length > 0) {
      const fixturePatterns = loadFixtureAnswers(answersPath)
      patterns = mergePatterns(fixturePatterns, ANSWER_PATTERNS)
    }
  }

  const answerCtx: AnswerContext = { vars: {} }

  // Determine rubric version (or "none" if no rubric)
  const rubricPath = join(fixtureDir, "rubric.md")
  let rubricVersion = "none"
  if (existsSync(rubricPath)) {
    const rubricRaw = readFileSync(rubricPath, "utf-8")
    const frontmatterMatch = rubricRaw.match(/^---\n([\s\S]*?)\n---/)
    if (frontmatterMatch) {
      const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
      rubricVersion = String(frontmatter?.rubric_version ?? "none")
    }
  }

  // Compute fingerprint
  const fpParts: FingerprintParts = {
    task_id: task.task_id,
    task_version: task.task_version,
    rubric_version: rubricVersion,
    profile_id: activeProfile,
    model: args.model,
  }
  const fp = fingerprint(fpParts)

  // Get opencode version
  const opencodeVersion = getOpencodeVersion()

  // Create token capture
  const tokenCapture = new TokenCapture()

  // Collect transcript for judge evaluation
  let transcript = ""

  // Create and start driver
  const driver = new OpencodeDriver({
    projectDir: process.cwd(),
    onEvent: (event: any) => {
      tokenCapture.handleEvent(event)
      // Capture assistant messages for judge transcript
      const evtType = event?.type as string | undefined
      const props = event?.properties ?? {}
      if (evtType === "message.part" || evtType === "assistant.message") {
        transcript += props.content ?? props.text ?? ""
      }
    },
    logFormat: "human",
  })

  let exitStatus = "success"
  let errorMessage: string | null = null
  const startTime = Date.now()

  try {
    log(`[${fixtureName}] Starting driver...`)
    await driver.start()

    log(`[${fixtureName}] Creating session...`)
    const sessionId = await driver.createSession(`eval: ${task.task_id}`)

    log(`[${fixtureName}] Running /${task.command} ...`)
    const commandTimeout = (task.timeout_seconds ?? args.timeout) * 1000
    const result = await driver.runCommand(
      sessionId,
      task.command,
      prompt,
      answerCtx,
      commandTimeout,
    )

    if (!result.success) {
      exitStatus = result.reason?.includes("Timeout") ? "timeout" : "bail"
      errorMessage = result.reason ?? "Command failed"
    }
  } catch (err: unknown) {
    exitStatus = "error"
    errorMessage = err instanceof Error ? err.message : String(err)
    log(`[${fixtureName}] Error: ${errorMessage}`)
  } finally {
    await driver.stop()
  }

  const durationS = (Date.now() - startTime) / 1000

  // Capture workdir diff
  const { diffText, diffBytes } = captureWorkdirDiff(fixtureDir)

  // Get token snapshot
  const tokens = tokenCapture.getSnapshot()

  // Run judge if rubric exists (T029)
  let compositeScore: number | null = null
  let scoresJson: string | null = null

  if (existsSync(rubricPath) && exitStatus === "success") {
    try {
      log(`[${fixtureName}] Running judge evaluation...`)
      const judgeResult = await judge({
        rubricPath,
        transcript,
        workdirDiff: diffText,
        model: args.model,
      })
      compositeScore = judgeResult.composite
      scoresJson = JSON.stringify(judgeResult.scores)
      log(`[${fixtureName}] Judge: composite=${judgeResult.composite.toFixed(2)}, passed=${judgeResult.passed}`)
    } catch (err: unknown) {
      // Judge failure is non-fatal — record null scores with error
      const judgeError = err instanceof Error ? err.message : String(err)
      log(`[${fixtureName}] Judge failed: ${judgeError}`)
      errorMessage = errorMessage
        ? `${errorMessage}; Judge: ${judgeError}`
        : `Judge: ${judgeError}`
    }
  }

  // Build run record
  const run: Run = {
    run_id: runId,
    timestamp,
    fingerprint: fp,
    repo: args.repo,
    git_sha: args.gitSha || null,
    git_branch: args.gitBranch || null,
    command_name: task.command,
    task_id: task.task_id,
    task_version: task.task_version,
    rubric_version: rubricVersion,
    profile_id: activeProfile,
    model: args.model,
    opencode_version: opencodeVersion,
    exit_status: exitStatus,
    error_message: errorMessage,
    composite_score: compositeScore,
    scores_json: scoresJson,
    cost_usd: tokens.cost_usd,
    duration_s: durationS,
    turns: tokens.turns,
    tool_calls_count: tokens.tool_calls_count,
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    cache_read_tokens: tokens.cache_read_tokens,
    cache_creation_tokens: tokens.cache_creation_tokens,
    diff_bytes: diffBytes,
    workdir_diff: diffText,
  }

  // Store in database
  insertRun(db, run)
  log(`[${fixtureName}] Run ${runId} stored (${exitStatus})`)

  return run
}

// ── Summary generation ───────────────────────────────────────

/**
 * Generate an eval-summary.md markdown report from run results.
 *
 * Includes a header with run metadata, per-fixture results table,
 * optional baseline comparison section, and optional drift indicators.
 */
function generateSummary(
  runs: Run[],
  args: CliArgs,
  comparisonSummary?: ComparisonSummary,
  db?: ReturnType<typeof initDb>,
): string {
  const lines: string[] = []

  lines.push("# Eval Summary")
  lines.push("")
  lines.push(`| Field | Value |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Timestamp | ${new Date().toISOString()} |`)
  lines.push(`| Repo | ${args.repo} |`)
  lines.push(`| Git SHA | ${args.gitSha || "N/A"} |`)
  lines.push(`| Git Branch | ${args.gitBranch || "N/A"} |`)
  lines.push(`| Model | ${args.model} |`)
  lines.push(`| Profile | ${args.profiles.length > 0 ? args.profiles.join(", ") : args.profile} |`)
  lines.push("")

  // Results table
  lines.push("## Results")
  lines.push("")
  lines.push(
    "| Fixture | Profile | Status | Cost ($) | Input Tokens | Output Tokens | Cache Read | Cache Create | Turns | Tool Calls | Duration (s) | Quality |",
  )
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  )

  let totalCost = 0
  for (const run of runs) {
    const cost = run.cost_usd ?? 0
    totalCost += cost
    const quality = run.composite_score != null
      ? run.composite_score.toFixed(2)
      : "N/A"

    lines.push(
      `| ${run.task_id} | ${run.profile_id} | ${run.exit_status} | ${cost.toFixed(4)} | ${run.input_tokens ?? 0} | ${run.output_tokens ?? 0} | ${run.cache_read_tokens ?? 0} | ${run.cache_creation_tokens ?? 0} | ${run.turns ?? 0} | ${run.tool_calls_count ?? 0} | ${(run.duration_s ?? 0).toFixed(1)} | ${quality} |`,
    )
  }

  lines.push("")
  lines.push(`**Total Cost**: $${totalCost.toFixed(4)}`)
  lines.push("")

  // Drift indicators (T032) — show delta from previous run when history exists
  if (db) {
    const driftLines = generateDriftSection(runs, db)
    if (driftLines.length > 0) {
      lines.push(...driftLines)
    }
  }

  // Baseline comparison section (T019)
  if (comparisonSummary) {
    lines.push("## Baseline Comparison")
    lines.push("")
    lines.push(`**Overall**: ${comparisonSummary.overall === "pass" ? "✅ PASS" : "❌ FAIL"}`)
    lines.push("")
    lines.push("| Fingerprint | Status | Details |")
    lines.push("| --- | --- | --- |")

    for (const [fp, result] of comparisonSummary.results) {
      const statusIcon = result.status === "pass" ? "✅"
        : result.status === "regression" ? "❌"
        : result.status === "improvement" ? "📈"
        : "⚠️"
      lines.push(
        `| ${fp.slice(0, 12)}... | ${statusIcon} ${result.status} | ${result.details.join("; ")} |`,
      )
    }
    lines.push("")
  }

  // Profile comparison matrix (T035)
  if (args.profiles.length > 1) {
    const matrixLines = generateProfileMatrix(runs, args.profiles)
    lines.push(...matrixLines)
  }

  // Ensure trailing newline for valid GFM
  return lines.join("\n") + "\n"
}

/**
 * Generate drift indicators section comparing current runs to previous runs.
 *
 * Shows cost and quality deltas from the most recent historical run
 * for each fingerprint, enabling trend detection.
 */
function generateDriftSection(
  runs: Run[],
  db: ReturnType<typeof initDb>,
): string[] {
  const lines: string[] = []
  const driftData: Array<{
    taskId: string
    costDelta: number | null
    qualityDelta: number | null
  }> = []

  for (const run of runs) {
    // Get the second-most-recent run (the one before the current run)
    const history = getRunHistory(db, run.fingerprint, 2)
    // history[0] is the most recent (which is the current run we just inserted)
    // history[1] is the previous run (if it exists)
    const previousRun = history.length > 1 ? history[1] : null

    if (previousRun) {
      const currentCost = run.cost_usd ?? 0
      const prevCost = previousRun.cost_usd ?? 0
      const costDelta = prevCost > 0 ? currentCost - prevCost : null

      const currentQuality = run.composite_score
      const prevQuality = previousRun.composite_score
      const qualityDelta = currentQuality != null && prevQuality != null
        ? currentQuality - prevQuality
        : null

      driftData.push({ taskId: run.task_id, costDelta, qualityDelta })
    }
  }

  if (driftData.length > 0) {
    lines.push("## Drift Indicators")
    lines.push("")
    lines.push("| Fixture | Cost Delta ($) | Quality Delta |")
    lines.push("| --- | --- | --- |")

    for (const d of driftData) {
      const costStr = d.costDelta != null
        ? `${d.costDelta >= 0 ? "+" : ""}${d.costDelta.toFixed(4)}`
        : "N/A"
      const qualStr = d.qualityDelta != null
        ? `${d.qualityDelta >= 0 ? "+" : ""}${d.qualityDelta.toFixed(2)}`
        : "N/A"
      lines.push(`| ${d.taskId} | ${costStr} | ${qualStr} |`)
    }
    lines.push("")
  }

  return lines
}

/**
 * Generate a profile comparison matrix for multi-profile runs.
 *
 * Produces a side-by-side table with rows = fixtures, columns = profiles × metrics.
 */
function generateProfileMatrix(
  runs: Run[],
  profileNames: string[],
): string[] {
  const lines: string[] = []

  lines.push("## Profile Comparison Matrix")
  lines.push("")

  // Build header
  const headerParts = ["| Fixture"]
  const separatorParts = ["| ---"]
  for (const profile of profileNames) {
    headerParts.push(`| ${profile} Cost ($)`, `| ${profile} Tokens`, `| ${profile} Quality`, `| ${profile} Duration (s)`)
    separatorParts.push("| ---", "| ---", "| ---", "| ---")
  }
  headerParts.push("|")
  separatorParts.push("|")
  lines.push(headerParts.join(" "))
  lines.push(separatorParts.join(" "))

  // Group runs by task_id
  const byTask = new Map<string, Map<string, Run>>()
  for (const run of runs) {
    if (!byTask.has(run.task_id)) {
      byTask.set(run.task_id, new Map())
    }
    byTask.get(run.task_id)!.set(run.profile_id, run)
  }

  // Build rows
  for (const [taskId, profileRuns] of byTask) {
    const rowParts = [`| ${taskId}`]
    for (const profile of profileNames) {
      const run = profileRuns.get(profile)
      if (run) {
        rowParts.push(
          `| ${(run.cost_usd ?? 0).toFixed(4)}`,
          `| ${(run.input_tokens ?? 0) + (run.output_tokens ?? 0)}`,
          `| ${run.composite_score != null ? run.composite_score.toFixed(2) : "N/A"}`,
          `| ${(run.duration_s ?? 0).toFixed(1)}`,
        )
      } else {
        rowParts.push("| -", "| -", "| -", "| -")
      }
    }
    rowParts.push("|")
    lines.push(rowParts.join(" "))
  }

  lines.push("")
  return lines
}

// ── Dry-run mode ─────────────────────────────────────────────

/**
 * Execute dry-run mode: discover fixtures, compute fingerprints,
 * query historical costs, output estimation table.
 *
 * Does NOT execute any opencode sessions.
 */
async function executeDryRun(
  fixtureDirs: string[],
  args: CliArgs,
  db: ReturnType<typeof initDb>,
): Promise<void> {
  log("[dry-run] Computing cost estimates from historical data...")

  const entries: DryRunEntry[] = []

  for (const fixtureDir of fixtureDirs) {
    const taskPath = join(fixtureDir, "task.yaml")
    const taskRaw = readFileSync(taskPath, "utf-8")
    const task = parseYaml(taskRaw) as TaskConfig

    // Determine rubric version
    const rubricPath = join(fixtureDir, "rubric.md")
    let rubricVersion = "none"
    if (existsSync(rubricPath)) {
      const rubricRaw = readFileSync(rubricPath, "utf-8")
      const frontmatterMatch = rubricRaw.match(/^---\n([\s\S]*?)\n---/)
      if (frontmatterMatch) {
        const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
        rubricVersion = String(frontmatter?.rubric_version ?? "none")
      }
    }

    const fpParts: FingerprintParts = {
      task_id: task.task_id,
      task_version: task.task_version,
      rubric_version: rubricVersion,
      profile_id: args.profile,
      model: args.model,
    }
    const fp = fingerprint(fpParts)

    // Query historical data
    const latestRun = getLatestRun(db, fp)

    if (latestRun) {
      entries.push({
        taskId: task.task_id,
        fingerprint: fp,
        estimatedCost: latestRun.cost_usd,
        estimatedTokens: (latestRun.input_tokens ?? 0) + (latestRun.output_tokens ?? 0),
        source: "historical",
      })
    } else {
      entries.push({
        taskId: task.task_id,
        fingerprint: fp,
        estimatedCost: null,
        estimatedTokens: null,
        source: "no estimate available",
      })
    }
  }

  const table = formatDryRunTable(entries)
  console.log(table)

  // Also write to output directory
  const summaryPath = join(args.output, "eval-summary.md")
  writeFileSync(summaryPath, table)
  log(`[dry-run] Estimate written to ${summaryPath}`)
}

// ── Helpers ──────────────────────────────────────────────────

/** Capture the workdir diff via git diff. */
function captureWorkdirDiff(
  _fixtureDir: string,
): { diffText: string; diffBytes: number } {
  try {
    const diff = execSync("git diff", { encoding: "utf-8", timeout: 10_000 })
    return { diffText: diff, diffBytes: Buffer.byteLength(diff, "utf-8") }
  } catch {
    // No git repo or git diff failed — valid result per edge case spec
    return { diffText: "", diffBytes: 0 }
  }
}

/** Get the installed opencode version, or "unknown" if not available. */
function getOpencodeVersion(): string {
  try {
    const version = execSync("opencode --version 2>/dev/null || echo unknown", {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
    return version || "unknown"
  } catch {
    return "unknown"
  }
}

/** Simple timestamped log output. */
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  log("Eval driver starting")
  log(`  Fixtures: ${args.fixtures}`)
  log(`  Model: ${args.model}`)
  log(`  Profile: ${args.profiles.length > 0 ? args.profiles.join(", ") : args.profile}`)
  log(`  Repo: ${args.repo}`)
  log(`  Output: ${args.output}`)

  // Ensure output directory exists
  if (!existsSync(args.output)) {
    mkdirSync(args.output, { recursive: true })
  }

  // Initialize database
  const dbPath = join(args.output, "runs.db")
  const db = initDb(dbPath)
  log(`Database initialized at ${dbPath}`)

  // Discover fixtures
  const fixtureDirs = await discoverFixtures(args.fixtures)
  if (fixtureDirs.length === 0) {
    log(`No fixtures found in ${args.fixtures}`)
    process.exit(1)
  }
  log(`Found ${fixtureDirs.length} fixture(s)`)

  // Dry-run mode (T036) — estimate costs without executing
  if (args.dryRun) {
    await executeDryRun(fixtureDirs, args, db)
    db.close()
    process.exit(0)
  }

  // Load and apply profile if specified (T026)
  if (args.profiles.length === 0 && args.profile !== "baseline") {
    const profile = loadProfile(args.profile)
    if (profile) {
      log(`Loaded profile: ${args.profile} — ${profile.description}`)
      applyProfile(profile)
    } else {
      log(`Warning: Profile '${args.profile}' not found, using default config`)
    }
  }

  // Determine profile list for execution
  const profilesToRun = args.profiles.length > 0 ? args.profiles : [args.profile]

  // Execute each fixture against each profile (T034 matrix mode)
  const runs: Run[] = []
  for (const profileName of profilesToRun) {
    // Load and apply profile for this iteration
    if (args.profiles.length > 0) {
      const profile = loadProfile(profileName)
      if (profile) {
        log(`\n── Profile: ${profileName} — ${profile.description} ──`)
        applyProfile(profile)
      } else {
        log(`\n── Profile: ${profileName} (not found, using default) ──`)
        clearProfile()
      }
    }

    for (const fixtureDir of fixtureDirs) {
      const fixtureName = basename(fixtureDir)
      log(`\n── Fixture: ${fixtureName} (profile: ${profileName}) ──`)

      const run = await executeFixture(
        fixtureDir,
        args,
        db,
        args.profiles.length > 0 ? profileName : undefined,
      )
      runs.push(run)
    }
  }

  // Clear profile env after execution
  clearProfile()

  // Export baseline if requested (T020)
  if (args.exportBaseline) {
    const baselineData = exportBaseline(db)
    const baselinePath = join(args.output, "baseline.json")
    writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2))
    log(`Baseline exported to ${baselinePath}`)
  }

  // Baseline comparison (T019)
  let comparisonSummary: ComparisonSummary | undefined
  if (args.baseline && existsSync(args.baseline)) {
    log("Running baseline comparison...")
    const baselineData = loadBaseline(args.baseline)
    comparisonSummary = compareAllRuns(runs, baselineData, {
      epsilon: args.epsilon,
      tolerance: args.tolerance,
    })
    log(`Baseline comparison: ${comparisonSummary.overall}`)

    for (const [fp, result] of comparisonSummary.results) {
      log(`  ${fp.slice(0, 12)}... → ${result.status}: ${result.details.join("; ")}`)
    }
  }

  // Generate summary (includes drift indicators and profile matrix)
  const summary = generateSummary(runs, args, comparisonSummary, db)
  const summaryPath = join(args.output, "eval-summary.md")
  writeFileSync(summaryPath, summary)
  log(`Summary written to ${summaryPath}`)

  // Close database
  db.close()

  log(`\nEval complete: ${runs.length} fixture(s) executed`)

  // Exit non-zero if any regression detected (T019)
  if (comparisonSummary?.overall === "fail") {
    log("REGRESSION DETECTED — exiting with code 1")
    process.exit(1)
  }

  process.exit(0)
}

// Top-level await — bun supports this
await main()
