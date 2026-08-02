---
tag: eval-infra
author: jay-flowers
category: gotcha
created_at: 2026-08-02T17:53:05Z
identity: eval-infra-20260802T175305-jay-flowers
tier: draft
---

When parsing CLI numeric arguments with Number() in TypeScript, using the nullish coalescing operator (??) instead of logical OR (||) is a dangerous gotcha. Number(undefined) returns NaN, which is NOT null or undefined, so ?? does not trigger the fallback. This means --epsilon passed without a value silently becomes NaN, causing all comparisons like NaN > threshold to return false — silently disabling the regression detection gate. Always use || for Number() conversions where NaN should fall back to a default. This was caught in code review for eval-infra's run-eval.ts epsilon and tolerance argument parsing.
