# UIX open bench

The UI entry `/` redirects to `/x`, one continuous bench. Fleet is its initial Canvas space. System
and API reference are global tools attached to the viewport, so opening them
does not navigate away from the current composition. See the rationale in
[ADR 0058](adr/0058-open-bench-and-global-tools.md).

Fleet retains the Usage and Models windows, Bot lifecycle controls and
full Bot tools dialog from [ADR 0056](adr/0056-fleet-usage-catalogs-and-bot-controls.md).
One mounted Bot actions provider retains forms and upload state alongside the
store, auth and voice providers. The former index's process and local URL details
live in the System dock; MCP Inspector is linked only while its child is running
([ADR 0057](adr/0057-canvas-as-ui-home.md)).

## Adding a Fleet window

Keep window implementation separate from bench layout:

1. Implement the window using the existing `Window`, `NodeCard` and `NodeTitle`
   primitives. Existing Fleet implementations are in
   `packages/uix/components/canvas/windows.tsx`; a new substantial window can
   live in its own module.
2. Add its `WindowDef` to Fleet's `windows` list in
   `packages/uix/components/canvas/spaces.tsx`. The ID must be stable. `width`
   and `column` describe the initial local arrangement, not bench coordinates.
   Window IDs are globally unique across spaces. Optional `height` reserves a
   stable footprint (760 by default); overflowing window content scrolls inside
   it, so live data growth does not rearrange neighboring spaces. People can
   resize any window, and moves and resizes snap to the dot grid unless
   Alt/Option is held; sizes persist as manual extents
   ([ADR 0060](adr/0060-resizable-windows-and-compact-fleet.md)).
3. If it introduces a node kind, add that record reference in
   `packages/uix/lib/stack/types.ts` and give it a canvas destination in
   `packages/uix/lib/stack/spaces.ts`. Keep node key parsing and routing tests
   in step. A global System or reference destination is not a Canvas space.
   `homeOf` returns a discriminated destination with `kind: "space"`,
   `kind: "system"` or `kind: "reference"`; only the first has a space/window.
4. Read live data through the shared store; subscribe and snapshot according to
   the Package API's invalidation contract. Window mounting must not own a
   separate long-lived connection or call.
5. Use `goTo` for deliberate navigation and `select` for explicit inspection.
   A card's visible name is its inspection control. Actions and form inputs do
   not pan or inspect as a side effect.

The bench owns pan/zoom, world placement, dock geometry and navigation history.
Windows own their content. A record update must not rewrite the user's window
positions or cause neighboring spaces to repack. This boundary permits window
development in independent worktrees while the shell evolves.

Restore, registration changes and explicit tidy reconcile local positions before
packing space footprints. Manual movement keeps the current space origins fixed.
Repacking preserves the viewed window's screen position. A saved camera applies
only to its logical space; an explicit link to another space fits that region.

## Reference and System destinations

`/x/fleet?reference=overview` opens the integrated reference. Package and
operation targets use encoded node keys in `reference`; `system=open` opens
System, and an owner/child node key reveals a specific System record. `focus`
reveals a canvas card; `inspect` selects a record. The navigation helpers own
destination serialization and parsing; callers should not assemble links
independently. The shell also writes `surface=bench|left|right` to retain the
active narrow-screen surface through history and reload. Revealing a card on
mobile hides the docks while retaining their content and inspected record.

Reference content comes from discovery, including raw JSON Schemas for details
that the field summary cannot express. Examples are descriptions of the
declared Transport, not operation execution controls. Showing an API in the
reference does not imply it has a dedicated Fleet control.

## Verification and delivery

Run `pnpm --filter @agentstack/uix typecheck` and the focused UI tests for an
affected contract. `pnpm test` includes a production build and lifecycle tests.
Build only in an isolated checkout while the main checkout serves a live owner.
Use disposable state for lifecycle or rendered checks.

Check actual browser behavior for layout changes: camera position before and
after dock open/resize/close, record inspection/reference return, deep links,
Back/Forward, keyboard access, narrow widths, light/dark appearance and live
invalidation. Navigation must leave the store, auth flow, Bot actions and voice providers
mounted. Loading changes into an active owner requires separate restart
authorization.

For the standalone headless interaction check, build first, then run from the
workspace root with an already installed Playwright module and Chrome:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/bench.browser.mjs
```

The check uses disposable sockets, a fixture snapshot and its own `next start`
process. `CHROME_EXECUTABLE` overrides the default macOS Chrome path;
`NEXT_MODE=dev` selects development verification instead. Screenshots are written
under `packages/uix/.next/bench-evidence`.
