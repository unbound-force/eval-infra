# Tasks: Eval Infrastructure Tooling

**Feature Branch**: `001-eval-infra-tooling` | **Date**: 2026-08-02

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Data Model**: [data-model.md](./data-model.md)

## Phase 1: Setup — Project Initialization

> Bootstrap the TypeScript project structure, dependencies, and build configuration.

- [x] T001 Create `driver/package.json` with dependencies: `@opencode-ai/sdk` ^1.18.4, `better-sqlite3` ^13.0.0, `yaml` ^2.4.0, and devDependencies: `typescript` ^5.6.0, `@types/node` ^22.0.0, `@types/better-sqlite3` ^7.6.0; scripts: `eval` → `bun run-eval.ts`, `typecheck` → `bunx tsc --noEmit`, `test` → `bun test`
- [x] T002 [P] Create `driver/tsconfig.json` with strict mode, ES2022 target, module NodeNext, moduleResolution NodeNext, outDir dist, rootDir `.`, skipLibCheck true
- [x] T003 [P] Create `.gitignore` entries for `driver/node_modules/`, `driver/dist/`, `*.db`, `eval-out/` (append to existing `.gitignore`)
- [x] T004 Run `bun install` in `driver/` to verify dependency resolution and generate lockfile

## Phase 2: Foundational — Port Core Driver Code

> Port the existing opencode driver and answer patterns from `scripted/`. These modules block ALL user stories.

- [x] T005 [US1] Port `opencode-driver.ts` from `/Users/jflowers/Projects/github/unbound-force/scripted/opencode-driver.ts` (330 lines) to `driver/opencode-driver.ts` — keep all SSE event handling, question handling (`question.asked`, `question.v2.asked`), permission auto-approval (`permission.asked`, `permission.v2.asked`), server lifecycle (`start`, `stop`, `createSession`, `runCommand`), `ALLOW_ALL_PERMISSIONS` ruleset; add `onEvent?: (event: any) => void` callback to `DriverOptions` for token capture hook; call `opts.onEvent?.(event)` for every SSE event in the `runCommand` loop; make `log()` configurable (structured JSON vs human-readable)
- [x] T006 [US1] Port `answers.ts` from `/Users/jflowers/Projects/github/unbound-force/scripted/answers.ts` (183 lines) to `driver/answers.ts` — generalize `AnswerContext` from batch-fix-specific fields (`issueUrl`, `issueTitle`, `issueNumber`, `changeName`) to fixture-driven `vars: Record<string, string>`; keep all 40+ regex patterns as the shared base `ANSWER_PATTERNS` array; update pattern answer functions to use `ctx.vars` instead of `ctx.issueUrl` etc.; add `loadFixtureAnswers(answersYamlPath: string)` function that parses `answers.yaml` and returns patterns to prepend to the base list; export `mergePatterns(fixturePatterns, basePatterns)` for first-match-wins composition
- [x] T007 Verify ported driver compiles: run `bunx tsc --noEmit` in `driver/` and fix any type errors

## Phase 3: US1 (P1) — Run Eval Against Local Fixtures

> Core eval pipeline: token capture, SQLite storage, CLI entrypoint, fixture discovery, self-test fixture.

