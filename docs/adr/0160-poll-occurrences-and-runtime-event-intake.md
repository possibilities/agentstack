# 160. Poll typed occurrences and deliver through backend-owned conversation intake

Status: accepted, 2026-10-01. Extends [ADR 0096](0096-explicit-transport-exposure.md),
[ADR 0060](0060-claude-sdk-workers.md), [ADR 0146](0146-server-independent-internal-mcp.md)
and [ADR 0159](0159-github-webhook-ledger-and-watches.md). Supersedes
[ADR 0114](0114-explicit-worker-disclosure.md)'s blanket exclusion of Worker events
only for explicitly selected typed occurrence sources. Preserves the Bot-only
snapshot/completion-watch contract in [ADR 0155](0155-correlated-admission-watches.md)
and native Codex admission in [ADR 0120](0120-codex-native-input-admission.md).

## Protocol and Package API

The experimental [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
is a draft, not a stable protocol version. Stack implements its **poll profile**:
`events/list` publishes typed input/payload schemas and `delivery:["poll"]`;
`events/poll` returns stable-ID occurrences, an opaque response cursor,
`truncated`, `hasMore` and `nextPollMs`. Push and webhook methods return
`Unsupported`. No callback registration, webhook signing, TTLs, or MCP 2.0
negotiation is implied. ChatGPT plugin webhook interoperability is a separate
milestone, not a prerequisite for managed local delivery.

An owner declares a source with `pollEvent` as a typed read-only operation in its
Package API. The shared gateway selects the occurrence name **and** poll operation
through MCP exposure and validates live metadata before/after execution. Internal
stdio discovery reads installed declarations without creating contexts; source
execution always visits its live socket owner. Socket/WebSocket `events/subscribe`
and payload-free invalidations are unchanged and do not become occurrences.

`mcp.workerEvents` is a positive occurrence-name list, defaulting to `[]`. It
explicitly grants the source's read-only poll operation, intersected with ordinary
MCP operation/event exposure. It never grants other source reads, mutations,
snapshot subscriptions or completion watches. Source owners retain resource
authority. The initial `source` selection discloses retained GitHub watch delivery
summaries by watch ID; these watches are shared source resources, not Bot-owned
records. Receiver secrets, raw payload reads and remote hook controls stay excluded.

GitHub occurrences reuse its frozen watch matches and durable arrival ledger.
Null cursor starts now. Explicit cursors bind watch identity/filter/start and replay
retained matches in arrival order with age/count bounds. Event IDs combine receiver
identity and upstream delivery GUID. Acknowledging a watch's consumption cursor,
polling or native input admission does not change any other cursor. Disabling a
watch pauses polls without discarding its position; removal refuses later polls.

## One subscription owner, two acknowledgement boundaries

`events_listen` is a Stack-generated **tool**, not draft `events/subscribe`. It
attaches a source to the invoking verified Bot Chat or Worker. Serve's existing
subscription owner keeps occurrence state in its existing private SQLite ledger;
no new process, webhook receiver or subscription authority is introduced. Source
intake and cursor advancement commit together before runtime dispatch. Repeating
the same canonical arguments/policy retains the existing subscription and cursor.

Bot targets remain sanctioned loaded root/descendant Chats. Worker targets resolve
their exact native session from the signed Worker/runtime identity and owner ledger,
never caller metadata. Runtime replacement may rebind only that same conversation;
Worker `needs_recovery` requires the existing explicit load/resume flow first.

| Backend | `native` policy | Explicit `interrupt` policy | Receipt boundary |
| --- | --- | --- | --- |
| Codex Bot | Existing standalone `toolOutput` via `turn/start`: idle wake or active start-or-steer | Refused by this profile | `native_admission` |
| OpenCode V2 ACP Worker | Recorded text follow-up in the exact session after the active prompt ends | Request cancellation; wait for its terminal response before follow-up | `worker_inbox` |
| Devin ACP Worker | Same conservative idle-only ACP follow-up | Same cancellation/terminal fence | `worker_inbox` |
| Claude SDK Worker | Synthetic observed-data input in its existing noninteractive lifetime Query | Existing SDK interruption; wait for terminal outcome before follow-up | `worker_inbox` |

ACP v1 `session/prompt` returns at completion, not admission. OpenCode V2.0.16's
ACP adapter explicitly refuses concurrent same-session prompts despite its HTTP
API's steering capability. Devin's busy ACP semantics are not established. The
pinned Claude SDK supports continuation/interrupt and synthetic input, but lacks
a public immediate per-input admission promise. Therefore Workers acknowledge
**durable Stack inbox intake**, not pipe write, native acceptance or consumption.
No native busy steering is claimed for Workers. No upstream patch is required.

The Worker inbox is a backend-owned handoff boundary, not a second subscription
manager: it knows no source filters/poll schedules/cursors. Its idempotent delivery
receipt names a separately recorded turn once dispatched. It reuses Worker
permissions, turn completion, model settings and captured HUD Work context;
event-generated inference is never invisible work, and completion never completes
Work. ACP receives fixed host framing plus JSON-encoded untrusted observations,
not fabricated tool results or human approval. Claude input is synthetic, not human.

## Recovery, capacity and maintenance

Serve persists an unknown delivery fence before crossing the input boundary.
Only proven pre-dispatch/native rejection permits retry. Ambiguous attempts block
later automatic delivery and never replay on restart. Worker dispatch reserves its
request-ID turn before native input; restart/stream loss recovers it as unknown,
not another prompt. An interrupted cancellation with uncertain outcome likewise
blocks further automatic event input. Explicit native recovery does not replay the
unknown event; inspect and close/replace the affected subscription/Worker as needed.

Snapshot and occurrence admissions share 128 active/in-flight slots. Occurrence
dedup/receipt retention is capped at 10,000 across the owner; Worker inbox retention
is capped at 1,000 per Worker. Reaching capacity stops new intake without advancing
its cursor and requires exact inspection/removal. Latest-128 histories disclose
truncation/counts (128 receipts total per conversation status, up to 128 on exact
operator subscription inspection). No silent receipt pruning or exactly-once processing guarantee
is introduced.

Local operators inspect through `serve_occurrence_list/get` and remove at exact
intent revision through `serve_subscription_remove`. Bot maintenance dependencies
include its occurrence subscriptions. Source watches remain independent. Removal
fences future intake but cannot recall an admitted Worker inbox/native input.
Worker close cancels undispatched inbox entries; transcript maintenance redacts
their text too, and Worker removal deletes its inbox records. Native/provider,
source and Serve copies remain separate.

Existing discovery/reference UI truth is maintained. Dedicated occurrence
inventory, source setup, receipt/turn linking and optional controls require explicit
UI-team work; they are not implicitly built. Isolated fixture verification is not
proof of native scheduling on a paid account. Builds and landing do not authorize
an active Server restart.
