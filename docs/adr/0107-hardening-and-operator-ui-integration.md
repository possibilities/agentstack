# 107. Integrate hardening with the operator UI and authenticated remote gateway

Status: accepted, 2026-09-28. Reconciles [ADR 0098](0098-roles-space-for-launch-resources.md), [ADR 0101](0101-remote-uix-through-access.md), [ADR 0103](0103-scrape-space-and-local-operator-exposure.md) and [ADR 0106](0106-local-surface-hardening.md).

## Decision

Preserve both the operator Role resource editor and credential-safe ordinary reads. `role_snapshot` and mutation replies retain MCP server summaries. The editor reads complete definitions through `role_editor_snapshot`, exposed on socket and WebSocket but excluded from MCP. `role_launch_preview` also remains available to the operator UI over WebSocket, with its exact configuration, and is excluded from MCP because that configuration may contain credentials. Native launch's `role_launch_snapshot` remains socket-only. Role editor data loads over WebSocket rather than embedding connection definitions in server-rendered HTML. After a write, the editor re-reads the operator snapshot; it never replaces definitions with summarized mutation output.

Authenticated remote UIX retains its existing Role resource viewing and editing policy: the Access gateway intersects live WebSocket exposure with the approved browser grant, fences changes and expiry, and never performs trusted-local snapshot reads during remote rendering. The separate local WebSocket listener retains exact UIX Origin and loopback Host checks. Both gateways reject client-supplied invocation context. The Access ingress performs its own exact Host/Origin and cookie checks on its attached TLS listener.

Scrape's longer browser, feed, replay, canary and queue waits join the shared forwarding budget used by MCP, WebSocket, subscription reads and Proc. Native MCP waits continue to outlast their gateway budgets.

The independent Proc and hardening ADRs are renumbered 0105 and 0106 to retain the already-published 0097 and 0098 documents without duplicate decision numbers.
