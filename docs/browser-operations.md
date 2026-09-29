# Browser operations

The browse Package API owns durable profiles and local Hypeman/Kernel runtimes.
Use agent-browser CLI/MCP for page and tab operations. Each Bot receives an
exclusive default profile automatically; additional profiles start empty.
Profiles stay running while Stack runs, including those retained unassigned
after Bot deletion. Controller close only disconnects.

## Installation and launch scope

Select a local Hypeman installation with `hypeman_detect`, optionally
`hypeman_location_set`, then `hypeman_enable`. Detection and installation never
select a host implicitly. A selected host cannot change while durable profiles
remain. `agent_browser_install` installs an exact release in the private toolchain;
updates default to manual acceptance. The validated switching protocol is 0.38.1.

Each Bot launch receives `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_NAMESPACE` and
an idle timeout of zero. Its private config lives in
`<STACK_STATE_DIR>/browser/controllers/` and carries a signed, live-launch
proof. It is not a human/global provider setting. Use the Bot's inherited config
and namespace; choose `--session NAME` for independent controllers. Overriding
the managed namespace/config or attaching a separate CDP client is outside the
managed controller contract. A session named after a Bot confers no Bot identity.
Workers do not inherit this launch context.

The Bot's Role still needs an agent-browser CLI/MCP executable. The native
controller owns tabs, page refs, snapshots and input. The management API never
proxies those commands. An explicitly selected additional profile affects only
the specified controller in the current Bot launch. A later Bot launch starts
new controllers on its default profile.

## Management

Bots discover a signed `browser` MCP connection through the server's launch
catalog. It exposes exactly the five operations below. MCP callers must be a
verified live Bot launch: requested `botId` never supplies identity. Reads are
scoped to the caller's profiles and current-launch controllers. Creation must
name the caller's own Bot; deletion and selection reject foreign and unassigned
profiles. Worker and anonymous MCP connections cannot use these operations.
The local operator socket/WebSocket retain broad management access.

- `browser_profile_list`: durable assignment, last observed health, CDP relay,
  and Kernel/Neko observation connection.
- `browser_profile_create {botId, label}`: admit an empty additional profile;
  `botId: null` retains an unassigned profile. Admission precedes readiness.
- `browser_controller_select {botId, session, profileId}`: persist selection,
  queue reconnect behind that controller's commands, invalidate refs, and return
  the observed actual profile, CDP browser URL and active target ID. Take a fresh
  snapshot after selection. Check `state` and `error`; `unknown` is not success.
- `browser_controller_list`: selections and timestamped last confirmed bindings,
  not a continuous controller liveness probe.
- `browser_profile_delete {profileId, confirm: "delete"}`: permanently discard
  an unselected non-default profile, VM and volume after exact ownership checks.

`browser_controller_launch` and `browser_controller_close` are socket-only
provider internals. `browser_bot_release` is the server-local deletion/ID-reuse
fence, so a removed Bot's ID cannot inherit its old profiles between supervision
cycles. `browser_session_*` inspection/cleanup handles disposable receipts and
cannot delete durable profiles. `browser_research_acquire` is a socket-only
Scrape lifecycle seam for fresh research guests; it is not exposed to agents.
The local UI Browse space ([ADR 0108](adr/0108-browse-space.md)) answers handoffs, views and manages profiles and runs the toolchain; controller selection stays with Bots;
the dynamic API reference continues to describe them.

## Constrained research browsers

Brain research uses fresh disposable guests with guest-wide IPv4/IPv6 OUTPUT filtering installed before Chrome starts. Public TCP destinations and exact operator-granted private TCP endpoints are allowed; direct UDP/QUIC/WebRTC, loopback and reserved ranges are denied except explicitly granted endpoints and a fixed DNS resolver. Both `iptables` and `ip6tables` must work in the selected pinned guest image. If enforcement or readiness fails, research reports `network_policy:browser_egress_unverifiable`. No runtime is installed automatically to satisfy the request.

Research receipts retain the egress policy. They cannot be reused as unrestricted sessions or with changed grants. Five-minute guest-side egress expiry bounds abandoned runtimes; normal cleanup closes the exact instance and deletes its disposable volume. A failed launch/cleanup retains the usual inspectable receipt for reconciliation. Research does not reuse Bot or human profiles, cookies or pinned browser sessions. See [ADR 0112](adr/0112-research-network-egress.md).

## Recovery and shutdown

Profile records live in `browser/profiles.json`; native ownership receipts in
`browser/sessions.json`. Preserve both. A failed launch keeps its reservation.
Supervision rechecks health every five seconds after the prior cycle finishes;
unavailable inventory never triggers orphaning. A failed profile reports its
error rather than claiming readiness. Current admission remains bounded to
sixteen native reservations and the host's available capacity.

