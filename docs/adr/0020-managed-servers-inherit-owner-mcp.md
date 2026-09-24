# 20. Connect managed Codex Servers to the owner's MCP Package APIs

Status: accepted, 2026-09-24. Extends [ADR 0011](0011-owner-managed-mcp-inspector.md)'s live MCP catalogue and [ADR 0017](0017-persist-server-launch-arguments.md)'s separation of caller and launch-owned arguments.

The owner passes its actual MCP listener port to the Codex socket child. At each managed Server launch, including a Bot launch and restart, AgentStack reads the currently MCP-configured Package APIs and supplies their loopback URLs as Codex MCP configuration overrides under the Package API names. Codex merges individual configuration fields, so a pre-existing stdio MCP with the same name may conflict with the owner's URL override and must be removed or renamed before launch. The owner remains the single MCP listener and each Package API's socket Server remains the operation owner. The overrides are launch-owned, not persisted in the caller's argument array or per-Server identity.

This also works with an ephemeral owner port and newly configured Package APIs after a Server restarts. A live Server keeps its existing Codex configuration until it is restarted; starting it again idempotently does not change its running thread. A standalone Codex socket Server without an owner port does not claim owner MCP connections.
