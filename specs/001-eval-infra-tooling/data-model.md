# Data Model: Eval Infrastructure Tooling

**Feature Branch**: `001-eval-infra-tooling` | **Date**: 2026-08-02

## Key Entities

### Fixture

A self-contained eval scenario definition. Lives as a directory containing structured files.

```
fixtures/<fixture-name>/
├── task.yaml       # Required: task metadata
├── prompt.md       # Required: input prompt for the command
├── answers.yaml    # Optional: question-answer pattern overrides
└── rubric.md       # Optional: quality scoring criteria
```

#### task.yaml Schema

```yaml
task_id: string          # Unique identifier (e.g., "opsx-propose-basic")
task_version: string     # Version string (e.g., "1") — bump when task changes
description: string      # Human-readable description
exec_mode: string        # "interactive" | "autonomous"
command: string          # Slash command name (e.g., "opsx-propose")
timeout_seconds: number  # Max execution time (default: 900)
```

#### answers.yaml Schema

```yaml
patterns:
  - match: string        # Regex pattern to match question text
    action: string       # "reply" | "bail" | "done"
    labels: string[][]   # Response labels (for "reply" action)
```

Fixture-specific patterns are prepended to the base pattern list from `driver/answers.ts` (40+ shared patterns). First match wins.

#### rubric.md Schema

Markdown file with YAML frontmatter:

```yaml
---
rubric_version: string       # Version string — bump when rubric changes
pass_threshold: number       # Minimum composite score to pass (0.0-1.0)
weights:
  <criterion_name>: number   # Weight for each criterion (must sum to 1.0)
---

## <criterion_name>
<description of what to evaluate and how to score>
```

### Run

A single eval execution record. Stored as a row in the SQLite `runs` table.

```sql
CREATE TABLE IF NOT EXISTS runs (
  -- Identity
  run_id                TEXT PRIMARY KEY,    -- UUID v4
  timestamp             TEXT NOT NULL,       -- ISO 8601
  fingerprint           TEXT NOT NULL,       -- SHA-256 hash for comparison

  -- Context
  repo                  TEXT NOT NULL,       -- e.g., "jflowers/eval-infra"
  git_sha               TEXT,               -- Commit SHA at eval time
  git_branch            TEXT,               -- Branch name
  command_name          TEXT NOT NULL,       -- Slash command evaluated
  task_id               TEXT NOT NULL,       -- From task.yaml
  task_version          TEXT NOT NULL,       -- From task.yaml
  rubric_version        TEXT NOT NULL,       -- From rubric.md frontmatter (or "none")
  profile_id            TEXT NOT NULL DEFAULT 'baseline',  -- Config profile name
  model                 TEXT NOT NULL,       -- Model identifier
  opencode_version      TEXT NOT NULL,       -- opencode-ai package version

  -- Outcomes
  exit_status           TEXT NOT NULL,       -- "success" | "timeout" | "error" | "bail"
  error_message         TEXT,               -- Error details (null on success)
  composite_score       REAL,               -- Weighted quality score (null if no rubric)
  scores_json           TEXT,               -- JSON: per-criterion scores (null if no rubric)

  -- Token Metrics
  cost_usd              REAL,               -- Total cost in USD
  duration_s            REAL,               -- Wall clock seconds
  turns                 INTEGER,            -- Count of model invocations
  tool_calls_count      INTEGER,            -- Count of tool uses
  input_tokens          INTEGER,            -- Fresh prompt tokens
  output_tokens         INTEGER,            -- Model response tokens
  cache_read_tokens     INTEGER,            -- Prompt cache hits
  cache_creation_tokens INTEGER,            -- Prompt cache writes

  -- Diff
  diff_bytes            INTEGER,            -- Size of workdir diff
  workdir_diff          TEXT                 -- Full git diff output
);
```

#### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_runs_fingerprint ON runs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo);
```

### Fingerprint

A deterministic hash for comparing runs across time. Two runs with the same fingerprint are directly comparable.

```
fingerprint = SHA-256(task_id | task_version | rubric_version | profile_id | model)
```

Components are joined with `|` delimiter before hashing. This means:
- Changing the task content (bumping `task_version`) creates a new fingerprint
- Changing the rubric (bumping `rubric_version`) creates a new fingerprint
- Running with a different profile creates a new fingerprint
- Running with a different model creates a new fingerprint

### Baseline

A committed JSON file containing reference metrics from known-good runs.

```json
{
  "<fingerprint>": {
    "cost_usd": 0.47,
    "input_tokens": 12340,
    "output_tokens": 3210,
    "composite_score": 0.82,
    "timestamp": "2026-08-01T12:00:00Z",
    "run_id": "abc-123"
  }
}
```

Baseline comparison rules:
- **Token regression**: `current.cost_usd > baseline.cost_usd * (1 + epsilon)` where epsilon defaults to 0.10 (10%)
- **Token regression (alt)**: `current.input_tokens > baseline.input_tokens * (1 + epsilon)`
- **Quality regression**: `current.composite_score < baseline.composite_score - tolerance` where tolerance defaults to 0.05
- **No baseline**: New fingerprint not in baseline file — reported as informational, not a failure
- **Improvement**: Current metrics better than baseline — reported as informational, not blocking
- **Orphaned baseline**: Fingerprint in baseline but no matching fixture — silently ignored

### Profile

A named configuration variant stored as a JSON file in `profiles/`.

```json
{
  "description": "Current production config (hashline, no DCP)",
  "config_override": {
    "model": "google-vertex-anthropic/claude-opus-4-6@default",
    "plugin": ["@angdrew/opencode-hashline-plugin"]
  }
}
```

Profiles are injected via the `OPENCODE_CONFIG_CONTENT` environment variable during eval runs. The eval driver reads the profile file, serializes it, and sets the env var before starting the opencode server.

### TokenData

In-memory accumulator for token metrics during a single eval run.

```typescript
interface TokenData {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
  turns: number
  tool_calls_count: number
}
```

Populated by `TokenCapture.handleEvent()` from SSE events:
- `step_finish` → accumulates token counts and cost
- `step_start` → increments turns
- `tool_use` → increments tool_calls_count

### JudgeResult

Output from the LLM judge quality evaluation.

```typescript
interface JudgeResult {
  composite: number              // Weighted composite score (0.0-1.0)
  scores: Record<string, number> // Per-criterion scores (0.0-1.0)
  passed: boolean                // composite >= pass_threshold
  reasoning: string              // Judge's explanation
}
```

## Entity Relationships

```
Fixture 1──* Run          (one fixture produces many runs over time)
Run *──1 Fingerprint      (each run has exactly one fingerprint)
Baseline 1──* Fingerprint (baseline contains metrics keyed by fingerprint)
Profile 1──* Run          (each run uses exactly one profile)
Rubric 1──* JudgeResult   (each rubric produces one judge result per run)
```

## Data Flow

```
Fixture (disk)
    ↓ discover & parse
run-eval.ts
    ↓ start opencode, execute command
opencode-driver.ts ──→ SSE events ──→ TokenCapture (in-memory)
    ↓ on completion
    ├── TokenData snapshot
    ├── workdir diff (git diff)
    ├── exit status
    └── (optional) judge.ts → JudgeResult
         ↓
    store.ts → runs.db (SQLite)
         ↓
    baseline comparison (if --baseline provided)
         ↓
    eval-summary.md (markdown report)
```
