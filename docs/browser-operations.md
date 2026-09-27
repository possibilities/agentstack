# Browser operations

The browser Package API owns durable profiles and local Hypeman/Kernel runtimes.
Use agent-browser CLI/MCP for page and tab operations. Each Bot receives an
exclusive default profile automatically; additional profiles start empty.
Profiles stay running while AgentStack runs, including those retained unassigned
after Bot deletion. Controller close only disconnects.

## Installation and launch scope

Select a local Hypeman installation with `hypeman_detect`, optionally
`hypeman_location_set`, then `hypeman_enable`. Detection and installation never
select a host implicitly. A selected host cannot change while durable profiles
remain. `agent_browser_install` installs an exact release in the private toolchain;
updates default to manual acceptance. The validated switching protocol is 0.38.1.

Each Bot launch receives `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_NAMESPACE` and
an idle timeout of zero. Its private config lives in
`<AGENTSTACK_STATE_DIR>/browser/controllers/` and carries a signed, live-launch
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
provider internals. `browser_bot_release` is the owner-local deletion/ID-reuse
fence, so a removed Bot's ID cannot inherit its old profiles between supervision
cycles. Legacy `browser_session_*` inspection/cleanup handles only
old disposable receipts and cannot delete durable profiles. No new disposable
session launch is exposed. These management operations have no new UI controls;
the dynamic API reference continues to describe them.

## Recovery and shutdown

Profile records live in `browser/profiles.json`; native ownership receipts in
`browser/sessions.json`. Preserve both. A failed launch keeps its reservation.
Supervision rechecks health every five seconds after the prior cycle finishes;
unavailable inventory never triggers orphaning. A failed profile reports its
error rather than claiming readiness. Current admission remains bounded to
sixteen native reservations and the host's available capacity.

Planned owner shutdown drains Bot clients first, then the browser lifecycle
process closes controllers and Chrome before stopping exact VMs. Profiles remain
on disk. Restart refreshes guest IP and CDP relays; old relay URLs are not durable
identities. Sudden power/process loss is not a clean Chrome flush guarantee.
Do not delete or claim a foreign instance/volume to make recovery pass.

Observation URLs address the selected host's local guest subnet on port 8080
with Neko's `readOnly=1` presentation. Neko follows the visible tab. The guest
advertises its current address for ICE on every boot, not the viewer's loopback.
The integration probe decoded 1920×1080 VP8 video at 25 fps over WebRTC after
this correction. The returned `verified` flag remains false for an individual
runtime because supervision does not attach a video receiver to every profile;
callers must observe delivery on their own connection. Read-only presentation
is not an authentication boundary. This is an
observation substrate, not a human-control handoff or background-tab preview.

## Isolated verification

`pnpm test` uses fixtures, not live VMs. `packages/browser/test/runtime-proof.mjs`
is an explicit, opt-in integration probe. Run it only with authorization to create
disposable VMs, a running local `HYPEMAN_ROOT`, and `AGENT_BROWSER_TOOLCHAIN`
pointing to an installed 0.38.1 toolchain. It creates an isolated state directory,
fake Bot inventory, exact tagged resources and its own controllers. It checks
selection, isolation, ref invalidation, clean cold persistence and orphan
retention, attempts Neko video observation, and deletes only its exact receipts.
It never starts or restarts a production owner or changes production selection.
