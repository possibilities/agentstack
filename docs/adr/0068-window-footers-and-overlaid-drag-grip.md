# 68. Create in window footers; overlay the drag grip

Status: accepted, 2026-09-26. Amends the header creation convention of
[ADR 0067](0067-one-accounts-window-and-bare-empty-states.md).

## Decision

A window's creation control lives in a footer pinned below its body, as a
full-width ghost button: "Add account" (a menu opening upward) in Accounts,
"Create Bot" in Bots. The footer stays visible while a long list scrolls and
in an empty window, and hides when the window is collapsed. Headers keep
identity, count, status, settings (such as Bot defaults), non-creating
actions (such as re-reading usage) and collapse.

The hover-only drag grip no longer holds a slot among the header controls.
It overlays the header's top edge, centred, so controls such as Usage's
re-read button sit directly beside the status dot.

## Consequences

Header width no longer depends on whether a window can create records, and
an invisible grip never spaces controls apart.
