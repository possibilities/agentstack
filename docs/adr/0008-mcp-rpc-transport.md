# 8. Serve MCP operations through the socket owners

Status: accepted, 2026-09-24. Supersedes [ADR 0001](0001-package-apis.md)'s socket-only MCP client guidance and extends the local control boundary in [ADR 0002](0002-private-control-transport.md).

The `auth`, `bots`, `codex`, and `owner` Package APIs each configure MCP. One owned loopback HTTP process serves their separate Streamable HTTP URLs and generates tools from the same operation names, descriptions, input and output schemas, and annotations used by the socket transport. Calls forward to the corresponding private socket. That socket Server remains the sole owner of its context and any managed processes; starting MCP cannot create a competing context or reconcile persisted children twice. The `api` discovery Package API remains socket-only.

MCP is stateless and exposes RPC tools only. Event subscriptions remain on socket and WebSocket transports; whether to expose them over MCP is deferred. A fixed default port makes inspector URLs discoverable in the API reference, with a configurable or ephemeral port for other local uses. The HTTP process binds to loopback and validates Host and Origin, but has no client authentication, so it must not be exposed outside the trusted local machine.
