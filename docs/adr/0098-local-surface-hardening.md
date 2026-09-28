# 98. Keep launch secrets out of ordinary reads and pin browser control origins

Status: accepted, 2026-09-28. Extends [ADR 0096](0096-explicit-transport-exposure.md).

## Decision

`role_snapshot` and all Role edit results return MCP server summaries (`id`, `name`, `description`, `enabled`, `transport`). They omit complete connection definitions, including URLs and argv as well as literal headers and environment values: all can contain credentials. Native Worker launch reads the full Role through `role_launch_snapshot`, selected only on the private socket. Bot launch continues to materialize the authoritative store. This keeps launch behavior intact without copying connection secrets into SSR HTML, inspectors, read-only Worker tools or Bot event turns. Updating a definition still replaces that definition explicitly; metadata-only edits retain it. The live reference documents both schemas.

Brain's `share_receive` and `share_read_states` are likewise socket-only internal seams for Access. MCP and WebSocket use explicit positive selections for Brain and Roles. This curates the direct transport surfaces; it is not an OS isolation guarantee or a restriction on Proc's currently operator-authority API dispatch.

Browser WebSocket admission defaults to the exact HTTP UIX origins on `AGENTSTACK_UIX_PORT` (8745 by default), using `127.0.0.1` or `localhost`. `AGENTSTACK_WEBSOCKET_ORIGIN` replaces those defaults with one explicit origin for development. Native clients without an Origin remain supported. The WebSocket gateway rejects client-supplied invocation context. UIX, loopback HTTP surfaces, managed browser gates and CDP relays validate Host before serving private data; browser gate upgrades also validate Origin.

All MCP subscription reads carry the subscribing Bot's context. Chat/thread/live/queue topics cannot watch their own Bot or form a cross-Bot dependency cycle. Existing durable watches are checked on resume and before delivery. These checks prevent direct turn-feedback cycles; indirect workflows and high-rate external topics still need a separate delivery-budget design.

Gateway, scheduler and subscription response waits use one shared, package-qualified timeout policy. Internal Codex MCP configuration outlasts that package's gateway budget. Timeouts remain uncertain outcomes, not operation cancellation. The catalog test rejects stale policy entries. Moving these budgets into operation declarations is a future compatible extension.

## Compatibility

Consumers of `role_snapshot.mcpServers[].definition` must use the summary's `transport` field for display. Trusted runtime launch code uses the new socket read. No public secret-reveal control is added. Deploy the matching package builds together and restart the owner explicitly; editing source is not deployment.
