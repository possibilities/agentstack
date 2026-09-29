# 120. Let Codex schedule subscribed events and chat input

Status: accepted, 2026-09-29. Supersedes the idle/completion delivery policy in [ADR 0033](0033-agent-facing-event-subscriptions.md) and its use by [ADR 0039](0039-worker-wakeups-and-scoped-mcp.md). Refines [ADR 0096](0096-explicit-transport-exposure.md)'s admission boundary.

## Decision

Stack submits input once through the existing Codex app-server `turn/start` operation and returns on admission acknowledgement. Codex owns the start-or-steer decision: an idle loaded thread starts work, and an active regular turn receives pending input at a native processing boundary. This can extend the same turn; it is not a promise to wait for `turn/completed`. No idle polling, external start/steer choice, or turn-completion barrier belongs in subscription delivery or automatic chat dispatch.

The pinned codexnk-v0.1.4 runtime (`f2905ff011ff8fda607e91dfdd8f13b6083b1642`) already implements this in `TurnRequestProcessor::turn_start_inner`, `CodexThread::start_or_steer_turn`, and Core's `session/turn_input.rs`. Core queues active input and `session/turn.rs` consumes it before a subsequent model request. No runtime change is required. `turn/steer` remains the narrower explicit expected-turn operation; it does not wake idle threads.

## Subscriptions

Changed snapshots use `turn/start` with empty `input` and a named standalone `toolOutput` (`stack.subscription_update`). This preserves observed-data semantics instead of presenting events as human text. The initial snapshot still returns in the subscribing MCP tool call. Subscribe-before-read, unchanged-value suppression, bounded output, coalescing while a submission is in flight, durable intent, and reconnect snapshots remain.

Independent subscriptions may submit to the same thread without waiting for each other's turns or acknowledgements. `lastDeliveredAt` records the last admission acknowledgement. It does not prove model consumption, persisted Codex history, task success, or turn completion. A refusal or ambiguous submission is recorded, never blindly retried; a later notice or reconnect may submit a fresh snapshot. Native non-steerable tasks may refuse input. This is not a durable event inbox or replay log.

Before submission, including after connection setup, verify the current Bot launch, sanctioned loaded thread, subscription lifetime, and live transport exposure. Unsubscribe and revocation fence unsubmitted values; already admitted input cannot be recalled. Stopped Bot processes and unloaded threads retain the existing lifecycle/rebind behavior; an event never substitutes another thread or starts a stopped process. Feedback-loop guards still apply because native steering also changes chat/thread records.

## Chat receipt observations

`chat_send`, `chat_open`, `chat_steer`, and `chat_enqueue` return `threadState`: the native status, normalized activity (`working`, `waiting`, `idle`, or `unknown`), observation timestamp, and any read error. Stack reads this status while handling the request, before submission. It is an observation, not an atomic Codex admission outcome; the thread can change between that read and acceptance. A failed bounded observation returns unknown and does not block sending. Do not infer started versus steered from the returned turn's `inProgress` status.

`chat_enqueue` retains durable admission IDs and ordered automatic submissions, but drains on each admission acknowledgement rather than turn completion. Its `sent` state means acknowledged by Codex. An unknown dispatch still fences later entries until reconciled. The response's `threadState` describes receipt time, not the later dispatch; it is not persisted on the queue entry. Codex's separate `chat_codex_queue_*` operations keep their native manual-start semantics.

The Fleet operation workbench and inspector render receipt observations through their existing generic record views; no new UI is required.
