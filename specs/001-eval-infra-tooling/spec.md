# Feature Specification: Eval Infrastructure Tooling

**Feature Branch**: `001-eval-infra-tooling`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "Shared eval tooling for opencode token efficiency and efficacy. Create a repository that provides a reusable GitHub Actions workflow, a TypeScript SDK-based driver, a fixture format for defining eval scenarios, a persistent runs database for tracking drift, and an LLM-as-judge rubric evaluator. Enables automated evaluation of both token cost and output quality for every command shipped."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Eval Against Local Fixtures (Priority: P1)

A command developer wants to evaluate their opencode slash commands locally during development. They define eval fixtures (task description, prompt, expected question-answer patterns, and quality rubric) alongside their command source code. They run the eval driver locally, which starts an opencode session headlessly, executes the command with the given prompt, auto-answers interactive questions, captures token usage metrics, and reports results. The developer sees a summary of cost, token counts, duration, and (optionally) a quality score for each fixture.

**Why this priority**: This is the core value proposition. Without a working driver that can execute opencode sessions headlessly and capture metrics, nothing else in the system functions. Every other story depends on this capability.

**Independent Test**: Can be fully tested by creating a simple fixture, running the eval driver locally, and verifying it produces a results summary with token usage data and exit status.

**Acceptance Scenarios**:

1. **Given** a fixture directory containing `task.yaml` and `prompt.md`, **When** the eval driver is executed against that fixture, **Then** a results row is produced with input tokens, output tokens, cache read tokens, cache creation tokens, cost in USD, turns, tool call count, duration, and exit status.
2. **Given** a fixture with an `answers.yaml` containing question-answer overrides, **When** the opencode session asks a question matching a pattern, **Then** the driver auto-replies with the specified answer and continues execution.
3. **Given** a fixture with no `rubric.md`, **When** the eval completes, **Then** the quality score fields are null but all token metrics are still captured.
4. **Given** a command that times out, **When** the configured timeout is exceeded, **Then** the run is recorded with exit status "timeout" and partial token data is preserved.

---

### User Story 2 - Detect Token Regressions via Baseline Comparison (Priority: P1)

A team lead wants to ensure that changes to opencode commands, agents, or skills do not cause token cost regressions. They commit a `baseline.json` file containing reference metrics from a known-good run. On subsequent eval runs, each fixture result is compared against the baseline using a fingerprint (derived from task ID, task version, rubric version, config profile, and model). If cost or input tokens exceed the baseline beyond a configurable tolerance, the eval reports a regression and exits non-zero.

**Why this priority**: Regression detection is the primary automated gate. Without it, eval is just measurement without enforcement — teams would have to manually inspect results to spot regressions.

**Independent Test**: Can be tested by running eval twice — once to generate a baseline, then again with a modified fixture or config — and verifying that the comparison correctly flags regressions or passes clean.

**Acceptance Scenarios**:

1. **Given** a baseline file and a current run with the same fingerprint, **When** cost exceeds the baseline by more than the epsilon threshold (default 10%), **Then** the eval reports a token regression and exits non-zero.
2. **Given** a baseline file and a current run where metrics are within tolerance, **When** the comparison runs, **Then** the eval reports pass and exits zero.
3. **Given** a current run with a fingerprint not present in the baseline (new fixture), **When** the comparison runs, **Then** the new fixture is reported as "no baseline" (informational) and does not cause failure.
4. **Given** a cost improvement (current run cheaper than baseline), **When** the comparison runs, **Then** the improvement is reported as informational without blocking.

---

### User Story 3 - Reusable CI Workflow for Any Repository (Priority: P1)

A repository maintainer wants to add automated eval to their CI pipeline without duplicating the driver, workflow logic, or GCP authentication setup. They call a reusable GitHub Actions workflow from eval-infra, providing their fixture path, baseline path, model, and GCP credentials. The workflow handles all setup (bun, opencode, GCP WIF authentication), runs the eval, uploads result artifacts, and exposes outputs (status, composite score, total cost, total tokens) for downstream jobs like PR commenting.

**Why this priority**: Reusability across repos is what makes this infrastructure rather than a one-off script. Without the reusable workflow, every repo would need to maintain its own CI setup.