Planned server shutdown drains Bot clients first, then the browser lifecycle
process closes controllers and Chrome before stopping exact VMs. Profiles remain
on disk. Restart refreshes guest IP and CDP relays; old relay URLs are not durable
identities. Sudden power/process loss is not a clean Chrome flush guarantee.
Do not delete or claim a foreign instance/volume to make recovery pass.

Supported automatic recovery is limited to an exact owned Stopped VM, a changed
guest IP/relay, and transient CDP loss that Kernel's in-guest Chrome supervisor
can repair. Each CDP readiness attempt is bounded to 35 seconds, followed by a
later supervision cycle. A persistently unresponsive Chrome in a Running VM
stays failed; Stack does not force-stop that VM and risk unflushed data.
A missing recorded VM also stays failed with a specific retained-volume error.
Exact-volume VM reconstruction and guest process remediation need an intentional
operator recovery workflow; they are not implemented automatic recovery paths.

Observation URLs address a server-managed loopback gateway. Neko follows the
visible tab. The guest advertises its current address for ICE on every boot,
not the viewer's loopback.
The integration probe decoded 1920×1080 VP8 video at 25 fps over WebRTC after
this correction. The returned `verified` flag remains false for an individual
runtime because supervision does not attach a video receiver to every profile;
callers must observe delivery on their own connection. The gateway restricts
observer signaling and Neko requires explicit host ownership for input; the
`readOnly=1` presentation alone is not the control boundary. These guarantees
cover managed connections, not arbitrary same-user access to guest network ports.

## Human handoff

A handoff holds the entire profile, including all tabs and existing managed
controllers. Other profiles remain usable. Human actions use the local operator
socket or WebSocket API; they are not exposed through agent MCP.
The viewer uses the image's configured keyboard layout. Runtime keyboard-layout
changes are not forwarded; ordinary key input uses Neko's data channel.

The requesting Chat first chooses a UUID and subscribes through the browser
MCP connection's generated `events_subscribe` operation:

```json
{
  "topic": "browser_handoffs_changed",
  "readOperation": "browser_handoff_completion",
  "readArguments": {
    "botId": "bot-1",
    "threadId": "the-originating-chat-id",
    "requestId": "the-chosen-uuid"
  }
}
```

Then call `browser_handoff_request` with the same `requestId`, a `profileId`,
optional `targetId`, and a message explaining what the human should do. Bot and
Chat ownership are verified from invocation context. Subscribe before requesting
so an immediate human response cannot be missed. Inspect the subscription's
initial value: an already-completed result is returned there, not deferred to a
future event. Unsubscribe after processing the terminal result.

- `preparing`: new managed automation is blocked; accepted CDP work is draining.
- `awaiting_human`: drain completed; the browser waits for the human.
- `human_controlling`: `browser_handoff_take` issued an interactive connection.
- `returning`: human input is being revoked and agent controller refs invalidated.
- `resolved`: the durable outcome is `completed`, `skipped`, or `cancelled`.

`browser_handoff_get` and `browser_handoff_list` expose state, revision and issues.
Operator take/finish and agent cancel require `id`, `expectedRevision`, and an
action `requestId`. Retry the identical action after a lost response; do not mint
a new request ID to retry uncertain work. `browser_handoff_finish` accepts
`outcome: "completed" | "skipped"` and an optional `note`, including directly
from `awaiting_human`. The originating Chat can cancel only before human take.

Closing the viewer or losing a connection never returns control. An unresolved
handoff remains held across server restart. If the server lost track of accepted
CDP work before confirming drain, the hold remains with an issue; this release
does not provide a force-release operation. A missing starting tab is reported
explicitly. Human completion is a report, not proof the requested task succeeded.

The completion read stays `{ "result": null }` throughout pending states. A
resolved result changes that value and uses the ordinary MCP subscription
delivery to start a turn on the originating sanctioned Chat. There is no separate
handoff continuation queue. Existing reconnect semantics still apply. After
handback, reconnect and take a fresh snapshot before interacting or assessing
the human's result.

No handoff cards, banners or human viewer controls are added in this change.

## Isolated verification

`pnpm test` uses fixtures, not live VMs. `packages/browse/test/runtime-proof.mjs`
is an explicit, opt-in integration probe. Run it only with authorization to create
disposable VMs, a running local `HYPEMAN_ROOT`, and `AGENT_BROWSER_TOOLCHAIN`
pointing to an installed 0.38.1 toolchain. It creates an isolated state directory,
fake Bot inventory, exact tagged resources and its own controllers. It checks
selection, isolation, ref invalidation, clean cold persistence and orphan
retention, attempts Neko video observation, and deletes only its exact receipts.
It never starts or restarts a production server or changes production selection.
