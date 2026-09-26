# 70. Windows grow with their content and push windows below

Status: accepted, 2026-09-26. Amends the maximum-footprint rule of
[ADR 0060](0060-resizable-windows-and-compact-fleet.md) and the fitted
empty-state note of [ADR 0067](0067-one-accounts-window-and-bare-empty-states.md).

## Decision

A window without a human-set height is as tall as its content, up to the
2000px height limit, after which its body scrolls. Adding an account, a Bot or
a usage card grows the window instead of hiding the new card below a scroll
edge. A human-set height stays exact and scrolls; double-clicking the bottom
grip returns the window to content height.

A window that grows past its registered footprint pushes the windows below it
out of the way. "Below" means wholly below its footprint in the stored layout
and overlapping it horizontally, so a column cascades and side-by-side windows
stay put. A pushed window clears the grown one by 24px, lands on the dot grid,
and returns to its stored position when the content shrinks. Windows that
already overlapped in the stored layout are left alone.

Pushing is render-time only (`settleWindows` in `lib/stack/geometry.ts`, fed by
each window's measured height). Stored positions, sizes and space packing stay
structural, so live content never repacks the bench or moves other spaces.
Fitting a space or the bench uses the rendered bounds.

## Consequences

Region footprints do not include growth, so a very tall window can extend past
its region toward a space packed below it. The registered height now only
reserves packing space; it no longer caps the window.
