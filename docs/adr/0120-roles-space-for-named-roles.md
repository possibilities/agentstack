# 120. The Roles space manages named Roles and per-Role internal MCP switches

Status: accepted, 2026-09-28. Extends [ADR 0082](0082-roles-space-for-instruction-fragments.md) and
[ADR 0098](0098-roles-space-for-launch-resources.md), and is the UI for
[ADR 0118](0118-multiple-roles-and-default.md) and [ADR 0119](0119-per-role-internal-mcp.md).
Keeps the Editor as the one editing surface and the draft, immediate-switch and rebuild-once behavior
of ADR 0082.

## Decision

**Roles** gains a leftmost **Roles** window (`role-catalog`) that lists every Role in creation order. A row shows
the name, a **Default** badge, an **Editing** state for the selected Role, its revision and a mark for unsaved
drafts. Clicking a row selects it for editing in every other Roles window; selection never changes the default.
The row menu edits details, makes the Role default, inspects it, or deletes it. The other windows show the
selected Role's name in their subtitle. When it is not the default, the Editor and Preview say that its edits
reach no launch until it is made default, name the Role launches use, and offer **Make default**.

- **Selection** is page state holding a Role ID, remembered per viewer in `localStorage` when it is available. With
  no valid selection the page edits the default. Every Role-scoped resource (editor snapshot, instruction preview,
  launch preview, internal MCP list) is read with that ID and cleared to a loading state when it changes.
- **Details** (name, description) and **New role** are Editor targets, saved with `role_update` and the Role
  revision or `role_create` and the catalog revision. Names are trimmed and at most 200 characters; the uniqueness
  hint folds ASCII case only, matching SQLite `NOCASE`, and the API's refusal stays authoritative. Creating a Role
  selects it; it does not become default unless it is the first.
- **Make default** confirms that later Bot launches and new Workers use the Role, that running Bots and Workers
  keep what they launched with, and that nothing restarts. **Delete** of the default is disabled with the reason
  "Make another Role default first"; deleting any other Role confirms what it removes, that existing sessions
  keep their snapshots and that it cannot be undone, and discards its drafts.
- **An empty catalog** shows an Empty state in every Role-scoped window, and in Roles an explanation that Bots
  cannot launch until a Role exists, with a Create role action.
- **A selected Role deleted elsewhere** is not silently replaced while it holds unsaved drafts. The selection
  stays on the missing ID and the Editor lists the drafts, readable and copyable, until they are discarded, which
  selects the default. Without drafts the page falls back to the default and says so once. Drafts of a Role that
  disappears while another is selected are flagged in Roles for review.
- **Internal Stack MCP servers** are a section above the Role-owned servers in **MCP servers**, one switch per
  server from `role_internal_mcp_list`, with a count of servers on. Switches apply at once with the selected Role's
  revision and say that they reach later Bot launches and new Workers, that running sessions keep their
  connections and that new packages start on. All may be off, `roles` included. After a write the internal list,
  editor snapshot and launch preview are read again; a receipt is never merged into held data.
- **The launch preview** dims and strikes internal servers that are off for the Role and counts servers on
  against those configured, and never shows a generated internal URL. **External MCP name checks** reserve every
  internal name, switched on or off.
- **Launched comparison** classifies each running Bot and open Worker by `(roleId, roleRevision)` against the
  default: current, older revision of the default, another Role (possibly deleted), or unknown for a legacy launch
  without a Role ID. Equal revision numbers across Roles are unrelated, and the copy never says a running process
  changed: "Launched with Researcher r5 · restart to use Default".

`role` is a new node kind whose destination is the Roles window, with an inspector view and the usual "Edit in
Roles" hand-off. The palette finds Roles and offers New role.

## Fences and concurrency

Every Role-scoped response is accepted only for the selected Role ID, and for the same Role only when it is not an
older revision; an answer for another Role is dropped even at a higher revision, and errors of a read started for
another Role are dropped too. The catalog has its own revision. Resource writes carry the Role ID and revision they
were built for, catalog writes the catalog revision; each rebuilds once after its own stale refusal, the internal
switch skipping the write if the reread already shows the requested state. Drafts, pending writes and editor
targets are keyed by Role ID, so selecting another Role or changing the default never retargets them, and
switching back restores them. A write started for one Role finishes against it and never refreshes another Role's
view. `role_changed`, subscription and reconnect reread the catalog and the selected Role; a discovery refresh
also rereads the internal list, since manifest changes do not advance Role revisions. Server rendering loads the
catalog only.

## Consequences

Windows other than Roles show only the selected Role, so a node link to a record of another Role resolves once that
Role is selected. Loading the new UI into a running server needs a build and an owner restart
([ADR 0013](0013-owner-managed-ui-canvas.md)). No attention signal marks an empty catalog on the Roles space, and a
per-Bot Role picker remains out of scope with ADR 0118.