**Independent Test**: Can be tested by the eval-infra repo itself calling its own reusable workflow against self-test fixtures in `.eval/fixtures/`.

**Acceptance Scenarios**:

1. **Given** a consumer repo with `.eval/fixtures/` and a `ci_eval.yml` that calls the reusable workflow, **When** a PR is opened that modifies `.opencode/**` or `.eval/**`, **Then** the workflow runs, produces eval results, and uploads artifacts.
2. **Given** the reusable workflow is called with valid GCP WIF secrets, **When** authentication occurs, **Then** opencode can access Vertex AI models via workload identity federation without any service account keys.
3. **Given** the reusable workflow completes, **When** a downstream `post-comment` job reads the artifacts, **Then** it posts (or updates) a PR comment with the eval summary.

---

### User Story 4 - Score Output Quality with LLM Judge (Priority: P2)

A command developer wants to measure not just cost but quality of their command's output. They define a `rubric.md` file with weighted scoring criteria (e.g., proposal completeness 35%, code correctness 30%, follows instructions 20%, appropriate scope 15%) and a pass threshold. After the eval driver captures the session transcript and workdir diff, a separate LLM judge scores the output against each criterion, producing a weighted composite score. This score is stored alongside token metrics for cost-vs-quality tradeoff analysis.

**Why this priority**: Quality scoring transforms eval from a cost-only tool into a cost-and-quality tool. However, the system delivers value with token metrics alone (P1 stories), so quality scoring builds on top.

**Independent Test**: Can be tested by providing a known transcript and rubric, running the judge, and verifying it returns per-criterion scores and a weighted composite.

**Acceptance Scenarios**:

1. **Given** a fixture with a `rubric.md` defining weighted criteria and a pass threshold, **When** the eval completes and the judge runs, **Then** per-criterion scores (0.0-1.0) and a weighted composite score are stored in the results.
2. **Given** a composite score below the rubric's pass threshold, **When** baseline comparison runs, **Then** the quality regression is reported and the eval exits non-zero.
3. **Given** the same rubric and transcript run multiple times, **When** the judge uses deterministic settings (temperature 0.0), **Then** scores are consistent within a narrow variance band.

---

### User Story 5 - Track Efficiency Drift Over Time (Priority: P2)

An engineering manager wants visibility into how token costs and quality scores change over time — not just across PRs, but also due to upstream model updates or opencode version changes. The eval system stores results in a persistent database with run metadata (timestamp, git SHA, model, opencode version, config profile). Scheduled weekly runs capture drift even when no code changes are made. Historical data with matching fingerprints can be queried to visualize trends.

**Why this priority**: Drift monitoring catches regressions caused by external factors (model updates, SDK changes) that PR-triggered eval would miss. It builds on the core data capture (P1) and adds longitudinal value.

**Independent Test**: Can be tested by inserting multiple runs with the same fingerprint and querying the database for trend data across timestamps.

**Acceptance Scenarios**:

1. **Given** multiple eval runs over time with the same fingerprint, **When** the database is queried by fingerprint, **Then** results are returned in chronological order showing cost and quality trends.
2. **Given** a consumer repo with a weekly cron schedule in its eval workflow, **When** the cron fires, **Then** eval runs against the current main branch and stores results for drift analysis.
3. **Given** no code changes between weekly runs, **When** a model update causes a cost increase, **Then** the increase is visible in the drift data as a fingerprint-matched cost delta.

---

### User Story 6 - Compare Config Variants via Profiles (Priority: P3)

A developer wants to evaluate the cost-vs-quality tradeoff of different opencode configurations (e.g., baseline without DCP, soft DCP, aggressive DCP). They define config profiles that override specific opencode settings. The eval runner executes each fixture against each profile, producing separate result rows with distinct profile IDs. A comparison matrix shows how each profile affects cost and quality for each fixture.

**Why this priority**: Profile-based testing is a power feature for config optimization. It requires the core eval pipeline (P1) and benefits from quality scoring (P2) but is not essential for initial adoption.

**Independent Test**: Can be tested by creating two profiles with different settings, running the same fixture against both, and verifying that results are stored with distinct profile IDs and can be compared in the summary.

**Acceptance Scenarios**:

