# 132. Own semantic work in a native HUD Package API

Status: accepted, 2026-09-29.

## Decision

`packages/hud` owns the shared durable work graph under `<STACK_STATE_DIR>/hud/work.sqlite`.
It is a Server-supervised Package API with the standard private socket, selected
MCP operations/events and WebSocket operations/events. Discovery imports its
contract without opening the store. The Server stops Workers before HUD, and HUD
before Bots. It imports neither the archived AgentHUD database nor its UI.

The archived design supplies the important separation: semantic work, reported
results, human decisions and native execution are different facts. The new API
uses Stack identity and resource owners rather than AgentVoice/AgentChats receipts,
an independent agent registry, or a second execution controller.

## Work and collaboration

A Work item has a stable UUID, ordered parent, objective, summary, explicit state,
priority, next action, human/agent attention, labels, dependency IDs and typed
links. States are `planned`, `active`, `blocked`, `waiting`, `paused`, `review`,
`completed` and `cancelled`. They are semantic declarations, not runtime phases.
Waiting or attention never grants approval. Completion checks that all descendants
are terminal and all direct dependencies completed; cancellation is not dependency
completion. Containment and dependencies share an acyclic completion graph.
Nesting is bounded at 128 levels. Parent closure never cascades to its children.

Every mutation uses a caller-generated request UUID. Creation also supplies the
Work item UUID, making lost-response recovery straightforward. Later edits require
`expectedRevision`. The journal, receipt, items, metadata and graph checks share one
SQLite transaction. A batch validates the **final** graph, allowing a subtree to
close or reopen atomically. Identical requests return their original compact
receipt; changed input or actor conflicts. No native dispatch happens in a HUD write.

`revision` covers all durable item edits and notes. `scopeRevision` advances when
the objective, containment or dependencies change. Closed scope must be reopened
before revision. Immutable progress, result, decision and handoff notes retain their
recording actor and scope revision; an old result remains inspectable after a new
objective. Results and decision notes do not themselves change work state or
establish human approval. The journal includes public before/after edits and exact
references, and supports cursor-based recovery.

Namespaced JSON metadata is an explicit separate read/write surface for agent
correlation and coordination. It is absent from work/tree/journal projections.
Replacing one namespace preserves the others; JSON null, false and empty values
are meaningful. Null at the namespace boundary removes that namespace. Exact
namespace/key/value correlation is available through `work_list`. Each item has
at most 32 namespaces of 16 KB each. This is presentation separation, not secret
storage or an additional authorization boundary.

## Identity, focus and resources

Bot callers are verified against their current private launch and sanctioned
main-thread lineage. Actor identity comes from invocation context, never a public
`actor` argument. Local operator calls are recorded as operator actions. Bots
collaborate on the shared Work graph rather than receiving private per-Bot silos.
Workers get no HUD MCP disclosure by default; their own Worker reads include their
captured work context.

Creation by a Bot automatically records its originating Chat. Explicit links can
name the operator, a root-bound Bot, a sanctioned Chat, a Worker and optional exact
turn, another Work item, an HTTP(S) URL, or a generic Package API resource locator.
Relations include lead, contributor, context, evidence, output and related. Native
Bot/Chat/Worker references are checked on new writes. Generic resource locators and
URLs are declarations, not liveness or existence claims. Historical links remain
after their targets disappear. A label never establishes identity.

Chat focus is a separate revisioned contextual selection, keyed by Bot ID,
main-thread ID and exact Chat ID. Bots change only their calling Chat; an operator
can select an exact sanctioned target. A descendant inherits its nearest explicitly
selected ancestor focus. Never-selected focus differs from saved null: null is an
inheritance barrier. Root replacement cannot inherit a retired root's focus.
Creation alone does not select focus, and focus is not proof of current activity.

`worker_start` and `worker_send` accept optional `workItemId`:

- An ID resolves that open item and captures its current scope revision.
- Null explicitly opts out for that turn.
- Omission on start inherits verified Chat focus; an operator start stays unbound.
- Omission on follow-up continues the previous turn's association at the current
  scope, falling back to Chat focus if the previous turn was unbound.

Worker owns the admission transaction. The resolved context is stored in that
transaction alongside its turn, not dual-written into HUD. The requested selector
is part of idempotency; automatically resolved focus is not re-resolved on a retry.
Scope revision is evidence observed before admission, not a cross-package lock or
execution authorization. Concurrent scope changes remain detectable by comparing
revisions. Closed focus or an unavailable required lookup refuses admission rather
than silently dropping context. Explicit null and unbound operator admissions do
not require HUD. Runtime recovery never dispatches again or changes prior context.

`worker_work_list` pages these associations with current native observations,
respecting existing Bot ownership. `work_resources` joins that read with typed
links and up to 100 exact focuses, with count/truncation. Worker visibility is
explicit (`all` for operators, `own_bot` for Bots), and unavailable is distinct from
an empty inventory. Captured scope and current scope stay separate. Worker removal
removes that owner's turn records; durable HUD result notes and links survive.

## Events and presentation

`hud_changed` invalidates the shared durable view. Item-scoped `work_changed`
includes affected ancestors and reverse dependencies, whose **stored** revision
need not change. Both carry only topic names. Tree pagination is bounded and fenced
by a journal snapshot; later pages must restart after intervening changes.

Runtime owners keep their own event topics. Resource clients additionally subscribe
to `worker/workers_changed`, and use Bots' scoped topics for Bot/Chat observations.
HUD does not relay native activity into agent wakeups or semantic state changes.
Clients subscribe before reading and resnapshot on reconnect. The UI data contract
includes the new Worker context; the existing generic inspector shows it. A new HUD
Canvas space is a separate UI implementation; [ADR 0133](0133-hud-space.md) records it.

Remote Access exposes HUD's selected read-only WebSocket operations under `ui:view`;
[ADR 0133](0133-hud-space.md) adds the `/hud` route and `ui:control` collaboration writes.
The local WebSocket exposes the declared collaboration mutations already. No new
UI controls or runtime restart are part of this API change.
