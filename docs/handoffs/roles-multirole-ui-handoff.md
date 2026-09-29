# Handoff 1 — Multi-role management and default selection

## Assignment

Design and implement the Roles UI for the delivered multi-role API in Stack.
This is a manual handoff from the human; no UI worker has been dispatched.
Internal Stack MCP toggles are a separate assignment in
[handoff 2](roles-internal-mcp-ui-handoff.md). Coordinate shared files with that
owner rather than implementing their controls independently.

Read `AGENTS.md`, `CONTEXT.md`, [ADR 0118](../adr/0118-multiple-roles-and-default.md),
the current Vercel design guidelines (`https://vercel.com/design.md`), the wiki's
“Vercel design guidance for native fleet apps,” and the existing Canvas/Roles
contracts before making visual decisions. Preserve Stack's visual language.
The human authorized this API change while accepting the interim Roles UI
breakage; existing singleton assumptions need replacement, not compatibility
fallbacks in the API.

## User outcome

People can create, browse, select, rename and delete Roles, and mark any existing
Role as default. They can manage each Role's existing instruction and resource
content. It must be clear which Role they are editing and which Role is default.
Selecting a Role for editing does not make it default.

Default currently means every later Bot launch and new Worker uses that Role.
There is no per-Bot assignment or role picker at launch. Changing the default or
editing content does not hot-update sessions. A Bot restart captures the current
default; Worker recovery retains its saved snapshot. No automatic restart is
authorized by a default change.

The first creation becomes default automatically. A fresh installation has no
Role; launching requires creating one. Existing installations migrate to a Role
named `Default`, preserving their content. The name has no special behavior; its
UUID is the identity. The default cannot be deleted. A non-default deletion
removes all its owned content but does not remove existing session snapshots.

## Delivered contract

```ts
type Role = {
  id: string;
  name: string;        // trimmed, 1..200 characters; unique using SQLite NOCASE
  description: string; // human-only, up to 4,000 characters
  revision: number;    // independent per Role
  createdAt: number | null;
  updatedAt: number | null;
};
type RoleCatalog = {
  revision: number;    // catalog-wide edit fence
  defaultRoleId: string | null;
  roles: Role[];       // creation order
};
```

| Operation | Input | Output / revision source |
| --- | --- | --- |
| `roles_snapshot` | `{}` | `RoleCatalog` |
| `role_create` | `{expectedRevision, name, description?}` | Catalog; use catalog revision |
| `role_set_default` | `{roleId, expectedRevision}` | Catalog; use catalog revision |
| `role_delete` | `{roleId, expectedRevision}` | Catalog; use catalog revision |
| `role_update` | `{roleId, expectedRevision, name?, description?}` | `{roleId, revision}`; use Role revision |
| `role_snapshot` | `{roleId}` | Role metadata + resources, with MCP summaries |
| `role_editor_snapshot` | `{roleId}` | Role metadata + complete resources, including private MCP definitions |
| `role_preview` | `{roleId}` | `{roleId, revision, rendered, segments, bytes, limitBytes}` |
| `role_launch_preview` | `{roleId, cwds?}` | Existing launch information plus `roleId`; internal MCP entries now have `{name, enabled}` |

Every existing Category, Fragment, skill, additional MCP server and trusted
project mutation now requires `roleId` alongside its existing input fields.
`expectedRevision` for those writes comes from that Role. Successful writes now
return compact `{roleId, revision}` receipts, **not snapshots**. Read
`role_editor_snapshot {roleId}` to refresh the operator editor after a write;
`role_snapshot {roleId}` is the credential-safe summary read. Catalog creation,
default selection and deletion still return the catalog. Compact receipts keep
the discovery reference within its existing response budget.

The socket-only `role_launch_snapshot {}` is for runtimes. It resolves the
default atomically and may contain credentials; do not use it in the UI or put
its result in agent transcripts. The editor/launch-preview operations remain
operator WebSocket/socket operations, not model-facing MCP operations.

`stack roles list` and `stack roles snapshot [role-id]` are read-only inspection
commands. The latter defaults to the current default if the ID is omitted.

## State and concurrency requirements

- Every successful write advances the catalog revision. Only a Role edit
  advances that Role's revision; default switches do not.
- Subscribe to the existing `role_changed` topic. It invalidates the catalog and
  potentially the selected Role; reread after subscription/reconnection too.
- Preserve ADR 0082's text drafts, immediate enable/reorder behavior, and conflict
  handling. Drafts, selection, cached records, previews and in-flight writes must
  be associated with a Role ID. Switching the default must never retarget a draft.
- Fence asynchronous responses with both Role ID and revision. A response from
  Role A must not replace Role B, even if A has a numerically higher revision.
- A stale write makes no change. Rebuild from a fresh snapshot only if intent is
  still valid. Catalog and Role revision fences are not interchangeable.
- Handle a selected Role being deleted by another client. Preserve unsaved work
  for human resolution; do not silently apply it to a different Role.
- Resource IDs remain globally stable, but resource operations reject IDs owned
  by another Role. Skill/MCP names and trusted paths may be repeated across Roles.
- Bot and Worker records now include `roleId: string | null`. Compare the pair
  `(roleId, roleRevision)` to show which snapshot was applied. Legacy null IDs
  mean unknown identity, not “the current default.” Deleted Roles may still be
  referenced by historical/running sessions.

## Code touchpoints

- API authority: `packages/roles/api.ts`, `api.yaml`, `src/store.ts`.
- Shared UI records and loading: `packages/ui/lib/stack/types.ts`, `store.ts`,
  `snapshot.ts`, `roles.ts`.
- Current role editor/list/preview: `packages/ui/components/canvas/role-*.tsx`.
- Space/window registration: `packages/ui/components/canvas/spaces.tsx` and
  `packages/ui/lib/stack/spaces.ts`; follow the existing Roles space.
- Applied-snapshot display: `role-preview.tsx`, the Role launch-comparison helper
  in `lib/stack/roles.ts`, and Bot/Worker inspector records.

The existing UI still requests singleton reads without `roleId` and sends
unscoped writes. Those requests intentionally fail against this API. Its Role
types and revision-only comparisons are also stale. Repair these as part of this
assignment; backend typechecking does not demonstrate UI compatibility.

## Acceptance and return

Verify a fresh empty catalog; first creation/default; two Roles with equal
revisions and different content; editing a non-default Role; default switching
with unsaved edits/in-flight reads; stale catalog and Role writes; default-delete
refusal; non-default deletion; and a selected Role deleted in another client.
Show that session launch-state comparisons use identity and revision and do not
claim a running process changed when only the default changed.

Use `pnpm --filter @stack/ui typecheck`, focused behavior tests, and rendered
inspection in an owned checkout. Follow the desktop/headful-browser resource
lease rules. A build/restart of the live server requires the existing operational
authority; do not replace its live `.next` directory or restart it implicitly.
Return the design rationale, implementation, verification evidence, and any
remaining human decisions. Delegation envelope: zero unless the human issuing
this handoff explicitly grants one.
