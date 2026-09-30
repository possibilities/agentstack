# 133. A HUD space for shared Work

Status: accepted, 2026-09-29. Adds a fourteenth Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md) and gives the `hud` Package API of
[ADR 0132](0132-native-hud-work-collaboration.md) its UI. It completes 0132's
deferred remote integration under [ADR 0101](0101-remote-uix-through-access.md).
Fleet stays the landing space at `/` ([ADR 0116](0116-ui-at-root.md)).

## Decision

**HUD** (`/hud`, key `h`, a new `hud` accent) is where humans and agents see what they
are trying to accomplish together, where each piece stands, what needs someone next
and what is deployed on it. It is designed around the native API; it reuses nothing
from the archived AgentHUD UI. It has five windows:

- **Needs attention** (`hud-attention`) groups open work by who or what it waits on:
  marked for a human, in review, blocked (by state or unmet dependencies), marked for
  an agent, waiting. Below, the latest results, decisions and handoffs from the
  journal's newest entries, each marked when it belongs to an earlier scope.
- **Work** (`hud-work`) is the hierarchy in its real order from `work_tree`: state as
  a shape and a word, priority, the attention marker, the next action, open-descendant
  counts and unmet dependencies. Views are Open, Needs a look and All, with text search,
  collapsible branches and a focused subtree. Filters never re-parent a row: a match
  keeps its real ancestors, dimmed as context, and the window says how many rows the
  filter, collapse or closed-work rule hid. A tree larger than the loaded rows says so
  and offers to read more.
- **Work item** (`hud-item`) is the selected item: objective, next action and summary,
  state, priority and attention, readiness and dependencies, placement (sibling order
  and moves), typed links, labels and the revision record. An explicit **Agent
  metadata** disclosure reads `work_metadata_get` only when opened.
- **Timeline** (`hud-timeline`) is the item's journal in order, following the durable
  `work_activity_list` cursor: edits with before and after, scope changes, Chat focus
  and immutable notes. A result, decision or handoff recorded for an earlier scope says
  so. Its footer appends notes of each kind.
- **Resources** (`hud-resources`) keeps separate facts separate: declared lead,
  contributor and runtime links; Chat focus entries (a saved selection, not liveness)
  with a control to focus a Bot's main chat on the item or clear a Chat's focus; and
  captured Worker turns from `work_resources`, grouped by Worker. Each turn keeps its
  own captured scope and phase; `current` reads as "latest", never as running. When a
  Worker's latest turn is on other work, the window says so and keeps this item's
  turns as history. Unavailable Worker observations read as unavailable, keeping the
  last good page visibly marked, never as an empty list. Account usage and process
  resources link to their owners and are never split per item.

`work-item` is the new node kind; its home is the Work window, and arriving there
selects and reveals it. The selection, collapsed branches and subtree focus are
page-local view state, never Chat focus. The palette searches open Work. The
inspector shows the public item record only.

## Data and collaboration

The store subscribes to `hud_changed` before reading and resnapshots the whole tree on
every notice and reconnect, reading it as one `snapshot`-fenced generation that
restarts rather than combining pages. The selected item holds a reference-counted
scoped `work_changed` subscription; its windows re-read on that item's generation.
Resource views also re-read on `worker/workers_changed` and Bot invalidations, which
HUD itself never relays.

Every write carries a fresh `requestId`; a create fixes its item ID per draft. A lost
connection holds the exact request and input, and only **Retry the same request**
resends it; the form accepts no new submission until the person retries or forgets
it. Edits are checked against the revision they started from. A concurrent change
shows beside an open draft; a revision conflict keeps the draft and offers to save it
over the new revision or discard it. Completing work with open descendants, and
reopening work under completed ancestors, are offered as one confirmed `work_batch`
the API validates against the final graph. Reordering uses one edit, or renumbers the
siblings in a batch when their orders tie. No state edit starts, stops, approves or
acknowledges anything.

## Remote boundary

Access now serves `/hud` and selects `work_create`, `work_update`, `work_batch`,
`work_note_add`, `work_metadata_set` and `work_focus_set` for `ui:control`, through
the same live-exposure intersection and per-mutation grant check as other controls.
`ui:view` sessions keep the reads only. `work_context_resolve` stays socket and MCP
only. Server renders take no HUD snapshot; the page reads over its WebSocket.

## Consequences

Humans and Bots share one live view of the Work graph and edit it together without
silently overwriting each other. Other spaces are linked, not duplicated: Fleet chats
(only while the Bot keeps the same root), Workers conversations, Accounts, System
resources, and Content, Brain, Proc, Browse, Notify, Roles and Scrape records named by
supported resource locators; unsupported locators stay copyable text. In the other
direction, the Workers space links each turn's captured `workContext` to its Work item:
the Worker summary shows the latest turn's item, the Turns tab each turn's item, source
and whether the item's scope has moved on, and the Worker inspector relates the item.
