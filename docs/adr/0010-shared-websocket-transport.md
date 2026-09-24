# 10. Forward WebSocket operations and events through socket owners

Status: accepted, 2026-09-24. Extends [ADR 0008](0008-mcp-rpc-transport.md)'s single-context forwarding and [ADR 0007](0007-bot-scoped-change-events.md)'s scoped change notices. Replaces the standalone event-only WebSocket described in [ADR 0002](0002-private-control-transport.md).

Every Package API configures WebSocket alongside its socket; the owner runs one loopback WebSocket child with a separate URL per package. JSON requests use the socket's `tools/list`, `tools/call`, and `events/subscribe` methods and its response and event notice shapes. The WebSocket child forwards operation calls to the owning socket and establishes a socket subscription per WebSocket connection, including its optional or required scope. It never creates another package context or bypasses the existing scope validator. A disconnected upstream subscription is reported to the client so it can reconnect, subscribe again, and snapshot state. A configured port makes URLs discoverable; an ephemeral port is printed at startup.

WebSocket is a trusted-local-machine control surface, not a public endpoint. It binds to loopback, validates Host and Origin, limits frames and outbound buffers, and requires a separate explicit deployment decision before any wider exposure. MCP remains operations-only.
