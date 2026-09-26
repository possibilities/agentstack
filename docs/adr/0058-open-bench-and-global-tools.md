# 58. One open bench with global System and API tools

Status: accepted, 2026-09-25. Supersedes the independent canvases and System/API
spaces in [ADR 0042](0042-canvas-spaces.md), the space-change inspection rule in
[ADR 0045](0045-canvas-links-and-inspector-sheet.md), grid mode from
[ADR 0024](0024-live-canvas-workbench.md), and the standalone reference in
[ADR 0009](0009-serve-docs-with-owner.md). Completes retirement of the Markdown
twins from [ADR 0019](0019-markdown-twins.md). Preserves explicit inspection from
[ADR 0051](0051-explicit-inspect-controls.md).
Preserves Fleet's windows and Bot controls from
[ADR 0056](0056-fleet-usage-catalogs-and-bot-controls.md) and the UI-entry redirect
from [ADR 0057](0057-canvas-as-ui-home.md), relocating its System parity surface
to the global dock. Owner resource and agent-tree contracts in
[ADR 0054](0054-owner-resource-observations.md) and
[ADR 0055](0055-agent-tree-observability.md) remain discoverable in the integrated reader.

## Decision

UIX is an open bench: one camera over a shared world containing named Canvas
spaces. Fleet is the initial space. A space's local window arrangement is
independent of its placement on the bench. Space navigation pans the camera;
ordinary panning creates no browser-history entries and does not clear record
inspection. One live store, auth flow, Bot actions provider and voice call remain mounted throughout.
The bench is canvas-only.

Spaces pack deterministically into centered, balanced rows with clearance
between their footprints. Two sit side by side, three form a triangle and four
form a square. Placement depends on stable geometry and ordering, never record
relationships or live status. Structural layout changes preserve the viewed
anchor. Windows retain their local manual positions. This makes future spaces
physical neighbors without making Fleet's internal composition depend on them.
Restore and structural packing include those manual extents; ordinary dragging
keeps region origins fixed. Saved cameras are associated with their logical space
so a direct link to another space still reaches it.

System is a collapsible, resizable, nonmodal left dock. It provides dense live
process, connection, endpoint, surface and activity information with disclosure
and filtering. Its closed control retains attention state. Module growth can
add System sections without adding canvas windows.

API reference is a global, wider reading mode of the right inspector dock.
Search and package/operation navigation expose descriptions, annotations,
transports, event scopes, readable field tables and full raw schemas. Request
and subscription examples respect the declared Transport. Opening reference
preserves the inspected record so the person can return to it. Docks preserve
the bench's screen position and adapt to narrower viewports.
Desktop docks share a width budget that reserves usable bench space. Narrow
screens show one active surface; revealing a card hides overlays while preserving
their destinations and the inspected record.

Destinations distinguish canvas records, System records and reference entries.
An explicit link reveals the corresponding surface; only canvas destinations
pan. URLs express space, focus, inspection, System and reference state. The
reference and System have no home space. New Fleet windows keep the existing
`WindowDef` registration seam in `components/canvas/spaces.tsx` and explicitly
register their node destination in `lib/stack/spaces.ts`.

## Reference retirement

The integrated reader continues to consume the authoritative `docs_snapshot`.
`docs_list` and `docs_get` remain available. There is no copied documentation
source or replacement Markdown rendering.

Remove `@agentstack/docs`, its owner-managed listener, `agentstack docs`,
`agentstack-docs`, `AGENTSTACK_DOCS_PORT`, `owner_status.docsUrl`, and the reference
startup URL output. Old docs-origin HTML, Markdown, revision and asset URLs are
retired without aliases. The UI entry `/` redirects to `/x` (Fleet), with no
separate index page. (Amended 2026-09-26: System's only surface link is MCP
Inspector, while it runs; the reference opens from the bench's own control.)
Old `/x/system` and `/x/api`
space links are replaced by dock destinations under `/x/fleet`.

This intentionally changes callers of the removed command, URL and owner field.
The owner schema, lifecycle, UI consumers and tests change together. Loading the
new owner-served UI still requires a build and a separately authorized owner
restart, as in [ADR 0013](0013-owner-managed-ui-canvas.md).
