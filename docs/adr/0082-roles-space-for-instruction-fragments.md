# 82. A Roles space for managing instruction fragments

Status: accepted, 2026-09-26; extended by [ADR 0098](0098-roles-space-for-launch-resources.md), which gives skills, MCP servers and trusted projects their UI. Adds a fifth Canvas space to the open bench of
[ADR 0058](0058-open-bench-and-global-tools.md). Gives the single Role of
[ADR 0030](0030-single-role-package.md) its first editing UI, and extends its
fragment operations from [ADR 0027](0027-default-capabilities-bundle.md). Role
skills, additional MCP servers and trusted projects
([ADR 0031](0031-role-resources.md), [ADR 0034](0034-explicit-project-trust-for-role-bots.md))
remain API-only for now.

## Decision

**Roles** (`/x/roles`, key 5) is where people manage the Role. Its first scope is
the instruction system: Categories and Fragments, their order, enabled states,
human-only titles and descriptions, and the text Bots receive. It joins Fleet,
Accounts, Lab and System ([ADR 0079](0079-system-space.md)) in the shared packing.
The space has three windows:

- **Instructions** (`role-instructions`) outlines categories and their fragments
  in render order. Each row shows why it does or does not render (off, empty, or
  its category off) and an approximate token count. Search matches every word
  across titles, descriptions and text; a matching category keeps all of its
  fragments. Fragments move by drag and drop, including across categories, by
  Alt+↑/↓, or from a row menu; categories reorder the same way.
- **Editor** (`role-editor`) edits one record at a time: an existing fragment or
  category, or a new one. It is the single editing surface, so the inspector and
  palette hand records to it rather than editing in place.
- **Preview** (`role-preview`) shows `role_preview`'s exact text, cut into each
  fragment's span and labelled with its title, with its size against the limit.
  It lists running Bots and open Workers with the Role revision they launched
  with, since edits reach only later launches.

`category` and `fragment` are new node kinds whose destination is the
Instructions window. Their inspector views show the generic record with field
notes from discovery and an "Edit in Roles" hand-off; the palette finds both and
offers New category and New fragment.

**Text is drafted; switches and moves apply at once.** Titles, descriptions and
fragment text are page-local drafts, kept per record so switching records loses
nothing; rows mark unsaved drafts, and leaving the page with any asks first.
Enabled switches, category changes and moves are immediate, like the switches
elsewhere on the bench. A draft remembers each edited field's saved value when
editing began. When another editor saves over a field being edited, the editor
shows the conflict and the person chooses Keep mine or Use theirs; saved changes
to fields not being edited are simply followed.

**Writes rebuild once after a stale revision.** Every Roles write carries the
global `expectedRevision`. A stale-revision refusal wrote nothing, so the UI
reads the Role again and rebuilds the write from that snapshot once, stopping if
the rebuild finds a conflict or a deleted record. Deleting asks first, and a
category that still has fragments explains that it must be emptied, matching the
API's refusal to delete content implicitly.

The Roles Package API gains what the UI needed:

- `fragment_move` atomically places a fragment at a zero-based index of any
  category. Updating `categoryId` then reordering took two revisions and could
  leave a half-finished move.
- `fragment_create` accepts an optional `index`, for inserting and duplicating
  in place.
- Categories and fragments report `createdAt` and `updatedAt` (Unix
  milliseconds). Existing databases gain nullable columns, and their earlier
  records report null rather than an invented time. Reordering does not change
  `updatedAt`; moving to another category does.
- `role_preview` adds `segments` (each rendered fragment's `[start, end)` string
  offsets), `bytes` and `limitBytes`, so the preview maps text to fragments from
  the authoritative render instead of re-deriving it.

The space uses a new `roles` accent (violet).

## Consequences

The launched-revision comparison uses the Role's single revision, which also
advances for skill, MCP server and trusted project edits, so "Older role" means
the Role changed, not necessarily the instructions. Drafts vanish on reload.
Clients that construct Role snapshots by hand must include the new timestamp
fields; `role_preview` and `role_snapshot` output grows but no field changes
meaning. Loading the new UI into a running owner still needs a build and an
owner restart ([ADR 0013](0013-owner-managed-ui-canvas.md)).