- [x] T008 [P] [US1] Implement `driver/token-capture.ts` — `TokenData` interface (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `turns`, `tool_calls_count`); `TokenCapture` class with `handleEvent(event)` method that accumulates from `step_finish` (token counts + cost), `step_start` (turns++), `tool_use` (tool_calls_count++); `getSnapshot(): TokenData` returns a copy; `reset()` zeroes all fields; add runtime validation for missing/renamed event properties per RQ-1
- [x] T009 [P] [US1] Implement `driver/fingerprint.ts` — `fingerprint(parts: { task_id, task_version, rubric_version, profile_id, model }): string` function using `crypto.createHash("sha256")` with pipe-delimited input `task_id|task_version|rubric_version|profile_id|model`; export the `FingerprintParts` type
- [x] T010 [P] [US1] Write unit tests for `driver/fingerprint.ts` in `driver/__tests__/fingerprint.test.ts` — test deterministic output, different inputs produce different hashes, pipe delimiter prevents collisions (e.g., `a|b` vs `a` + `|b`)
- [x] T011 [US1] Implement `driver/store.ts` — `initDb(dbPath: string): Database` creates SQLite database with `runs` table schema (run_id TEXT PK, timestamp TEXT, fingerprint TEXT, repo TEXT, git_sha TEXT, git_branch TEXT, command_name TEXT, task_id TEXT, task_version TEXT, rubric_version TEXT, profile_id TEXT DEFAULT 'baseline', model TEXT, opencode_version TEXT, exit_status TEXT, error_message TEXT, composite_score REAL, scores_json TEXT, cost_usd REAL, duration_s REAL, turns INTEGER, tool_calls_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, diff_bytes INTEGER, workdir_diff TEXT) plus indexes on fingerprint, timestamp, repo; `insertRun(db, run)` prepared statement insert; `getRunsByFingerprint(db, fingerprint): Run[]` ordered by timestamp; `getLatestRun(db, fingerprint): Run | null`; `exportBaseline(db): Record<string, BaselineEntry>` exports latest run per fingerprint
- [x] T012 [US1] Implement `driver/run-eval.ts` — CLI entrypoint with arg parsing for `--fixtures`, `--baseline`, `--model`, `--profile`, `--repo`, `--git-sha`, `--git-branch`, `--output`, `--timeout`, `--export-baseline`, `--dry-run`, `--epsilon`, `--tolerance`; fixture discovery via glob `<fixtures>/**/task.yaml`; for each fixture: parse `task.yaml` (yaml package), read `prompt.md`, load `answers.yaml` (merge with base patterns), create `TokenCapture` instance, start `OpencodeDriver`, create session, send command/prompt, capture token data via `onEvent` hook, measure wall-clock duration, capture workdir diff via `git diff`, compute fingerprint, write row to `runs.db` via `store.insertRun()`, stop driver; generate `eval-summary.md` markdown table; exit 0 on success
- [x] T013 [P] [US1] Create self-test fixture directory `.eval/fixtures/driver-smoke/` with `task.yaml` (task_id: "driver-smoke", task_version: "1", description: "Smoke test for eval driver", exec_mode: "interactive", command: "help", timeout_seconds: 120)
- [x] T014 [P] [US1] Create `.eval/fixtures/driver-smoke/prompt.md` with a simple prompt for the smoke test (e.g., "Show available commands")
- [x] T015 [P] [US1] Create `.eval/fixtures/driver-smoke/answers.yaml` with minimal answer overrides for the smoke test
- [ ] T016 [US1] Verify end-to-end: run `bun run-eval.ts --fixtures ../.eval/fixtures --model google-vertex-anthropic/claude-opus-4-6@default --repo jflowers/eval-infra --output ../eval-out` and confirm `runs.db` and `eval-summary.md` are produced (requires opencode + GCP credentials)

## Phase 4: US2 (P1) — Detect Token Regressions via Baseline Comparison

> Fingerprint-based baseline comparison with configurable epsilon/tolerance thresholds.

- [x] T017 [US2] Implement `driver/baseline.ts` — `loadBaseline(baselinePath: string): Record<string, BaselineEntry>` reads and parses `baseline.json`; `BaselineEntry` type with `cost_usd`, `input_tokens`, `output_tokens`, `composite_score`, `timestamp`, `run_id`; `compareRun(current: Run, baseline: BaselineEntry, opts: { epsilon: number, tolerance: number }): ComparisonResult` returns `{ status: "pass" | "regression" | "improvement" | "no-baseline", details: string[] }` — token regression when `current.cost_usd > baseline.cost_usd * (1 + epsilon)` OR `current.input_tokens > baseline.input_tokens * (1 + epsilon)`, quality regression when `current.composite_score < baseline.composite_score - tolerance`, improvement when current is better, no-baseline when fingerprint not found; `compareAllRuns(runs: Run[], baseline: Record<string, BaselineEntry>, opts): ComparisonSummary` aggregates all comparisons
- [x] T018 [P] [US2] Write unit tests for `driver/baseline.ts` in `driver/__tests__/baseline.test.ts` — test regression detection (cost exceeds epsilon), pass (within tolerance), improvement (cost decreased), no-baseline (new fingerprint), quality regression (score below tolerance), edge cases (null composite_score)
- [x] T019 [US2] Integrate baseline comparison into `driver/run-eval.ts` — when `--baseline` flag is provided, load baseline file, compare each run's fingerprint against baseline using `compareRun()`, include comparison results in `eval-summary.md`, exit non-zero if any regression detected
- [x] T020 [US2] Add `--export-baseline` mode to `driver/run-eval.ts` — when flag is set, call `store.exportBaseline(db)` and write result to `baseline.json` in the output directory

