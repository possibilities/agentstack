# 55. Keep agent-tree observations with Bots and Workers

Status: accepted, 2026-09-25. Extends [ADR 0043](0043-bot-chat-apis.md), [ADR 0038](0038-durable-acp-worker-execution.md), and [ADR 0039](0039-worker-wakeups-and-scoped-mcp.md).

UIs need identities, relationships, lifecycle state, configuration, and conversation evidence to inspect delegated work. The `bots` Package API owns Codex child-thread observations; `workers` owns ACP session observations. A separate Package API would duplicate lifecycle ownership and lineage checks. A Worker's existing `botId` and originating `threadId` attach it to the corresponding Bot tree without pretending that an ACP session is a Codex Chat.

Codex tree reads admit only the Bot's adopted main thread and proven descendants, including nested descendants. Live native metadata and durable rollout evidence complement each other: a child may exist before its rollout is materialized, and a historical child may no longer be loaded. Historical evidence is not a current activity verdict. Tree summaries remain bounded; prompts, creation arguments, and native details are read separately with explicit provenance and completeness limits.

Worker reads retain structured ACP observations alongside the existing bounded text transcript. Submitted turn input and requested model/effort are durable admission facts; observed session configuration is separate evidence. Tool call IDs, partial updates, structured content, and provider metadata must survive projection so a UI can reconcile a tool's changing state. Raw reasoning remains excluded. AgentStack's private MCP proofs and credential-bearing launch configuration are not conversation metadata.

ACP does not promise a portable nested-session tree. Report only child/task evidence the actual provider exposes, and label coverage rather than treating missing children as proof that no subagents exist. A tool call, task invocation, or vendor session reference alone does not establish a complete child conversation or its model, effort, parentage, and lifecycle.

Events remain payload-free invalidations. UI progress observations are separate from `worker_changed`, whose originating-Bot wakeup contract remains lifecycle and attention-oriented. Clients subscribe, take a snapshot, and re-read after notices or reconnection; notices are neither a transcript nor a replay guarantee. The current canvas keeps existing records and discovery accurate. Dedicated tree and conversation views require a separate UI request.
