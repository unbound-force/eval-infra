# Quickstart: Eval Infrastructure Tooling

**Feature Branch**: `001-eval-infra-tooling` | **Date**: 2026-08-02

## Prerequisites

- **bun** >= 1.0 — `curl -fsSL https://bun.sh/install | bash`
- **opencode** — `npm install -g opencode-ai@1.2.26`
- **GCP credentials** — For Vertex AI model access (local dev: `gcloud auth application-default login`; CI: Workload Identity Federation)

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/jflowers/eval-infra.git
cd eval-infra
cd driver && bun install
```

### 2. Run the self-test fixture

```bash
cd driver
bun run-eval.ts \
  --fixtures ../.eval/fixtures \
  --model google-vertex-anthropic/claude-opus-4-6@default \
  --repo jflowers/eval-infra \
  --output ../eval-out
```

This executes the `driver-smoke` fixture against your local opencode installation and produces:
- `eval-out/runs.db` — SQLite database with the run results
- `eval-out/eval-summary.md` — Markdown summary table

### 3. Run with baseline comparison

```bash
bun run-eval.ts \
  --fixtures ../.eval/fixtures \
  --baseline ../.eval/baseline.json \
  --model google-vertex-anthropic/claude-opus-4-6@default \
  --repo jflowers/eval-infra \
  --output ../eval-out
```

Exits non-zero if any fixture regresses beyond the configured epsilon (default 10% for cost, 0.05 for quality score).

### 4. Export a new baseline

After a successful run:

```bash
bun run-eval.ts --export-baseline --output ../eval-out
```

This dumps the current `runs.db` to `baseline.json` format, which can be committed as the new reference point.

### 5. Dry-run mode (Phase 4)

```bash
bun run-eval.ts --dry-run --fixtures ../.eval/fixtures
```

Lists fixtures that would run and estimated costs based on historical data, without executing any opencode sessions.

## Adding Eval to Your Repository

### 1. Create fixture directories

```
your-repo/
└── .eval/
    ├── baseline.json          # Empty initially: {}
    └── fixtures/
        └── my-command/
            ├── task.yaml      # Task metadata
            ├── prompt.md      # Input prompt
            ├── answers.yaml   # Optional: question overrides
            └── rubric.md      # Optional: quality rubric
```

### 2. Write task.yaml

```yaml
task_id: my-command-basic
task_version: "1"
description: "Basic test of my-command"
exec_mode: interactive
command: my-command
timeout_seconds: 900
```

### 3. Write prompt.md

```markdown
Add a --verbose flag to the build command that shows detailed compilation output
```

### 4. (Optional) Write answers.yaml

Override question-answer patterns for your command's specific interactive questions:

```yaml
patterns:
  - match: "what.*change.*work on"
    action: reply
    labels: [["Add a --verbose flag to the build command"]]
  - match: "uncommitted|dirty"
    action: reply
    labels: [["Yes"]]
```

The 40+ base patterns from `eval-infra/driver/answers.ts` handle common opencode questions automatically. Only add overrides for command-specific questions.

### 5. Add the caller workflow

Create `.github/workflows/ci_eval.yml`:

```yaml
name: Eval
on:
  pull_request:
    branches: [main]
    paths:
      - '.opencode/**'
      - '.eval/**'

permissions: {}

jobs:
  eval:
    uses: jflowers/eval-infra/.github/workflows/reusable_opencode_eval.yml@main
    permissions:
      contents: read
      id-token: write
    secrets:
      gcp_project_id: ${{ secrets.GCP_PROJECT_ID }}
      gcp_workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
    with:
      fixture-path: .eval/fixtures
      baseline-path: .eval/baseline.json
      opencode-version: '1.2.26'
      model: 'google-vertex-anthropic/claude-opus-4-6@default'
      timeout-minutes: 60

  post-comment:
    name: Post Eval Results
    needs: eval
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - name: Download eval results
        id: download
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: eval-results
          path: artifact

      - name: Post or update PR comment
        continue-on-error: true
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const marker = '<!-- eval-infra-marker -->';
            const summaryPath = 'artifact/eval-summary.md';
            let body;
            if (fs.existsSync(summaryPath)) {
              body = marker + '\n' + fs.readFileSync(summaryPath, 'utf8');
            } else {
              body = marker + '\n## Eval Results\n\nNo summary generated.';
            }
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c => c.body.includes(marker));
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body,
              });
            }
```

### 6. Configure GCP WIF secrets

Add these repository secrets in GitHub Settings → Secrets and variables → Actions:

- `GCP_PROJECT_ID` — Your GCP project ID
- `GCP_WORKLOAD_IDENTITY_PROVIDER` — Your WIF provider (format: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`)

### 7. Bootstrap the baseline

1. Commit with an empty baseline: `echo '{}' > .eval/baseline.json`
2. Let the first CI run complete successfully
3. Download the `eval-results` artifact
4. Use `bun run-eval.ts --export-baseline` to generate `baseline.json`
5. Commit the populated `baseline.json` — subsequent PRs compare against it

## CLI Reference

```
bun run-eval.ts [options]

Options:
  --fixtures <path>     Path to fixture directory (scans for task.yaml files)
  --baseline <path>     Path to baseline.json for regression comparison
  --model <id>          Model identifier for eval runs
  --profile <name>      Config profile name (maps to profiles/<name>.json)
  --repo <owner/name>   Repository identifier for run metadata
  --git-sha <sha>       Git commit SHA (auto-detected in CI)
  --git-branch <name>   Git branch name (auto-detected in CI)
  --output <path>       Output directory for runs.db and eval-summary.md
  --timeout <seconds>   Override per-fixture timeout
  --export-baseline     Export current runs.db as baseline.json
  --dry-run             List fixtures and estimate costs without executing
  --epsilon <float>     Cost regression threshold (default: 0.10 = 10%)
  --tolerance <float>   Quality regression tolerance (default: 0.05)
```

## Project Structure

```
eval-infra/
├── driver/                          # TypeScript eval driver (bun)
│   ├── package.json                 # Dependencies: @opencode-ai/sdk, better-sqlite3, yaml
│   ├── tsconfig.json
│   ├── run-eval.ts                  # CLI entrypoint
│   ├── opencode-driver.ts           # Headless opencode session driver
│   ├── answers.ts                   # Base question-answer patterns (40+)
│   ├── token-capture.ts             # SSE event → token metrics accumulator
│   ├── store.ts                     # SQLite runs.db schema + CRUD operations
│   ├── fingerprint.ts               # Row identity hashing
│   └── judge.ts                     # LLM-as-judge rubric evaluator
│
├── profiles/                        # Config variant profiles
│   ├── baseline.json                # Production config (hashline, no DCP)
│   ├── dcp-soft.json                # +DCP (soft nudge)
│   └── dcp-aggressive.json          # +DCP (aggressive)
│
├── .eval/fixtures/                  # Self-test fixtures
│   └── driver-smoke/
│       ├── task.yaml
│       ├── prompt.md
│       ├── rubric.md
│       └── answers.yaml
│
├── .github/workflows/
│   ├── reusable_opencode_eval.yml   # Reusable workflow for consumers
│   └── ci_self_test.yml             # Self-test against own fixtures
│
└── README.md
```