1. **Given** two config profiles (baseline and dcp-soft) and one fixture, **When** the eval runs in matrix mode, **Then** two result rows are produced — one per profile — with distinct profile IDs.
2. **Given** eval results from multiple profiles, **When** the summary is generated, **Then** a comparison matrix shows cost and quality metrics side by side per profile.

---

### User Story 7 - Estimate Eval Costs Before Enabling (Priority: P3)

A repository maintainer wants to understand the cost of enabling eval before committing to it. They run the eval driver in dry-run mode, which lists the fixtures that would execute and estimates the cost based on historical data from the runs database for matching fingerprints. This allows budget forecasting without actually incurring API costs.

**Why this priority**: Cost estimation is a convenience feature that reduces adoption friction. It depends on having historical data in the runs database (P2/P5).

**Independent Test**: Can be tested by running the driver with `--dry-run` and verifying it outputs fixture names and estimated costs without executing any opencode sessions.

**Acceptance Scenarios**:

1. **Given** historical runs in the database and the `--dry-run` flag, **When** the driver runs, **Then** it lists each fixture with estimated cost based on historical data and shows a projected total.
2. **Given** no historical data for a fixture, **When** dry-run mode runs, **Then** the fixture is listed with "no estimate available" instead of a cost projection.

---

### Edge Cases

- What happens when the opencode server fails to start within the timeout period? The run should be recorded with exit status "error" and an error message describing the startup failure.
- What happens when a fixture's `answers.yaml` has no matching pattern for a question the agent asks? The driver should bail on that question with a descriptive reason and record the run as "bail" with the unmatched question text.
- What happens when two eval fixtures use the same `task_id` and `task_version`? The fingerprint will be identical; both runs are stored and the most recent is used for baseline comparison.
- What happens when the LLM judge returns malformed JSON? The judge should retry once; if still malformed, record the run with null quality scores and an error message noting the judge failure.
- What happens when `baseline.json` references a fingerprint that no longer exists in the fixture set (fixture was removed)? The orphaned baseline entry is ignored — no warning or failure, since fixture removal is intentional.
- What happens when the opencode session produces no workdir diff (command completed but made no file changes)? The diff_bytes field is 0 and workdir_diff is empty; this is a valid result, not an error.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST execute opencode sessions headlessly using the SDK, handling server lifecycle (start, health check, stop), session creation, and command execution via SSE event streaming.
- **FR-002**: System MUST auto-respond to interactive questions during command execution by matching question text against a configurable set of regex patterns, supporting "reply", "bail", and "done" actions.
- **FR-003**: System MUST auto-approve all tool permission requests during eval execution to enable unattended operation.
- **FR-004**: System MUST capture token usage metrics (input tokens, output tokens, cache read tokens, cache creation tokens, cost in USD, turns, tool call count) from SSE events during session execution.
- **FR-005**: System MUST persist eval results in a local database with schema supporting run identification (run ID, timestamp, fingerprint), context (repo, git SHA, branch, command name, task ID, task version, rubric version, profile ID, model, opencode version), outcomes (exit status, error message, composite score, per-criterion scores), and metrics (cost, duration, turns, tool calls, input/output/cache tokens, diff bytes, workdir diff).
- **FR-006**: System MUST compute a row identity fingerprint from task ID, task version, rubric version, profile ID, and model to enable direct comparison of runs across time.
- **FR-007**: System MUST compare current run metrics against a committed baseline file, detecting regressions when cost or input tokens exceed the baseline by more than a configurable epsilon (default 10%) or when composite quality score drops below baseline minus a configurable tolerance (default 0.05).
- **FR-008**: System MUST support a fixture format where each eval scenario is a directory containing `task.yaml` (task metadata), `prompt.md` (the input prompt), optional `answers.yaml` (question-answer pattern overrides), and optional `rubric.md` (quality scoring criteria with weights and pass threshold).
- **FR-009**: System MUST discover fixtures by scanning a directory tree for `task.yaml` files.
- **FR-010**: System MUST provide a reusable GitHub Actions workflow that consumer repos can call via `workflow_call`, accepting inputs for fixture path, baseline path, opencode version, model, timeout, and config profile, and exposing outputs for status, composite score, total cost, and total tokens.
- **FR-011**: System MUST authenticate to Google Cloud via Workload Identity Federation in CI, using OIDC tokens without service account keys.
- **FR-012**: System MUST upload eval result artifacts (database, summary report) to GitHub Actions artifacts with configurable retention.
- **FR-013**: System MUST generate a markdown summary report of all eval results, suitable for posting as a PR comment.
- **FR-014**: System MUST support config profiles that override opencode settings during eval runs, enabling cost-vs-quality comparison across configurations.
- **FR-015**: System MUST score output quality via an LLM judge that evaluates session transcripts and workdir diffs against rubric criteria, returning per-criterion scores (0.0-1.0) and a weighted composite score.
- **FR-016**: System MUST support a self-test mode where the eval-infra repo runs its own reusable workflow against its own fixtures.
- **FR-017**: System MUST support exporting current run results as a baseline file for future comparisons.
- **FR-018**: System MUST support a dry-run mode that lists fixtures and estimates costs based on historical data without executing any opencode sessions.

