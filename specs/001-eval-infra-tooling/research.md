# Research: Eval Infrastructure Tooling

**Feature Branch**: `001-eval-infra-tooling` | **Date**: 2026-08-02

## Research Questions

### RQ-1: What is the opencode SDK v2 SSE event schema for token capture?

**Status**: Partially resolved — needs runtime verification

The plan document references `step_finish.tokens.input`, `step_finish.tokens.output`, `step_finish.tokens.cache.read`, `step_finish.tokens.cache.write`, and `step_finish.cost` as the event property paths. These are derived from the existing `scripted/opencode-driver.ts` (330 lines) which already handles SSE events successfully.

**Remaining unknown**: The exact TypeScript types from `@opencode-ai/sdk` v2 for these events. The SDK exports types that should be used instead of `any`. During implementation, import and use the SDK's event type definitions.

**Mitigation**: Pin `@opencode-ai/sdk` to `^1.18.4`. Add runtime validation in `token-capture.ts` to handle missing/renamed properties gracefully.

### RQ-2: Does `better-sqlite3` work with bun natively?

**Status**: Resolved — yes

`better-sqlite3` is a native Node addon. Bun supports native addons via its Node.js compatibility layer. The package is widely used with bun in production. No special configuration needed beyond `bun install`.

### RQ-3: How does DCP config discovery work?

**Status**: Deferred — Phase 0 concern

DCP config discovery (whether it reads from `.opencode/dcp.jsonc` in the project directory) needs runtime testing before Phase 0 config migration. This does not block eval-infra implementation since eval profiles inject config via environment variable override (`OPENCODE_CONFIG_CONTENT`), which has higher precedence than any file-based config.

### RQ-4: What is the GCP Workload Identity Federation setup for `jflowers/eval-infra`?

**Status**: Resolved — pattern proven

The WIF auth pattern is proven in `unbound-force/gaze/.github/workflows/test.yml`. The same GCP project and WIF provider can be reused. Steps:
1. Add `jflowers/eval-infra` to the WIF allowed-repos list in GCP IAM console
2. Configure `GCP_PROJECT_ID` and `GCP_WORKLOAD_IDENTITY_PROVIDER` as GitHub repository secrets
3. Use `google-github-actions/auth@v3` with `id-token: write` permission

### RQ-5: How should config profiles be injected during eval runs?

**Status**: Resolved

Profiles are injected via the `OPENCODE_CONFIG_CONTENT` environment variable, which takes higher precedence than project-level `opencode.json`. Each profile is a JSON file in `profiles/` that contains config overrides. The eval driver reads the profile file and sets the env var before starting the opencode server.

### RQ-6: What is the reusable workflow consumption pattern?

**Status**: Resolved

The `complytime/org-infra` pattern is the reference: `ci_crapload.yml` in `unbound-force/unbound-force` consumes `complytime/org-infra/.github/workflows/reusable_crapload_analysis.yml` via `workflow_call`. A separate `post-comment` job downloads the artifact and posts a PR comment via `actions/github-script`. This exact pattern applies to eval result reporting.

### RQ-7: How should the eval driver handle opencode server lifecycle?

**Status**: Resolved — existing code handles this

The existing `scripted/opencode-driver.ts` already handles:
- Server startup with configurable port
- Health check polling (wait for server ready)
- Session creation
- Command execution via SSE event streaming
- Question auto-response (regex pattern matching)
- Permission auto-approval
- Graceful shutdown

This code is ported directly into `driver/opencode-driver.ts`.

### RQ-8: What YAML parser should be used?

**Status**: Resolved — `yaml` package (v2.4.0+)

The `yaml` package is the standard YAML parser for Node.js/bun. It supports YAML 1.2, handles frontmatter parsing (needed for `rubric.md`), and has TypeScript types included.

## Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | bun | Faster installs, native TS execution, matches plan intent |
| Database | better-sqlite3 (SQLite) | Local-only, artifact-based, no server needed |
| YAML parser | `yaml` ^2.4.0 | Standard, YAML 1.2 compliant, TS types included |
| SDK | `@opencode-ai/sdk` ^1.18.4 | Required for headless opencode session management |
| CI auth | GCP WIF via `google-github-actions/auth@v3` | Proven pattern, no service account keys |
| Config injection | `OPENCODE_CONFIG_CONTENT` env var | Higher precedence than file config, no file mutation |

## Risks Identified

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `step_finish` event shape changes across opencode versions | Medium | Medium | Pin version; add schema validation; test against SDK types |
| Large transcripts exceed judge context window | Medium | Medium | Truncate to last N turns for judge; full transcript in artifact |
| Eval costs accumulate with many fixtures | Medium | Medium | Start with 1 self-test fixture; add dry-run mode in Phase 4 |
| opencode server port conflicts in CI | Low | Low | Random port selection or per-fixture port offset |
| bun native addon compatibility issues | Low | Low | `better-sqlite3` is well-tested with bun; fallback to `bun:sqlite` if needed |
