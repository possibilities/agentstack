# 154. Coordinate Notification sends and one-shot dismissal watches in the Server

Status: accepted, 2026-09-30. Extends [ADR 0095](0095-one-dismissal-with-an-outcome.md),
[ADR 0033](0033-agent-facing-event-subscriptions.md) and
[ADR 0039](0039-worker-wakeups-and-scoped-mcp.md). Preserves the exposure fences of
[ADR 0096](0096-explicit-transport-exposure.md) and native admission boundary of
[ADR 0120](0120-codex-native-input-admission.md). Compatible with
[ADR 0146](0146-server-independent-internal-mcp.md): installed stdio discovery
declares the watch without creating it; watched sends still require the live
subscription owner and never use standalone mutation or delivery fallback.

## Decision

`notification_send` accepts optional boolean `subscribe`. For a verified Bot MCP
call it defaults on when actions are nonempty or a reply is offered. True also
watches plain notices; false opts out. Operator and external callers may send
prompts with omission, but true fails before mutation without a sanctioned Bot
Chat. Workers gain no Notification operations or Bot wakeup authority.

Package operations may declare a typed `completionWatch`: the invalidation topic,
record read, UUID input key, terminal field, inputs selecting the omitted
default and fields retained in oversized terminal values. This metadata travels
through installed declarations and live socket/discovery catalogs, not implicit
transport exposure. The send, read and topic must all remain selected over MCP. Notify's
watch reads `notification_get` and treats non-null `dismissedAt` as completion.
The once-only outcomes remain action, replied, closed, opened and replaced;
none is a new semantic state or an inferred permission grant.

Both MCP gateways route the selected operation through Serve's sole
`McpEventSubscriptions` owner. The stdio relay independently authenticates its
signed Bot launch and verifies the per-call thread lineage. The owner subscribes,
then durably reserves the record ID, watch and private coordination capability
**before** calling the record mutation. Notify verifies that capability with the
owner before storing the record. Stdio children create neither contexts nor
databases. A failed coordination check cannot leave a successfully sent but
unwatched Notification.

The shared owner counts active watches and in-flight socket setups against one
128-watch capacity bound for both ordinary and completion subscriptions. Setup
failure releases its reservation. Capability checks retain the active watch's
cancellation signal and recheck its identity and receipt after asynchronous
authorization, immediately before permitting the Notification owner to mutate.

The owner returns the initial record plus `subscription` receipt. Null means no
watch requested; pending/error describes retained intent separately from send
success. A terminal initial value is returned as observed and retires without a
second wakeup. Subsequent reads suppress open records and unrelated changes.
Terminal records use the existing standalone `stack.subscription_update` tool
output on the exact invoking Chat. Oversized records retain the terminal outcome
and answer plus a full-record read pointer rather than dropping the answer.

Admission acknowledgement atomically records delivered and retires the watch.
Receipts retain the destination, record identity and outcome, not Notification
bodies or answers, so the same ID cannot recreate an acknowledged or observed
delivery. Repeated sends still visit Notify to enforce its content digest.
Cross-Chat reuse of a watched ID is refused. `events_status` exposes the latest
128 retained completion receipts or one exact `completionId`, and reports when
older history is omitted; the operator's existing subscription inventory exposes
one-shot metadata while a watch is retained. No new UI controls are introduced.

## Recovery and uncertainty

Reservations survive owner interruption; reconnect reads discover a successful
send or dismissal even if its response or invalidation was lost. The owner never
automatically resends a mutation. MCP ingress allocates omitted record IDs before
relaying so an outer lost acknowledgement still reports a retry key. A failed
send reports its record ID (and reserved watch ID when known); a caller retries
only with that record ID. An acknowledged send whose
initial read fails returns its record with an error receipt and retains recovery
intent. Existing ordinary subscriptions retain their continuous snapshot policy.
The old subscription database gains nullable completion metadata and a separate
receipt table without replacing old rows.

Input validation and Notify's pre-mutation ID digest conflict use the shared
`OperationRejected` error. The private socket preserves this proof as structured
`stack_operation_rejected` error metadata, never inferred from message strings.
A fresh watch proven unsent (including a request not dispatched) discards its
reservation and receipt. Rejection of an established watched-ID retry never
cancels that watch. Generic handler/output errors may follow mutation and retain
read-only recovery, including successful persistence with a lost send ACK.
Graceful shutdown drains proven-unsent cleanup while the subscription database
remains open, even after its active map is cleared. Deletion binds the exact
pending reservation, destination and record identity; cancellation, terminal and
unknown-admission evidence remain retained. Cleanup refuses a closed database and
emits no change callback during shutdown.

Immediately before native `turn/start`, the owner persists an unknown admission
fence only at the ready socket's synchronous dispatch boundary. A socket closed
during asynchronous authorization, before dispatch, or a definite native refusal
proves no admission and permits fresh-read recovery. A lost response, disconnected
native socket or interrupted owner after
submission does not: unknown watches remain inspectable and do not automatically
replay on notices, ID retries or restart. Explicit removal cancels future work
without recalling admitted input or erasing prior uncertainty. Native admission
does not prove consumption, completed work or human approval, and never waits
for turn completion.
