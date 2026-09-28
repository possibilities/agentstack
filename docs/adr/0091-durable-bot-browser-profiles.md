# 91. Give Bots durable profiles and independent browser controllers

Status: accepted, 2026-09-27. Supersedes [ADR 0076](0076-internal-disposable-browser-lifecycle.md); extends [ADR 0014](0014-recovery-and-shutdown-order.md).

The browser Package API owns profile admission, exclusive Bot assignment,
native resource receipts, runtime supervision and controller selection.
Agent-browser retains all page/tab commands. Each existing Bot receives one
empty default profile; additional empty profiles are admitted explicitly.
Every profile, including retained unassigned profiles, has one running Kernel
browser while the owner runs. There is no sleep, cloning, sharing or handoff.

Bot deletion clears assignment, not data. Explicit destructive profile deletion
is the only durable-data removal boundary; an assigned default and selected
profiles cannot be deleted. Old disposable receipts remain inspectable and
explicitly disposable, but no new disposable launch operation is exposed.

A Bot launch receives a private provider configuration containing a signed
launch proof and an isolated namespace derived from state root, Bot and native
instance. The provider verifies that proof against live Bot inventory. Controller
session names are routing keys within that scope, never proof of identity.
These are same-user correlation and stale-instance fences, not an OS sandbox.
Worker account processes do not inherit Bot browser configuration.

The owner also issues a signed browser management MCP connection to Bots. Its
positive operation list contains only profile list/create/delete and controller
list/select. Handlers verify the transport-supplied Bot ID and instance against
the live Bot inventory; requested IDs do not establish identity. Reads include
only that Bot's profiles and its current-launch controllers. All three mutations
recheck live ownership at the mutation boundary and refuse foreign or unassigned
profiles. Anonymous/Worker MCP calls are refused. Local operator socket and
WebSocket management retain broad access; provider launch/close, Bot retirement,
and installation operations are absent from MCP.

Agent-browser 0.38.1 supports queued `connect` on an existing controller.
The selection ledger must change before reconnect: a later command reapplying
provider configuration would otherwise return to the former provider selection.
The management operation serializes selections per controller, queues native
connect with native page commands, then reads the actual CDP browser URL and
active target. Old refs are invalidated. Failure returns an unknown actual binding,
not a fictional successful switch. Other controllers have no interaction lock.
The provider's close callback only records disconnect; upstream suppression of
provider-close errors cannot discard profile data.

The disconnect observation is best-effort when the owner socket is already
draining. It does not own an external resource release and must not prevent
agent-browser from closing its own connection. Controller inventory therefore
describes last observations, rather than asserting continuous liveness.

Profiles report starting, ready, recovering or failed with observation timestamps.
An unavailable Bot inventory never proves deletion. Native instance ID, profile
volume ID, lease tags and mount identity are checked before attachment or restart.
Stopped instances restart with `{}` and their new address replaces the old relay.
The browser process receives planned shutdown before its process group: it drains
controllers, sends Chrome `Browser.close`, then stops exact owned VMs, retaining
volumes. The external/shared Hypeman service is not stopped by AgentStack.

Recovery has a deliberate data-preserving limit: AgentStack restarts a verified
Stopped VM and refreshes its relay, while the pinned Kernel runtime supervises
Chrome inside a Running VM. CDP readiness is bounded to 35 seconds per attempt;
a persistent Chrome/CDP failure is reported failed and re-probed, never converted
into an automatic hard reboot that might discard unflushed writes. A missing
recorded VM or changed ownership also fails closed, retaining the volume receipt.
Automatic exact-volume VM reconstruction and guest process remediation are not
implemented; these failure domains require operator recovery and remain an
explicit limitation of this phase's supervision.

Kernel/Neko observation connection information follows the visible tab. Connection
availability and verified video delivery are distinct; no background preview or
new UI control is implied. The existing dynamic API reference exposes management
schemas. Any future profile picker or observation window requires a separate UI
request.
