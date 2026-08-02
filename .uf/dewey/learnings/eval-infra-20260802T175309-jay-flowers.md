---
tag: eval-infra
author: jay-flowers
category: pattern
created_at: 2026-08-02T17:53:09Z
identity: eval-infra-20260802T175309-jay-flowers
tier: draft
---

When generalizing the AnswerContext from batch-fix-specific fields (issueUrl, issueTitle, issueNumber, changeName) to a fixture-driven vars: Record<string, string>, the key design decision was to keep all 40+ existing regex patterns as the shared base ANSWER_PATTERNS array and use optional chaining with ctx.vars.issueUrl ?? "" for backward compatibility. The loadFixtureAnswers() function parses answers.yaml into AnswerPattern objects, and mergePatterns() prepends fixture patterns before base patterns for first-match-wins composition. This means fixture-specific overrides always take priority, and the base patterns serve as a safety net for common questions.
