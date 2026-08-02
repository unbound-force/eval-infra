# Implementation Plan: Eval Infrastructure Tooling

**Branch**: `001-eval-infra-tooling` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-eval-infra-tooling/spec.md`

**Requirements Source**: `/Users/jflowers/Projects/github/jflowers/eval-infra-plan.md` — contains full architecture, per-file implementation notes, fixture format, DB schema, reusable workflow YAML, and rollout phases.

## Summary

Build shared eval infrastructure for measuring opencode command token efficiency and output quality. The system consists of:

1. **Headless opencode driver** — TypeScript (bun runtime) SDK-based driver that executes opencode sessions headlessly, handles interactive questions via regex pattern matching, auto-approves tool permissions, and captures token usage metrics from SSE events.
2. **Fixture format** — Self-contained eval scenario directories containing task metadata (`task.yaml`), input prompt (`prompt.md`), optional question-answer overrides (`answers.yaml`), and optional quality rubric (`rubric.md`).
3. **SQLite results database** — Persistent `runs.db` storing all eval metrics with fingerprint-based row identity for cross-run comparison.
4. **Baseline comparison** — Regression detection comparing current runs against a committed `baseline.json` using configurable epsilon (cost) and tolerance (quality) thresholds.
5. **LLM judge** — Rubric-based quality evaluator that scores session transcripts and workdir diffs against weighted criteria, producing composite quality scores.
6. **Reusable GitHub Actions workflow** — Consumer repos call `jflowers/eval-infra/.github/workflows/reusable_opencode_eval.yml` via `workflow_call`, providing fixture path, baseline, model, and GCP credentials. The workflow handles all setup and produces artifacts.

## Technical Context

**Language/Version**: TypeScript 5.6+ on bun runtime (>= 1.0)

**Primary Dependencies**:
- `@opencode-ai/sdk` ^1.18.4 — Headless opencode session management (SSE events, session lifecycle)
- `better-sqlite3` ^13.0.0 — Local SQLite database for run results
- `yaml` ^2.4.0 — YAML parsing for fixture files and rubric frontmatter

**Storage**: SQLite via `better-sqlite3` — artifact-only (not committed to repos). `baseline.json` is the committed reference point.

**Testing**: bun test (built-in test runner). Unit tests for pure functions (fingerprint, token capture, baseline comparison). Integration tests require opencode + GCP credentials.

**Target Platform**: CI (GitHub Actions `ubuntu-latest`) + local dev (macOS). Bun runtime on both.

**Project Type**: CLI tool + reusable GitHub Actions workflow

**Performance Goals**: Single fixture execution under 5 minutes (SC-001). Sequential fixture execution (no parallel in v1).

**Constraints**: No service account keys — GCP auth via Workload Identity Federation only. Eval driver runs one fixture at a time. LLM judge calls are separate from fixture token metrics.

**Scale/Scope**: Initial scope: 1 self-test fixture in eval-infra, 3 fixtures in first consumer repo (unbound-force/unbound-force). Expandable to any repo with `.eval/` directory.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution at `.specify/memory/constitution.md` contains template placeholders — it has not been customized for this project. All principle sections (`[PRINCIPLE_1_NAME]` through `[PRINCIPLE_5_NAME]`) and governance sections contain placeholder text.

**Gate status**: PASS — No constitution violations possible since no project-specific principles have been ratified. The implementation follows universal engineering principles (SOLID, DRY, testability, separation of concerns) which align with any reasonable constitution that would be adopted.

**Recommendation**: Customize the constitution before Phase 2 (first consumer adoption) to establish project-specific principles around:
- Fixture format stability (backward compatibility guarantees)
- Baseline management (who can update, review requirements)
- Cost guardrails (budget limits, alert thresholds)

## Project Structure

### Documentation (this feature)

```text
specs/001-eval-infra-tooling/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

No `contracts/` directory needed — this is a CLI tool + reusable workflow, not a web API. The reusable workflow contract (inputs, outputs, secrets) is documented in the workflow YAML itself and in the quickstart guide.

### Source Code (repository root)

