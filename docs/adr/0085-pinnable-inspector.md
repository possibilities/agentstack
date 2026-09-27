# 85. Pinnable inspector dock

Status: accepted, 2026-09-26. Refines [ADR 0045](0045-canvas-links-and-inspector-sheet.md) and [ADR 0058](0058-open-bench-and-global-tools.md).

## Decision

The right inspector dock can be pinned. Unpinned is the default: the dock
contracts on a mouse click, wheel input or keyboard input that lands on the
bench or the bench chrome, while retaining the inspected record. Contraction
is neither URL nor history state; the inspection returns through the card's
name, the top bar's "Return to inspector" or the palette action, and
inspecting another record re-expands the dock with the new contents.

API reference mode is exempt — it never contracts — as are portaled popups
(menus, tooltips, dialogs and the palette) and narrow overlay screens, which
already show one surface at a time. The pin preference persists in local
storage; contraction itself is session-only.
