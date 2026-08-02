<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/001-eval-infra-tooling/plan.md`

### Project Overview
- **Type**: CLI tool + reusable GitHub Actions workflow
- **Runtime**: TypeScript on bun
- **Key deps**: `@opencode-ai/sdk` ^1.18.4, `better-sqlite3` ^13.0.0, `yaml` ^2.4.0
- **Storage**: SQLite (artifact-only `runs.db`), committed `baseline.json`

### Build & Test Commands
```bash
cd driver && bun install          # Install dependencies
cd driver && bun run eval         # Run eval (bun run-eval.ts)
cd driver && bun run typecheck    # Type check (bunx tsc --noEmit)
cd driver && bun test             # Run tests
```

### Project Structure
```
driver/           # TypeScript eval driver (bun package root)
profiles/         # Config variant profiles (baseline, dcp-soft, dcp-aggressive)
.eval/fixtures/   # Self-test fixtures
.github/workflows/ # Reusable + self-test workflows
specs/            # Speckit spec artifacts
```
<!-- SPECKIT END -->

## Convention Packs

This repository uses convention packs scaffolded by
unbound-force. Agents MUST read the applicable pack(s)
before writing or reviewing code.

- `.opencode/uf/packs/default.md`
- `.opencode/uf/packs/severity.md`
- `.opencode/uf/packs/content.md`
- `.opencode/uf/packs/ci.md`
