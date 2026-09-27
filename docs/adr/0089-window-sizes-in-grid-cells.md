# 89. Window sizes in whole grid cells

Status: accepted, 2026-09-27. Amends the grid snapping of [ADR 0060](0060-resizable-windows-and-compact-fleet.md) and [ADR 0072](0072-fluid-drag-and-content-fit-groove.md).

## Decision

A snapped window size is a whole number of 22px grid cells. Resizing no longer lands only the far edge on a dot, which left arbitrary widths whenever the window itself sat off the grid; the width and height snap to cell multiples within the size limits rounded inward to cells. Registered default widths and heights are snapped to cells when the bench is reconciled, default column and row gaps are whole cells (66px and 22px), and each space's packed origin lands on a dot, so default windows start on the grid and their edges stay on dots as they are resized.

Alt/Option still sizes freely, and the height content-fit groove still stores no height. Saved sizes are kept as stored, since a free size is deliberate.

## Consequences

Default window extents can differ from their registered values by up to half a cell, and tidy layouts shift slightly to land on the grid.
