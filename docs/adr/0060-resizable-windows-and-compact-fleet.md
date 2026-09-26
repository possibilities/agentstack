# 60. Resizable windows and a compact Fleet

Status: accepted, 2026-09-25. Amends [ADR 0058](0058-open-bench-and-global-tools.md)
and the Fleet presentation in [ADR 0056](0056-fleet-usage-catalogs-and-bot-controls.md).

## Decision

Every bench window can be resized from its right edge, bottom edge or corner.
A size is a manual extent stored in `BenchLayout.sizes` next to manual
positions. Like dragging, resizing changes only the local layout; restore and
tidy pack with the resized footprint, and tidy keeps sizes. Sizes are clamped
(280–960 wide, 160–2000 tall). A set height is exact; otherwise the registered
height stays a maximum footprint. Double-clicking a grip returns that dimension
to its registered default. Windows no longer share one width or footprint.
Moving and resizing snap to the 22px canvas dot grid in world coordinates: a
moved window's corner and a resized window's far edge land on dots. Holding
Alt/Option places or sizes a window freely (amended 2026-09-25).

Fleet windows favor glanceable shapes over prose:

- Usage shows one card per observation with remaining-quota meters, a headline
  percentage and reset countdowns. A Bot account and its linked Worker account
  collapse into one card only when their observations are identical; accounts
  without a measurement are listed as chips.
- Models shows one Worker account at a time as tabs with model counts, a pinned
  filter, and an effort ladder per model instead of effort text.
- A Bot card shows state, account and chips for model, workspace, thread and
  endpoint, with Start/Stop, Call and Tools inline and the rest in a menu.
  Creating a Bot still requires an explicit account choice, now made from
  account cards.

UI copy stays short: labels name things, and explanations belong in tooltips,
the inspector or the API reference.
