# 93. Fence managed browser control during durable human handoff

Status: accepted, 2026-09-28. Extends [ADR 0092](0092-durable-bot-browser-profiles.md), superseding its exclusion of handoff; uses [ADR 0033](0033-agent-facing-event-subscriptions.md) and [ADR 0032](0032-bot-mcp-invocation-context.md).

## Ownership and durable states

A Browser handoff covers a whole Browser profile: every tab and every managed
controller, including controllers connected before admission. There is at most
one unresolved handoff per profile. Another profile remains independently usable.
The origin is the verified invoking Bot launch and sanctioned Chat, checked using
the Bots Package API's lineage-checked `chat_thread_read`. Input IDs cannot choose
an origin. Bot deletion retains both the profile and its unresolved hold.

The record progresses through `preparing`, `awaiting_human`, `human_controlling`,
`returning`, and `resolved`. Only resolved records have a completion projection;
the outcome is `completed`, `skipped`, or `cancelled`. Pending runtime/drain issues
are separate from the outcome. Completed is a human report, not browser-state
verification. A target ID is a starting hint, activated on human take after drain;
a missing tab is reported, never silently replaced by an invented target.

Request IDs deduplicate identical admission intent within the originating Chat.
Human take/finish and agent cancel have action request IDs and expected revisions.
Repeated identical actions report current durable state; changed intent with the
same ID is refused. Stale new actions are refused. Only the originating Chat may
cancel, and only before human take. The local operator may finish completed or
skipped directly from awaiting_human. Disconnect, timeout, closing a viewer, and
owner restart never resolve a handoff.

## Managed control gates

The former CDP byte passthrough cannot enforce a hold on established sockets.
Each managed profile now has a server-owned, decoded WebSocket gate in front of
the existing internal relay. Admission synchronously denies new CDP work and new
connections before awaiting persistence. Already forwarded CDP requests are
tracked by connection, session ID and request ID and drained to replies, then
connections are closed. Nonflattened `Target.sendMessageToTarget` is refused:
its outer acknowledgment does not establish completion of nested work. Chrome
HTTP exposure is restricted to read-only discovery. Agent-browser continues to
own page/tab commands, and its native HTTP discovery requires root CDP paths.

The drain deadline is five seconds. If an accepted request has not replied, the
handoff remains preparing with an issue; retrying its identical admission can
finish a later drain. Losing a connection with accepted work is unknown, not
quiescent. It remains held. An owner crash before a durably confirmed drain also
remains unknown across restart. No automatic reboot, terminating an evaluation,
or destructive recovery is inferred. That exceptional case currently needs
operator diagnosis and a separately designed exact-runtime recovery action;
this change deliberately supplies no unsafe force-release operation.

The existing Neko viewer is served through a managed gateway. Observation and
human grants have different unguessable URLs; input grants are returned only by
the operator action and never by Bot reads or completion. Static assets and an
explicit signaling allowlist are exposed, not Neko's general admin API. Observer
signaling cannot acquire host or change clipboard, keyboard, or room settings.
Human viewers also use the image's configured keyboard layout: the gateway
does not forward `control/keyboard`, which changes guest-global XKB settings.
The bundled viewer sends that message automatically on host acquisition. In
isolated runtime checks, allowing it stalled native input; suppressing it restored
trusted key delivery and the complete handoff/return flow. This is a managed
protocol restriction, not an upstream root-cause diagnosis or carried patch.

WebRTC input does not pass through this gateway. Therefore the server sets and
verifies Neko `implicit_hosting=false`; only the explicitly granted human may
acquire host through managed signaling. The pinned legacy input handler then
checks actual host identity for data-channel input. Each new viewer connection
checks the policy again and fails closed if the runtime changed. Before handback,
the owner takes host, closes managed signaling, deletes all managed viewer
sessions through Neko's admin API (which destroys their WebRTC peers), and verifies
their absence. No claim relies on the presentation query `readOnly=1`.

On return all controllers still bound to that profile are closed using the
managed native agent-browser namespace, invalidating their old refs. Controllers
that selected a different profile are not closed. Admission reopens before the
resolved record is durably stored and published, so a failed resume cannot emit a
false completion. During that persistence interval the completion read remains
pending. A write failure re-holds admission and clears the prior quiescence proof:
new work may have entered, so retry must drain again. A new browser snapshot is
required to verify the human's report.

These guarantees cover managed paths. Raw guest CDP, guest Neko, and same-user
operator sockets remain reachable; this is not hostile-process network isolation
or proof that a local socket caller is a human. No external fork patch is carried.
The implementation uses the pinned Kernel image's existing Neko APIs and source
contract (`kernel/neko` server revision `abe9ac59a634`, notably session host checks,
session deletion and room settings).

## Existing MCP subscriptions, not another continuation service

The agent chooses a request UUID, then calls the browser connection's generated
`events_subscribe` with topic `browser_handoffs_changed`, read operation
`browser_handoff_completion`, and arguments `{botId, threadId, requestId}` for its
own Chat. This read returns `{result:null}` before admission and throughout pending
states. Then it requests the handoff using the same request ID. This ordering
establishes the subscription before the handoff can complete. If recovering a
workflow that requested first, a completion that already happened is present in
the subscribe tool's initial read and must be handled immediately.

The existing subscribe-before-read machinery covers invalidation races. Only a
resolved projection changes the pending value, suppressing intermediate wakeups.
The owner authorizes the exact originating Chat/read tuple, and browser
subscription reads retain the MCP invocation context instead of gaining operator
read access through the socket. Existing durable subscription rebind, reconnect
snapshots, value coalescing, delivery status and sanctioned `turn/start` are used
unchanged. Reconnection may deliver the ordinary pending snapshot. Delivery can
still be unknown or fail under ADR 0033; there is no second delivery queue.

No UI controls or handoff windows are introduced. A future human viewer may use
the existing read, take and finish operations; it requires an explicit UI request.
