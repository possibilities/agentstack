# 60. Share the Worker lifecycle with native Claude SDK sessions

Status: accepted, 2026-09-25. Extends [ADR 0036](0036-account-bound-acp-foundation.md), [ADR 0038](0038-durable-acp-worker-execution.md), [ADR 0039](0039-worker-wakeups-and-scoped-mcp.md), [ADR 0044](0044-owner-usage-observations.md), and [ADR 0050](0050-api-driven-worker-sign-in.md). Supersedes their ACP-only definition of a Worker; their ACP implementation and lifecycle invariants remain applicable to Codex, Grok and Devin.

## Decision

Claude is a fourth Worker provider in the existing `auth`, `workers`, and `usage` Package APIs. The official, pinned Claude Agent SDK owns its native session/control channel. A backend boundary adapts it to the existing durable Worker manager rather than creating another account inventory, turn ledger, worktree owner, permission API, or set of completion subscriptions. Its catalog and runtime metadata identify the SDK explicitly; Claude is not described as an ACP server.

The useful collaboration contract is already shared: select an exact account and observed model/effort, start in an owned Git worktree, read progress, answer exact permission requests, send corrections to the same session, cancel, inspect an interrupted outcome, and explicitly recover. The SDK supplies native session continuity, tool permission callbacks and no-turn model discovery that a one-shot `claude -p` wrapper would have to reconstruct. Native result failures must remain failures, and unexpected stream loss remains `unknown`; admission is never completion.

The public Worker identity field is `sessionId`, replacing `acpSessionId`. This is a deliberate schema change for direct API consumers; the canvas and discovery reference change together. Existing durable ACP session identities remain readable from their stored ledger column. Worker IDs, request IDs, operations, event topics and ownership checks are unchanged.

## Accounts and observations

Every Claude account uses its own native Claude Code sign-in under AgentStack state. AgentUsage's source informs credential isolation and quota parsing; its account inventory, credentials, proxy, selection and balancing policies are not imported. Native Claude remains responsible for refreshing its credentials. Ambient Anthropic keys, OAuth overrides, provider selection and routing variables cannot silently choose another identity for an AgentStack Worker.

The existing account login operations surface a copyable native sign-in link and any required paste-back code. Only the human visits that link. Account disabling and removal drain the exact account backend, preserving Worker records for inspection. Read-only usage observations retain the last good measurement, time, freshness and sanitized failure code; quota is not a dispatch recommendation.

Fleet gains Claude in its existing Worker account, sign-in, usage and model-catalog surfaces. This extends the flows in [ADR 0049](0049-canvas-worker-account-controls.md) and [ADR 0056](0056-fleet-usage-catalogs-and-bot-controls.md), without adding a second Claude-only workbench.

## Consequences

- Role instructions, skills and MCP definitions remain a private per-Worker snapshot. Claude receives instructions through the SDK's native system-prompt append, while existing ACP-specific Role delivery stays explicit.
- Signed internal MCP URLs retain the exact Worker/runtime-instance check and read-only operation scope. Replacing a backend, disabling an account, or closing a Worker invalidates its earlier connection. This remains a same-user trust boundary.
- Claude availability need not correspond to one shared per-account PID. Runtime views distinguish `backend` and `processModel`, with `pids` for actual native process roots. Resource observations group verified roots under their account/runtime and mark missing attribution rather than inventing a shared ACP process or per-turn resource cost.
- Recovery never resubmits a prompt. Unknown outcomes require explicit acknowledgement after inspecting the worktree, and native session availability is checked before continuation.
- Native child-tool evidence does not become a verified Bot subagent tree. Coverage and replay limitations remain visible in Worker detail and structured records.
