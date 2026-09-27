# 72. Fluid window gestures and a content-fit groove

Status: accepted, 2026-09-26; amended 2026-09-26 (see Amendment); amended by [ADR 0089](0089-window-sizes-in-grid-cells.md). Amends the grid snapping of
[ADR 0060](0060-resizable-windows-and-compact-fleet.md); builds on content
height from [ADR 0070](0070-windows-grow-with-content.md).

## Decision

Moving or resizing a window no longer steps from dot to dot under the
pointer. The window follows the pointer exactly while a faint dashed outline
marks the grid position or extent it will land on; on release it glides
there (200ms, none under reduced motion). The stored layout is always the
grid-aligned result, so persistence, pushes and packing are unchanged.
Windows pushed aside during a gesture move smoothly instead of jumping.
Alt/Option still places and sizes freely, with no outline.

Resizing a window's height has a groove at its content height, measured
live because content rewraps as the width changes. A dashed line marks that
height during the resize; within 14 screen pixels the edge sticks to it
exactly, the line turns solid and a "Fits content" marker appears. Released
there, the window stores no height and goes on fitting its content, which
is otherwise unreachable on the grid. Double-clicking the bottom grip still
does the same.

## Consequences

The groove is height-only; width has no content-defined natural size and
keeps grid snapping, with double-click returning to the registered width.

## Amendment (2026-09-26)

The groove is no longer drawn. The dashed line, its solid active state and
the "Fits content" marker are removed: the stick alone is enough feedback,
and the extra chrome competed with the window during a resize. The 14px
detent, the grooved release that stores no height, and the suppressed landing
outline inside the groove are unchanged.