```text
driver/                              # TypeScript eval driver (bun)
├── package.json                     # bun, @opencode-ai/sdk, better-sqlite3, yaml
├── tsconfig.json                    # Strict TypeScript config
├── run-eval.ts                      # CLI entrypoint — fixture discovery, orchestration, reporting
├── opencode-driver.ts               # Ported from scripted/ — server lifecycle, SSE, Q&A handling
├── answers.ts                       # 40+ base regex patterns + fixture override loading
├── token-capture.ts                 # SSE event → TokenData accumulator
├── store.ts                         # SQLite runs.db schema, insertRun, getRunsByFingerprint, exportBaseline
├── fingerprint.ts                   # SHA-256 row identity: task_id|task_version|rubric_version|profile_id|model
├── baseline.ts                      # Baseline comparison logic (epsilon/tolerance thresholds)
└── judge.ts                         # LLM-as-judge rubric evaluator (stub in Phase 1, full in Phase 3)

profiles/                            # Config variant profiles
├── baseline.json                    # Production config: hashline, no DCP
├── dcp-soft.json                    # +DCP (nudgeForce: soft, maxContextLimit: 100000)
└── dcp-aggressive.json              # +DCP (nudgeForce: strong, maxContextLimit: 60000)

.eval/                               # Self-test fixtures
└── fixtures/
    └── driver-smoke/
        ├── task.yaml                # Smoke test task metadata
        ├── prompt.md                # Simple prompt for self-test
        ├── rubric.md                # Basic quality rubric
        └── answers.yaml             # Answer overrides for self-test

.github/workflows/
├── reusable_opencode_eval.yml       # Reusable workflow — workflow_call interface
└── ci_self_test.yml                 # Self-test: calls own reusable workflow
```

**Structure Decision**: Single-project layout with `driver/` as the TypeScript package root. No monorepo tooling needed — the driver is the only code package. Profiles and fixtures are data directories at the repo root. This matches the plan document's architecture exactly.

## Implementation Phases

### Phase 1 — Foundation (P1 stories: US1, US2, US3)

Port the existing driver code, implement core infrastructure, create the reusable workflow.

**Driver core** (from `scripted/opencode-driver.ts` + `answers.ts`):
- Port `opencode-driver.ts` (330 lines) — add `onEvent` callback hook for token capture
- Port `answers.ts` (183 lines) — generalize `AnswerContext` to fixture-driven `vars: Record<string, string>`
- Implement `token-capture.ts` — accumulate token data from `step_finish`, `step_start`, `tool_use` events
- Implement `store.ts` — SQLite schema, `insertRun()`, `getRunsByFingerprint()`, `exportBaseline()`
- Implement `fingerprint.ts` — SHA-256 hash of `task_id|task_version|rubric_version|profile_id|model`
- Implement `baseline.ts` — comparison logic with configurable epsilon/tolerance
- Implement `run-eval.ts` — CLI entrypoint: fixture discovery, orchestration, summary generation

**Workflow** (from proven GCP WIF pattern in `gaze/.github/workflows/test.yml`):
- Create `reusable_opencode_eval.yml` — full workflow_call interface with inputs, outputs, secrets
- Create `ci_self_test.yml` — self-test calling own reusable workflow
- Create `driver-smoke` fixture — minimal self-test scenario

**Profiles**:
- Create `baseline.json`, `dcp-soft.json`, `dcp-aggressive.json` profile files

### Phase 2 — First Consumer (US3 validation)

Add eval to `unbound-force/unbound-force` repo. This phase happens in a different repository.

- Create `.eval/fixtures/` with 3 fixture sets: `opsx-propose`, `triage-issue`, `review-pr`
- Create `ci_eval.yml` caller workflow with `post-comment` job
- Bootstrap `baseline.json` from first successful CI run

### Phase 3 — LLM Judge (P2 story: US4)

Implement quality scoring.

- Implement `judge.ts` — rubric parsing, judge prompt construction, model invocation, score computation
- Add rubric files to existing fixtures
- Integrate composite score into baseline comparison (quality regression detection)

### Phase 4 — Expansion (P2/P3 stories: US5, US6, US7)

- Add fixtures for high-cost commands (`/unleash`, `/finale`)
- Implement profile-based matrix mode (run each fixture against each profile)
- Add weekly cron schedule for drift monitoring
- Implement dry-run mode for cost estimation
- Onboard additional repos as applicable

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sequential fixture execution | No parallelism in v1 | Simplicity; opencode server port conflicts; cost control |
| Artifact-only database | `runs.db` not committed | Database grows unbounded; `baseline.json` is the committed reference |
| Env var config injection | `OPENCODE_CONFIG_CONTENT` | Higher precedence than file config; no file mutation during eval |
| Sparse checkout in workflow | `driver/` + `profiles/` only | Minimize checkout size for consumer repos |
| Single judge model | One LLM judge call per fixture | Simplicity; add multi-judge with calibration later |
| Fingerprint-based comparison | SHA-256 of 5 components | Deterministic, collision-resistant, enables drift tracking |

## Complexity Tracking

> No constitution violations to justify — constitution contains template placeholders only.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | N/A | N/A |
