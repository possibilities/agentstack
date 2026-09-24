# 20. Admit WebSocket connections from current Package API configuration

Status: accepted, 2026-09-24. Extends [ADR 0010](0010-shared-websocket-transport.md)'s shared listener and aligns admission with [ADR 0008](0008-mcp-rpc-transport.md)'s live MCP configuration.

The WebSocket listener reads `api.yaml` on each new handshake rather than retaining its startup package list as an allowlist. A newly enabled Package API path becomes available without restarting the listener, and a disabled path rejects new connections. Existing connections remain open and continue to forward to their socket Server; configuration changes do not silently revoke an active subscription. An invalid or unreadable configuration fails new admissions as unavailable. Host and Origin checks still precede configuration access, and the socket Server remains the sole owner of operations and event scope validation.

Printed URLs are a startup snapshot. Discovery reports configured URLs from current configuration, not the liveness of an upstream socket Server. A configured path whose socket Server is unavailable can accept a WebSocket connection but reports failure on forwarded operations or subscriptions, as before.
