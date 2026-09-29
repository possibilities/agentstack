# 119. Per-Role internal MCP enablement

Status: accepted, 2026-09-28. Extends [ADR 0118](0118-multiple-roles-and-default.md)
and supersedes the unconditional internal MCP inheritance of
[ADR 0021](0021-managed-servers-inherit-owner-mcp.md). Additional Role-owned MCP
servers retain [ADR 0031](0031-role-resources.md).

## Decision

Every Role starts with every configured internal Stack MCP server enabled.
This includes the migrated default Role and all newly created Roles. Discovery
uses `configuredMcpPackages`, the same `packages/*/api.yaml` declarations used by
the shared API registry. No second package inventory is maintained.

A Role stores only the names it has explicitly disabled, exposed as
`disabledInternalMcpServers` in its snapshots. Therefore newly configured
internal MCP servers are enabled automatically. Disabled names survive a
package disappearing and returning. These settings are independent of the
Role's additional external MCP definitions and of other Roles.

- `role_internal_mcp_list {roleId}` returns
  `{roleId, revision, servers: [{name, enabled}]}` for currently configured
  internal MCP packages.
- `role_internal_mcp_update {roleId, expectedRevision, name, enabled}` changes
  one configured package's setting and returns `{roleId, revision}`. Unknown
  package names are rejected. It uses the Role revision and publishes
  `role_changed`, like other Role edits.
- `role_launch_preview.internalMcpServers` is now `[{name, enabled}]`, including
  disabled entries. It describes the selected Role, not necessarily the default.

Bot launch materialization and the shared Worker session MCP builder filter
the owner-provided internal connections using the captured Role snapshot.
Enabled connections retain their bound Bot/Worker identity URLs and existing
operation-scoping rules. Additional enabled Role MCP servers are unaffected.
All internal names remain reserved against additional-server collisions,
including disabled ones.

All internal servers may be disabled, including `roles`. The operator's local
socket and WebSocket control surfaces are independent of launch connections.
These are connection settings, not an authorization policy, server shutdown,
transport exposure change, or operation-level filter. Running sessions retain
their connections; later Bot launches/new Workers use current settings. Worker
recovery uses its saved settings. Pre-feature Worker snapshots imply no disabled
internal servers, preserving their original behavior.

Read and update operations are exposed through socket, MCP and WebSocket.
Worker-origin MCP may list internal enablement but may not change it. Complete
connection definitions retain the existing operator/runtime-only boundaries.

## Consequences

The catalog revision tracks Role edits, not changes to package manifests.
Clients refresh the available package inventory on reconnect/discovery refresh,
as well as after Role changes. A Role revision alone is not a fingerprint of all
runtime-installed packages.

The separate manual UI handoff is
[`roles-internal-mcp-ui-handoff.md`](../handoffs/roles-internal-mcp-ui-handoff.md).
The API work does not add UI controls or restart running sessions.
