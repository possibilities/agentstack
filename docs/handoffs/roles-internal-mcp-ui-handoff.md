# Handoff 2 — Per-Role internal Stack MCP controls

## Assignment

Design and implement controls for the delivered per-Role internal MCP API.
This is a separate manual handoff from the human; no UI worker has been
dispatched. [Handoff 1](roles-multirole-ui-handoff.md) owns multi-role selection,
default management and shared Role-scoped UI state. Coordinate shared types,
store/editor changes and the selected Role ID with that owner. Do not build a
second selector or default-management flow.

Read `AGENTS.md`, `CONTEXT.md`, [ADR 0119](../adr/0119-per-role-internal-mcp.md),
the current Vercel design guidelines (`https://vercel.com/design.md`), the wiki's
“Vercel design guidance for native fleet apps,” and the existing Roles/Canvas
contracts before choosing the presentation. Use Stack's established language.

## User outcome

People can see every internal MCP server that Stack currently exports and turn
each one on or off for the selected Role. Internal servers come from
`packages/*/api.yaml` through the shared API registry. Their transport definitions
and operation exposure are owned by their packages; the Role controls whether a
launch receives a connection.

All internal servers are enabled in the migrated default Role and in every new
Role. Newly added internal servers are enabled automatically. Settings are local
to each Role. Changing the default uses the new Role's settings on later
launches. Additional Role-owned MCP definitions retain their existing CRUD and
are a separate concept from these internal connection switches.

Turning an internal server off does not shut down that package, change its API
manifest, remove its socket/WebSocket surface, revoke authorization, or change
running sessions. New Bot launches and new Workers apply the setting. Worker
recovery keeps its saved settings. Any internal server can be disabled, including
`roles`; operator editing remains available outside the launched agent.

## Delivered contract

```ts
// role_internal_mcp_list input
{ roleId: string }

// output
{
  roleId: string;
  revision: number; // selected Role's revision
  servers: Array<{ name: string; enabled: boolean }>;
}

// role_internal_mcp_update input
{
  roleId: string;
  expectedRevision: number; // selected Role's revision, not catalog revision
  name: string;            // exact configured package name from the list
  enabled: boolean;
}
// output: { roleId: string; revision: number }
```

Role snapshots now contain `disabledInternalMcpServers: string[]`. The list
operation derives effective enablement from current discovery and this stored
deny-list. Do not present the deny-list as the available inventory: an empty
array means all internal servers are on, not that none exist. Entries for
temporarily absent packages are retained in snapshots and apply if the package
returns; list output includes only currently configured packages. Updating an
unknown/unavailable package name is rejected.

Update replies are compact receipts, not snapshots. Refresh the selected Role's
inventory and editor/preview after success; do not merge a receipt into a cached
Role as though it contained resources.

`role_launch_preview {roleId, cwds?}` now returns
`internalMcpServers: Array<{name, enabled}>` instead of `string[]`. It contains
both on and off internal servers for that Role. The preview's `config` field
still describes additional Role-owned MCP configuration, not generated internal
identity-bound URLs. Never fabricate or display credential-bearing runtime URLs.

Both operations are available through socket, MCP and operator WebSocket.
Worker-origin MCP has read-only listing access. Updates increment the Role and
catalog revisions and publish `role_changed`. No-op successful writes also
advance revisions, matching existing resource-write behavior. A stale write
commits nothing.

## Integration requirements

- Operate on the selected Role ID supplied by handoff 1, not a freshly resolved
  default on each click. Editing a non-default Role must leave the default alone.
- Associate inventory, toggle writes and responses with the selected Role ID;
  ignore late responses from another Role. Use Role revision conflict handling.
- Reread on `role_changed` and reconnect. Also refresh the available inventory
  when package discovery changes: manifest changes do not advance Role revisions.
- Preserve existing external MCP editing. Its collision check must use **all**
  internal package names, including disabled ones; disabling a built-in does not
  make its name available for an external replacement.
- Preview/counts must distinguish available internal servers from enabled
  connections. Do not say every listed server reaches the next launch.
- Explain later-launch application and default-on behavior for new packages
  using concise copy. Do not add automatic restarts or per-operation permissions.

## Code touchpoints

- API/discovery: `packages/roles/api.ts`, `api.yaml`; shared
  `configuredMcpPackages` under `packages/api`.
- Persistence: `packages/roles/src/store.ts`, `src/schema.ts`.
- Runtime behavior already delivered: `packages/roles/src/bundle.ts` and
  `packages/worker/src/resources.ts`.
- UI types/store: `packages/ui/lib/stack/types.ts`, `store.ts`, `roles.ts`.
- Existing additional MCP editing and reserved-name validation:
  `packages/ui/components/canvas/role-resource-editor.tsx`.
- Existing launch preview:
  `packages/ui/components/canvas/role-preview.tsx`.

The UI still treats internal preview entries as strings and currently provides
no internal-server toggles. The human explicitly accepted this interim
incompatibility for separate API and UI delivery. Update the stale shape and
name validation while implementing this assignment.

## Acceptance and return

Verify all-on for a migrated/default Role and a newly created Role; switching
off one server without affecting another Role; off then on; all servers off;
switching Role during an in-flight update; stale-revision refusal and recovery;
default-on when a new internal package appears; and a disabled name remaining
reserved against external MCP collisions. Preview must match effective
enablement and describe running sessions truthfully.

Run `pnpm --filter @stack/ui typecheck`, focused behavior tests and rendered
inspection in an owned checkout. Coordinate verification with handoff 1. Follow
resource leases for headful browser/desktop use. Do not rebuild the live server's
`.next` directory or restart it implicitly. Return the design rationale,
implementation, verification evidence and unresolved human decisions.
Delegation envelope: zero unless the human issuing this handoff explicitly
grants one.