### Key Entities

- **Fixture**: A self-contained eval scenario definition comprising task metadata, input prompt, optional answer overrides, and optional quality rubric. Lives alongside command source code in consumer repos.
- **Run**: A single eval execution record containing all captured metrics, context metadata, and quality scores. Identified by a unique run ID and comparable via fingerprint.
- **Fingerprint**: A deterministic hash derived from task ID, task version, rubric version, profile ID, and model. Rows with the same fingerprint are directly comparable across runs.
- **Baseline**: A committed reference point containing metrics from a known-good run, used for regression detection.
- **Profile**: A named configuration variant that overrides opencode settings (model, plugins, compaction) during eval execution.
- **Rubric**: A quality scoring definition with weighted criteria, pass threshold, and per-criterion descriptions. Used by the LLM judge.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The eval driver can execute a simple fixture (single command, no quality scoring) end-to-end in under 5 minutes, producing a complete results row with all token metrics.
- **SC-002**: Baseline comparison correctly identifies token cost regressions exceeding the 10% default epsilon and quality regressions below the 0.05 default tolerance in 100% of test cases.
- **SC-003**: A consumer repo can adopt eval by adding a `.eval/` directory and a thin caller workflow (under 30 lines of YAML), with no driver code duplication.
- **SC-004**: The reusable workflow successfully authenticates to Google Cloud via WIF and executes eval runs in CI without any service account keys or manually configured credentials.
- **SC-005**: The LLM judge produces consistent quality scores (variance within 0.05 across repeated runs) when using deterministic settings.
- **SC-006**: The eval summary report is generated as valid markdown that renders correctly as a GitHub PR comment.
- **SC-007**: Historical run data with matching fingerprints can be queried from the database to show cost and quality trends over at least 30 days of weekly runs.
- **SC-008**: Dry-run mode provides cost estimates within 25% of actual costs based on historical data, without executing any opencode sessions.

## Assumptions

- The opencode SDK v2 API (SSE event streaming, session management, question/permission handling) remains stable across the versions targeted by eval fixtures.
- Consumer repos already have GCP Workload Identity Federation configured for their GitHub repository, or the repo maintainer can configure it.
- The `bun` runtime is used for the eval driver; CI environments use `oven-sh/setup-bun` for installation.
- The `better-sqlite3` package is used for local database persistence; the database is artifact-only (not committed to repos) with `baseline.json` as the committed reference point.
- The eval driver runs one fixture at a time sequentially (no parallel fixture execution in v1).
- The base set of 40+ question-answer patterns from the existing scripted driver covers the majority of common opencode interactive questions; per-fixture `answers.yaml` overrides handle command-specific questions.
- LLM judge calls use a separate model invocation (single-turn, no tools) and are not counted in the eval fixture's token metrics.
- Config profiles are injected via environment variable override (higher precedence than project config), not by modifying committed config files.
- Phase 0 (config source control — moving global opencode config into each repo's committed `opencode.json`) is a prerequisite for reproducible eval but is tracked separately from the eval-infra implementation.
- The eval-infra repo is initially under `jflowers/` (personal org) and will be transferred to `unbound-force/` once the team approves.
