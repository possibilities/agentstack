# 108. A Browse space for Browser profiles and human handoff

Status: accepted, 2026-09-28. Adds an eleventh Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md), after the Scrape space of
[ADR 0103](0103-scrape-space-and-local-operator-exposure.md), and gives the `browse` Package API
of [ADR 0092](0092-durable-bot-browser-profiles.md) and [ADR 0093](0093-enforced-browser-handoff.md)
its first UI, which both deferred to an explicit request. Leaves remote UIX policy of
[ADR 0101](0101-remote-uix-through-access.md) unchanged: `browse` stays local.

## Decision

**Browse** (`/x/browse`, key `b`, a new `browse` accent) is where the operator answers a Bot's
request for browser help, watches profiles and maintains the browser toolchain. The ten digit keys
are taken, so its shortcut is a letter the bench does not use. It has five kinds of window:

- **Handoffs** (`browse-handoffs`) lists `browser_handoff_list`, re-read on every
  `browser_handoffs_changed`. Unresolved handoffs come first, oldest first, grouped by state;
  resolved ones are a collapsed history. Each row shows the Bot's message, its Bot and profile,
  whether the requested tab is present, whether automation has drained, and any runtime issue.
  `awaiting_human` offers **Take control**; `awaiting_human` and `human_controlling` offer
  **Finish** as Completed or Skipped with an optional note. `preparing` offers nothing: a stalled
  drain stays held and no force-release exists. Completed is labelled as the operator's report,
  which the Bot verifies with a fresh snapshot. A Bot link goes to the Bot, not a chat window,
  since the originating thread may be a subagent.
- **Viewer** (`browse-viewer`, plus `browse-viewer-N`) embeds a profile's Neko viewer. The primary
  viewer switches between profiles; additional viewers keep their own profile until closed, like
  Fleet chat windows ([ADR 0080](0080-fleet-chat-windows.md)). The arrangement is browser-local.
  Without a grant it shows `profile.observation.url`, labelled as following the visible tab with
  delivery unverified. After Take it shows the `controlUrl` with a control banner and the Finish
  controls. Closing or switching a viewer never resolves a handoff. A profile that is not ready, or
  has no observation connection, shows its state instead of an iframe. The iframe ignores pointer
  input while a window is being dragged, key presses inside it never reach the bench, and it loads only
  while Browse is the visible space, so a hidden bench keeps no video stream open.
- **Profiles** (`browse-profiles`) lists `browser_profile_list` grouped by Bot, then Unassigned, with
  state, observation time, error, default and selected markers, and a held marker while a handoff
  is unresolved. It creates an empty profile for a Bot or unassigned, and deletes one only after
  the name is typed as confirmation. Deletion is disabled with its reason for a default profile,
  a profile a controller has selected, or a held profile. It never imports sign-ins.
- **Controllers** (`browse-controllers`) lists `browser_controller_list` read-only, as last
  observations: a selected profile that differs from the actual one is highlighted and `unknown` is
  never shown as connected. Selecting a live Bot's controller would invalidate its refs mid-task, so
  it stays with the Bot.
- **Toolchain** (`browse-toolchain`) reads `browser_status`, `agent_browser_status`,
  `agent_browser_detect` and `hypeman_detect`, re-read on `browser_system_changed`. It checks for and
  accepts agent-browser updates, installs an exact version, switches the update policy and
  uninstalls the managed binary; it installs, selects, locates and uninstalls local Hypeman.
  Changing the selected Hypeman while profiles exist is disabled with the API's reason.

Handoff actions follow the API's retry contract. Each intended action has one request ID, kept in
`sessionStorage` with its exact arguments. A timeout or dropped connection leaves the intent in
place and offers **Retry**, which resends it unchanged; nothing is resent automatically. A stale
revision re-reads and says the handoff changed. While a handoff this page took is
`human_controlling`, the take intent is kept, so after a reload **Reopen control** repeats it and
the API re-issues the grant. A handoff taken elsewhere can still be finished here. The control URL
is held only in memory: never in the store, inspector, links or storage.

Profiles, handoffs and controllers are new node kinds (`browser-profile`, `browser-handoff`,
`browser-controller`) with homes in their windows; `browser-viewer` names a viewer window. A Fleet
Bot card links to its handoff while one awaits or is under human control. The space asks for
attention for handoffs awaiting a human, drain and return issues, failed profiles, no selected
Hypeman, and a closed `browse` channel.

The WebSocket gateway forwards the browse operations that can outlast its ten-second default with
timeouts matching their own bounds: take 60 seconds, finish 180 seconds (it drains and closes each
bound controller), profile deletion 60 seconds, agent-browser check, install and accept 200 seconds,
and Hypeman install 300 seconds. The UI treats a timeout as an unknown outcome.

## Consequences

Browse's WebSocket selection is unchanged: every operation the space uses was already exposed.
Legacy disposable reservations (`browser_session_*`) remain socket-only, since nothing can create
them any more; `browser_controller_select` stays out of the UI. Remote UIX sessions see the space
but no data: `browse` is never available remotely, and each window says so. The viewer reaches the
loopback gate directly, which also requires a local browser.
