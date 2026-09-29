# 94. Name the three Package APIs signal, browse and worker

Status: accepted, 2026-09-28. Amends the package addresses in [ADR 0075](0075-headless-conversation-attention.md), [ADR 0092](0092-durable-bot-browser-profiles.md), [ADR 0093](0093-enforced-browser-handoff.md), and [ADR 0038](0038-durable-acp-worker-execution.md); their behavior and ownership decisions remain in force.

## Decision

The packages, workspace dependencies, discovery names, owner children, socket paths, MCP URLs and WebSocket package selectors are `signal`, `browse` and `worker`, published as `@stack/signal`, `@stack/browse` and `@stack/worker`. No old Package API addresses are served. Signal's package-level invalidation topic becomes `signal_changed`; the Browser profile/handoff topics and the Worker collection/scoped topics retain their domain names. Operations retain `attention_*`, `browser_*`, `agent_browser_*` and `worker_*`: these describe the records and actions, not the Package API address. The external `agent-browser` command and provider protocol are unchanged.

Durable state paths do **not** move. `<state>/attention/attention.sqlite` contains captured interpretation history; `<state>/browser` holds profiles, leases, provider configs and the installed agent-browser toolchain; `<state>/workers.sqlite` and `<state>/workers/{worktrees,roles}` hold Worker history and paths recorded in the ledger. Moving these would invalidate stored absolute worktree paths and the existing AgentStart toolchain link, and could interrupt a live owner. Historical source provenance `workers` and Browser target ownership tags also retain their identities. A package address is not a state-directory migration.

## Consequences

Clients re-discover and reconnect to the new addresses after the rebuilt owner is restarted; Signal subscribers re-subscribe to `signal_changed`. The owner's durable Bot event subscriptions replace old package selectors in place before reconnecting (and the old Signal topic if one was recorded), retaining IDs and read arguments. Existing records, worktrees, toolchain links and Browser profiles remain where they are. AgentStart's tracked provider command points to `packages/browse/dist/src/provider.js`; convergence of that config and any running owner restart are separate from building this change.
