# 118. Named Roles with one launch default

Status: accepted, 2026-09-28. Supersedes the singleton decision in
[ADR 0030](0030-single-role-package.md) and the global-revision assumption in
[ADR 0082](0082-roles-space-for-instruction-fragments.md). Retains private launch
snapshots, resource ordering, rendering, and credential-safe reads.

## Decision

The Roles Package API owns a catalog of named Roles. Each has a stable UUID,
human-only name and description, independent revision, and creation/update
timestamps. Each Role owns its Categories, Fragments, skills, additional MCP
servers and trusted projects. Resource names, paths, ordering, and revision
checks are local to that Role. Resource IDs cannot target content in another Role.

The first created Role becomes default in the creation transaction. Later
creation does not change it. `role_set_default` atomically selects any existing
Role. Every later Bot launch and new Worker captures the current default; there
is no per-Bot or per-Worker selection parameter. Idempotently starting a running
Bot preserves its process. Restarting a Bot resolves the default again. Worker
recovery retains its original private snapshot.

A fresh store has no Roles and `defaultRoleId: null`. Launching fails with a
create-first-role error until one exists. The default cannot be deleted, even
when it is the last Role; select another default first. Deleting a non-default
Role removes all its owned content but leaves private session snapshots intact.

## API and concurrency

- `roles_snapshot {}` → `{revision, defaultRoleId, roles: Role[]}`.
- `role_create {expectedRevision, name, description?}` → catalog.
- `role_set_default {expectedRevision, roleId}` → catalog.
- `role_delete {expectedRevision, roleId}` → catalog.
- `role_update {roleId, expectedRevision, name?, description?}` → `{roleId, revision}`.
- `role_snapshot`, `role_editor_snapshot`, `role_preview` and
  `role_launch_preview` require `roleId`. All existing resource writes require
  `roleId` alongside their prior arguments.
- Socket-only `role_launch_snapshot {}` resolves the default and reads its full
  content in the same read transaction. It does not accept a Role selector.

Catalog writes use the catalog revision. Role metadata and resource writes use
that Role's revision. Every successful write advances the catalog revision;
only an edit to a Role advances that Role's revision. Default changes leave Role
revisions alone. A stale write commits nothing. Successful writes publish the
existing `role_changed` invalidation: reread the catalog and selected Role.
Clients must fence asynchronous results by Role ID as well as revision.

Snapshots include Role metadata; instruction and launch previews include
`roleId`. Role metadata/resource writes return compact `{roleId, revision}`
receipts; reread the selected Role for content. This replaces repeated full
snapshot write schemas and keeps API discovery within its existing budget.
Safe snapshots omit credential-bearing MCP definitions; receipts contain no
resource content. Complete editor reads remain operator-only, and complete launch
reads remain socket-only. Catalog reads expose no resource bodies or credentials.
Role names are trimmed and unique using SQLite NOCASE, like existing resource
name uniqueness. Catalog and per-Role snapshots each retain the 750,000-character
budget; rendered instructions retain the 262,144-byte per-Role budget.

Bots and Workers report persisted `roleId` with `roleRevision` for the applied
snapshot, not an assignment. Legacy launches have a null Role ID; no identity is
invented retrospectively. Equal revision numbers across Roles are unrelated.

## Migration and delivery

The first multi-role open migrates the singleton database transactionally to a
Role named `Default`, preserving its revision, resource IDs, order, enabled
states, content, skill files, MCP definitions and trusted roots. Missing legacy
timestamps remain null. The catalog starts at revision 1 for that migration.
The prior `capabilities.sqlite` filename migration is retained. No live store is
opened by tests or setup.

`stack roles list` prints the catalog. `stack roles snapshot [role-id]` reads a
specific Role, or resolves the default if the ID is omitted.

The human explicitly separated API delivery from UI redesign and accepted the
interim Roles UI incompatibility. The manual handoff is
`~/scratch/roles-multirole-ui-handoff.md`.
No service restart is part of this change. The related internal MCP controls
have their own decision, [ADR 0119](0119-per-role-internal-mcp.md).
