---
tag: eval-infra
author: jay-flowers
category: pattern
created_at: 2026-08-02T17:53:02Z
identity: eval-infra-20260802T175302-jay-flowers
tier: draft
---

When porting the opencode driver from scripted/opencode-driver.ts to eval-infra, the key architectural addition was the onEvent callback hook in DriverOptions. This allows the token-capture module to tap into the SSE event stream without modifying the driver itself — a clean Observer pattern. The driver calls opts.onEvent?.(event) for every SSE event in the runCommand loop, and TokenCapture.handleEvent() accumulates metrics from step_finish, step_start, and tool_use events. This decoupling means the driver can be reused for batch-fix orchestration or other purposes without token capture overhead.
