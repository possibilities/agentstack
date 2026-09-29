# UIX open bench

The owner still serves Next only on loopback. An explicitly configured Access
TLS tailnet listener can present `/x/...` to a paired browser on a distinct
origin ([ADR 0101](adr/0101-remote-uix-through-access.md)). `uix:view` is
read-only; `uix:control` enables UI mutations. Sign-in, voice, Access approvals
and headful browser handoff stay local. Remote Content Preview opens a one-use
handoff for a document, item or immutable Artifact version when that browser
also has `content:read`; local Content links are unchanged. Use the remote
browser check against disposable state after building in an isolated checkout:
`PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node packages/uix/test/remote-uix-browser-check.mjs`.

The UI entry `/` redirects to `/x`, one continuous bench. Fleet is its initial Canvas space. API
reference is a global tool attached to the viewport, so opening it does not
navigate away from the current composition. System is a fourth space; see
[ADR 0058](adr/0058-open-bench-and-global-tools.md) and
[ADR 0079](adr/0079-system-space.md).

Fleet retains Bot lifecycle controls and the full Bot tools dialog from
[ADR 0056](adr/0056-fleet-usage-catalogs-and-bot-controls.md), alongside main-thread
Chat windows ([ADR 0080](adr/0080-fleet-chat-windows.md)). Usage and Models live
in Accounts ([ADR 0069](adr/0069-accounts-space.md)).
One mounted Bot actions provider retains forms and upload state alongside the
store, auth and voice providers. The former index's process and local URL details
live in the System space; MCP Inspector is linked only while its child is running
([ADR 0057](adr/0057-canvas-as-ui-home.md)).

Roles (`/x/roles`, shortcut 5) is the fifth space and manages the Role's instruction Categories and Fragments
([ADR 0082](adr/0082-roles-space-for-instruction-fragments.md)). One mounted Role
actions provider owns the editor's target, page-local text drafts and
revision-checked writes, so the Instructions, Editor and Preview windows, the
inspector and the palette all edit through it.

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
   resize any window, and moves and resizes snap to the dot grid (sizes to
   whole cells) unless Alt/Option is held; sizes persist as manual extents
   ([ADR 0060](adr/0060-resizable-windows-and-compact-fleet.md)).
3. If it introduces a node kind, add that record reference in
   `packages/uix/lib/stack/types.ts` and give it a canvas destination in
   `packages/uix/lib/stack/spaces.ts`. Keep node key parsing and routing tests
   in step. A reference destination is not a Canvas space. `homeOf` returns a
   discriminated destination with `kind: "space"` or `kind: "reference"`;
   only the first has a space/window.
4. Read live data through the shared store; subscribe and snapshot according to
   the Package API's invalidation contract. Chat windows use a shared per-Bot
   feed for high-frequency transcript notices (ADR 0080), not a connection per
   window. Window mounting must not own a separate long-lived connection or call.
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

## Reference destinations

`/x/fleet?reference=overview` opens the integrated reference. Package and
operation targets use encoded node keys in `reference`; an owner, child,
resource or process node key in `focus` reveals its System space window. `focus`
reveals a canvas card; `inspect` selects a record. The navigation helpers own
destination serialization and parsing; callers should not assemble links
independently. The shell also writes `surface=bench|right` to retain the
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

The Roles space has its own check, which serves the real Roles API against a
disposable state directory:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/roles-browser-check.mjs
```

The Scrape space's check serves the real Scrape API against a disposable state directory and a
loopback HTTP fixture, so it fetches no public site and never touches a live queue. It uses
`next dev` unless `SCRAPE_NEXT=start`, and keeps screenshots when `SCRAPE_EVIDENCE_DIR` is set:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/scrape-browser-check.mjs
```

The Browse space's check serves fixture browse, Bots and owner sockets with the real browse schemas and a
loopback stand-in for the Neko viewer, so no profile, Hypeman or live owner is touched. It covers the Fleet
link, take, reload and Reopen, finish, profile creation and deletion, and the toolchain. It uses `next dev`
unless `BROWSE_NEXT=start`, and keeps screenshots when `BROWSE_EVIDENCE_DIR` is set:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/browse-browser-check.mjs
```

The Brain space's check serves the real Brain API against a disposable state directory with an
ephemeral share port, so it never opens a live research store. It submits text and a private URL,
reads, searches, excludes, reveals, pauses a source and deletes. It uses `next dev` unless
`BRAIN_NEXT=start`, and keeps screenshots when `BRAIN_EVIDENCE_DIR` is set:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/brain-browser-check.mjs
```

The Proc space's check serves the real Proc API against a disposable state directory, seeded through
`ProcStore` with a Bot-owned schedule, a legacy unattributed one and a blocked one, and creates its
live fixtures through the socket: a secret-bearing schedule, a noisy failed run, a long run for Stop
and a run that keeps no output. It covers grouping and outcome strips, masked/revealed environment,
Disable/Enable/Remove/Reauthorize, the log reader's tail, backscroll and stderr marks, the not-retained
banner, timeline marks and click-through, Spaces-menu attention and the Fleet "schedules" link. It uses
`next dev` unless `PROC_NEXT=start`, and keeps screenshots when `PROC_EVIDENCE_DIR` is set:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node packages/uix/test/proc-browser-check.mjs
```

The bench check uses disposable sockets, a fixture snapshot and its own `next start`
process. `CHROME_EXECUTABLE` overrides the default macOS Chrome path;
`NEXT_MODE=dev` selects development verification instead. Screenshots are written
under `packages/uix/.next/bench-evidence`.