## Phase 5: US3 (P1) — Reusable CI Workflow

> GitHub Actions reusable workflow, self-test workflow, and config profiles.

- [x] T021 [P] [US3] Create `.github/workflows/reusable_opencode_eval.yml` — `workflow_call` trigger with inputs: `fixture-path` (required, string), `baseline-path` (optional, string, default ''), `opencode-version` (optional, string, default '1.2.26'), `model` (optional, string, default 'google-vertex-anthropic/claude-opus-4-6@default'), `timeout-minutes` (optional, number, default 60), `profile` (optional, string, default 'baseline'); outputs: `status`, `composite-score`, `total-cost`, `total-tokens`; secrets: `gcp_project_id` (required), `gcp_workload_identity_provider` (required); env: `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION=global`, `VERTEX_LOCATION=global`, `ANTHROPIC_VERTEX_PROJECT_ID=${{ secrets.gcp_project_id }}`; steps: checkout calling repo, sparse checkout eval-infra (driver/ + profiles/), GCP WIF auth via `google-github-actions/auth@v3`, setup gcloud, install bun via `oven-sh/setup-bun@v2`, `bun install` in `.eval-infra/driver`, install opencode via npm, run eval with all inputs mapped, upload artifacts via `actions/upload-artifact@v4` with 30-day retention
- [x] T022 [P] [US3] Create `.github/workflows/ci_self_test.yml` — triggers on push to main, pull_request to main, and weekly cron `0 6 * * 1`; calls own reusable workflow `./.github/workflows/reusable_opencode_eval.yml` with `fixture-path: .eval/fixtures`, `opencode-version: '1.2.26'`, `timeout-minutes: 30`; passes GCP secrets
- [x] T023 [P] [US3] Create `profiles/baseline.json` — production config profile: `{ "description": "Current production config (hashline, no DCP)", "config_override": { "model": "google-vertex-anthropic/claude-opus-4-6@default", "plugin": ["@angdrew/opencode-hashline-plugin"] } }`
- [x] T024 [P] [US3] Create `profiles/dcp-soft.json` — DCP soft config profile: `{ "description": "+DCP (nudgeForce: soft, maxContextLimit: 100000)", "config_override": { "model": "google-vertex-anthropic/claude-opus-4-6@default", "plugin": ["@angdrew/opencode-hashline-plugin", "@tarquinen/opencode-dcp"] } }`
- [x] T025 [P] [US3] Create `profiles/dcp-aggressive.json` — DCP aggressive config profile: `{ "description": "+DCP (nudgeForce: strong, maxContextLimit: 60000)", "config_override": { "model": "google-vertex-anthropic/claude-opus-4-6@default", "plugin": ["@angdrew/opencode-hashline-plugin", "@tarquinen/opencode-dcp"] } }`
- [x] T026 [US3] Add profile loading to `driver/run-eval.ts` — when `--profile` is specified, read `profiles/<name>.json`, serialize `config_override` to `OPENCODE_CONFIG_CONTENT` env var before starting the opencode server; validate profile file exists

## Phase 6: US4 (P2) — Score Output Quality with LLM Judge

> Rubric-based quality evaluation using LLM-as-judge pattern.

- [x] T027 [US4] Implement `driver/judge.ts` — `RubricConfig` interface (`rubric_version`, `pass_threshold`, `weights: Record<string, number>`); `JudgeResult` interface (`composite: number`, `scores: Record<string, number>`, `passed: boolean`, `reasoning: string`); `parseRubric(content: string): { config: RubricConfig, criteria: Record<string, string> }` parses YAML frontmatter and markdown body sections; `buildJudgePrompt(criteria, transcript, workdirDiff): string` constructs the judge prompt with criteria descriptions, agent transcript, and workdir diff; `callJudgeModel(prompt, weights, model): Promise<Record<string, number>>` invokes the model via SDK (single-turn, no tools, temperature 0.0), parses JSON response, retries once on malformed JSON per edge case spec; `judge(opts: { rubricPath, transcript, workdirDiff, model }): Promise<JudgeResult>` orchestrates parsing → prompt → model call → composite score computation (weighted sum)
- [x] T028 [P] [US4] Write unit tests for rubric parsing in `driver/__tests__/judge.test.ts` — test `parseRubric()` with valid rubric markdown, missing frontmatter, weights that don't sum to 1.0, empty criteria sections
- [x] T029 [US4] Integrate judge into `driver/run-eval.ts` — after fixture execution, if `rubric.md` exists in the fixture directory, capture session transcript, run `judge()`, store `composite_score` and `scores_json` in the run row; if no rubric, set both to null per acceptance scenario US1-3
- [x] T030 [US4] Create `.eval/fixtures/driver-smoke/rubric.md` — basic quality rubric with frontmatter (`rubric_version: "1"`, `pass_threshold: 0.50`, weights for `completeness: 0.50`, `correctness: 0.50`) and criterion descriptions

