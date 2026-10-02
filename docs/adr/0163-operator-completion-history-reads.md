# 163. Page retained completion receipts and resolve exact domain links for the operator

Status: accepted, 2026-10-02. Extends [ADR 0155](0155-correlated-admission-watches.md),
[ADR 0159](0159-github-webhook-ledger-and-watches.md) and
[ADR 0136](0136-system-state-view-and-shared-maintenance-flow.md). Preserves
[ADR 0096](0096-explicit-transport-exposure.md)'s independent transport exposure,
[ADR 0101](0101-remote-uix-through-access.md)'s remote-selection fence,
[ADR 0120](0120-codex-native-input-admission.md)'s unknown-admission fence and
[ADR 0132](0132-native-hud-work-collaboration.md)'s boundary that native
completion never claims Work.

## Retained receipts as an operator query surface

Completion receipts already persist in Serve's private subscription ledger. They
now outlive the watches that created them: a removed subscription leaves its
receipt with `subscriptionPresent:false`, and exact receipt lookup succeeds
independently of any live Bot, thread or watch.

`serve_completion_list` pages retained receipts ordered by stable receipt ID —
never delivery time or arrival order. Pages after the first must present the
`revision` returned at offset 0; a dedicated `completion_history_meta` table
tracks a store generation and a mutation counter advanced by triggers on receipt
insert/update/delete and subscription insert/delete against existing receipts.
Any receipt-visible change between pages refuses stale continuation with
"completion observation changed; restart paging". Exact filters (`botId`,
`threadId`, `package`, `operation`, `recordId`, `state`) compose inside one
fenced generation. `serve_completion_get` returns one exact receipt by ID plus
one bounded domain-navigation link.

The projection is deliberately narrower than the stored row: `lastError` is only
the fixed codes `diagnostic_withheld` or `native_admission_unknown`, and read
arguments, raw error text, prompts and domain content are never returned. The
raw record remains for the existing `serve_subscription_get` drill-down while a
subscription lives. Cancelling a watch whose admission outcome is unknown
retains `nativeAdmissionUncertain` and the uncertain code; cancelling a known
pending or failed watch clears them. No read replays after an unknown native
admission, and no completion state claims Work completion.

## Bounded identity links through owner reads

A list/get response may carry an exact domain link. Notify and Proc links are
derived locally from the receipt's `recordId`. Browse, Worker and Brain links
are resolved at read time through socket-only `*_completion_identity_get` owner
reads that take only the exact `{botId, threadId, requestId}` (Brain also
`operation`) and return identifiers only:

- `browser_completion_identity_get` returns the exact Chat-bound handoff's
  `handoffId`.
- `worker_completion_identity_get` returns `workerId`/`turnId` for the exact
  request-bound turn.
- `brain_completion_identity_get` returns `jobId`/`documentId` for a submit and
  the complete sorted `runIds` set for a sources sync, capped at 1,000.

Every resolution performs at most one owner call bounded near five seconds and
checks the returned `requestId` and link kind before projecting it. A null
answer is `missing`; an absent owner, throw, timeout or unexpected payload is
`unavailable`; an unknown package/operation is `unsupported`; an absent receipt
is `not_found`. Owner helpers carry fixed-code authorization refusal
(`unauthorized`) and return nothing besides link fields — never prompts,
transcripts, URLs, content, notes, warnings or domain payloads. A receipt that
never links can still be removed separately; history offers neither ID-recycling
nor replay.

## Exposure boundary

`serve_completion_list` and `serve_completion_get` are Serve operations on the
socket and the operator WebSocket only; they are excluded from MCP exposure. A
distinct payload-free `serve_subscriptions_changed` topic announces durable
subscription and retained-receipt transitions — inserts, retries, pending,
`unknown` and recovery transitions and removals — so consumers refresh lists
rather than depend on `serve_state_changed`. Identity helpers are socket-only in
their owner manifests and never appear in MCP or WebSocket selections. The
Access remote-UI selection excludes the completion and subscription reads, the
identity helpers under `ui:view` and `ui:view+ui:control` alike, and
`serve_subscriptions_changed`; remote sessions receive no receipt, link or
subscription-set data. The occurrence inspection reads `serve_occurrence_list`
and `serve_occurrence_get` — which can disclose source arguments and error text —
are likewise local-only under any remote grant.
