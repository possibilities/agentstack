# 98. The Roles space manages skills, MCP servers and trusted projects

Status: accepted, 2026-09-28. Extends [ADR 0082](0082-roles-space-for-instruction-fragments.md), replacing its
statement that Role skills, additional MCP servers and trusted projects
([ADR 0031](0031-role-resources.md), [ADR 0034](0034-explicit-project-trust-for-role-bots.md)) remain API-only.

## Decision

**Roles** gains three list windows beside Instructions, Editor and Preview:
**Skills** (`role-skills`), **MCP servers** (`role-mcp-servers`) and **Trusted
projects** (`role-projects`). Their rows switch records on and off, reorder by
drag and drop, Alt+↑/↓ or a row menu, and open the record in the Editor. The
new node kinds `skill`, `mcp-server` and `trusted-project` have those windows as
destinations, inspector views with an "Edit in Roles" hand-off, and palette
entries. ADR 0082's editing model carries over unchanged: the Editor is the one
editing surface, text is drafted per record, switches and moves apply at once,
writes rebuild once after a stale revision, and deleting asks first.

- A **skill**'s supporting files are one draft field, because `skill_update`
  replaces the whole set. Text files edit inline; any file can be uploaded,
  renamed, downloaded or removed. The Editor explains that a skill's
  description, unlike a fragment's, reaches Bots through `SKILL.md`.
- An **MCP server** is edited as a transport form (HTTP or stdio). Map fields are
  ordered rows; stdio arguments are separate values, and a pasted command line
  is split without shell expansion. Literal header and environment values carry
  a plain-text warning, and the Editor shows the `config.toml` table a launch
  would write.
- A **trusted project** shows the Bots whose working directory lies inside it
  and a standing warning that trust admits the project's whole `.codex`
  configuration.

The **Preview** window gains a Launch view, backed by a new read-only
`role_launch_preview` operation. It reports the enabled skills, internal and Role
MCP servers, the Role's exact `config.toml` tables, enabled trusted roots matched
against given working directories (the UI passes every Bot's `cwd`), the Role's
size against its snapshot budget, and any MCP server that would stop every Bot
launch. The Preview follows the Editor: resource records show the Launch view.

A Role MCP server that aliases the owner's MCP listener is now refused on write,
as a name that collides with an internal Package API already was. A launch now
skips disabled MCP servers before checking them, so a disabled record can no
longer stop every launch.

## Consequences

Skills, MCP servers and trusted projects have no `createdAt`/`updatedAt`.
Every Roles write repeats the whole snapshot schema in its output, and adding six
stamp fields there pushed the discovery snapshot past its 750,000-character
test budget; the launch preview fits. Revisit stamps if write outputs stop
repeating the snapshot schema or the budget changes.

The launch preview's trust matches are only as current as the Bot list it was
given. A server that already clashed with an internal name, or one that clashes
with a Package API added later, still stops launches while enabled; the Launch
view and its row flag it. Loading the new UI into a running owner needs a build
and an owner restart ([ADR 0013](0013-owner-managed-ui-canvas.md)).