## Phase 7: US5 (P2) — Track Efficiency Drift Over Time

> Scheduled runs and historical drift query support.

- [x] T031 [US5] Add `getRunHistory(db, fingerprint, limit?): Run[]` to `driver/store.ts` — returns runs ordered by timestamp descending for drift analysis; add `getDistinctFingerprints(db): string[]` for listing all tracked fingerprints
- [x] T032 [US5] Add drift summary section to `eval-summary.md` generation in `driver/run-eval.ts` — when historical runs exist for a fingerprint, include trend indicators (cost delta from previous run, quality delta) in the summary table
- [x] T033 [US5] Update `.github/workflows/ci_self_test.yml` to include weekly cron schedule `0 6 * * 1` (Monday 6am UTC) for drift monitoring — verify cron trigger is already present from T022, add documentation comment explaining drift monitoring purpose

## Phase 8: US6 (P3) — Compare Config Variants via Profiles

> Profile matrix execution mode for cost-vs-quality comparison across configurations.

- [x] T034 [US6] Add `--profiles` (plural) flag to `driver/run-eval.ts` for matrix mode — accepts comma-separated profile names (e.g., `--profiles baseline,dcp-soft,dcp-aggressive`); when set, execute each fixture against each profile sequentially, producing separate run rows with distinct `profile_id` values
- [x] T035 [US6] Add comparison matrix to `eval-summary.md` — when multiple profiles are used, generate a side-by-side comparison table showing cost, tokens, quality score, and duration per fixture per profile (format: rows = fixtures, columns = profiles × metrics)

## Phase 9: US7 (P3) — Estimate Eval Costs Before Enabling

> Dry-run mode for cost estimation without executing opencode sessions.

- [x] T036 [US7] Implement `--dry-run` mode in `driver/run-eval.ts` — when flag is set, discover fixtures normally, compute fingerprints, query `store.getLatestRun(db, fingerprint)` for historical cost data, output a table listing each fixture with estimated cost (from historical data) or "no estimate available" (no historical data), show projected total cost, exit without executing any opencode sessions
- [x] T037 [P] [US7] Write unit test for dry-run cost estimation logic in `driver/__tests__/dry-run.test.ts` — test with historical data present (returns estimate), no historical data (returns "no estimate available"), mixed (some fixtures have history, some don't)

## Phase 10: Polish — Documentation, Error Handling, Summary Formatting

> Hardening, edge case handling, and documentation.

- [x] T038 [P] Handle edge case: opencode server fails to start within timeout — record run with `exit_status: "error"` and descriptive `error_message` per spec edge case
- [x] T039 [P] Handle edge case: `answers.yaml` has no matching pattern for a question — driver bails with descriptive reason, records run as `exit_status: "bail"` with unmatched question text in `error_message` per spec edge case
- [x] T040 [P] Handle edge case: command times out — record run with `exit_status: "timeout"` and preserve partial token data per acceptance scenario US1-4
- [x] T041 [P] Handle edge case: LLM judge returns malformed JSON — retry once; if still malformed, record run with null quality scores and error message noting judge failure per spec edge case
- [x] T042 [P] Handle edge case: no workdir diff produced — set `diff_bytes: 0` and `workdir_diff: ""` as valid result per spec edge case
- [x] T043 Format `eval-summary.md` as valid GitHub-flavored markdown — include header with run metadata (timestamp, repo, git SHA, model, profile), per-fixture results table (fixture name, exit status, cost, input tokens, output tokens, cache tokens, turns, tool calls, duration, quality score), baseline comparison section (pass/fail/regression/improvement per fingerprint), total cost row
- [x] T044 Run full type check: `bunx tsc --noEmit` in `driver/` — fix any remaining type errors across all source files
- [x] T045 Run full test suite: `bun test` in `driver/` — verify all unit tests pass

<!-- spec-review: passed -->
<!-- code-review: passed -->
