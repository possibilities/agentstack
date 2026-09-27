# 88. Independent open benches for Canvas spaces

Status: accepted, 2026-09-26. Supersedes the shared-world placement and camera
of [ADR 0058](0058-open-bench-and-global-tools.md). Preserves its global tools,
URL navigation and shared providers, and the inspector behavior in
[ADR 0085](0085-pinnable-inspector.md).

## Decision

Each Canvas space has its own open bench containing only its registered windows.
Spaces are no longer physical neighbors: panning, zooming, Fit and Reset positions
operate within the selected space. Space navigation restores that space's camera
instead of traveling across a shared world. Cross-space card links, deep links
and browser history still select the destination space before revealing a card.

The store, auth and Bot actions, voice call, inspector and API reference remain
global. Each bench retains component state (including drafts), window layout,
stacking, sizes, collapse state and camera across navigation. React Activity
pauses hidden benches' effects; hidden/inert ancestors exclude them from display,
focus and accessibility. Geometry changes in another space cannot move this one.

Browser-local persistence uses one version-2 key per space. On first use, each
bench imports its windows from the previous shared layout; the old camera is
restored only for its named space and adjusted through its saved window anchor.
Other spaces start fitted. The original save is retained as migration input.

A 150ms opacity-only reveal communicates the switch without postponing navigation
or retaining outgoing visible content. Reduced-motion users receive an immediate
switch. No transition timer can apply a stale destination during fast navigation.

Window registrations and node destinations keep their existing seams. New spaces,
windows or controls still require an explicit human request.
