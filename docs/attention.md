# Headless conversation attention

`attention` runs under the Stack server. It starts paused on a new installation;
its enabled state, defaults and source checkpoints survive server restarts.

## Configuration and activation

Call Package API operations through the private socket or the shared `/websocket` connection with `params.package: "signal"` (the examples below are operation name and arguments, not complete WebSocket frames):

```json
{"name":"attention_defaults_set","arguments":{"model":"gpt-5.6-luna","reasoningEffort":"low","accountId":null}}
{"name":"attention_control","arguments":{"enabled":true}}
{"name":"attention_status","arguments":{}}
```

First enable baselines each existing source. `baselined: true` confirms completion;
`sourceErrors` reports sources that could not be read. Subsequent messages and
newly appearing historical data are admitted regardless of authored timestamps.
Pause/resume preserves checkpoints and catches up; there is no automatic backfill.

`attention_models` returns model/effort choices and the effective account ID.
Defaults reads include `revision`; pass `expectedRevision` on updates when several
clients may edit them. Null `accountId` selects the first available enabled Bot
account. An explicit assignment never falls through to another account.

## Read the results

- `attention_list`: current semantic items; filter by `conversation`, `state`,
  `audience` or attention `reason`. `awareness` is information worth seeing without
  a requested response. Resolved items retain their original reason and new state.
- `attention_message_list` / `attention_message_read`: captured revisions, complete
  text and source evidence. Worker text units may be provisional or span native
  chunks; their origin and coverage are explicit.
- `attention_run_list`: all attempts, including invalid output and unknown outcomes.
- `attention_changes`: resumable processing and state-transition observations.
- `signal_changed`: payload-free invalidation; re-read the appropriate operation.

- `attention_feedback_list`: recorded feedback, optionally for one `messageId` or `runId`.

`attention_list` also filters by `botId`, `messageId` or several `states`;
`attention_message_list` by `botId`; `attention_run_list` by `messageId` (run
entries name their message, `replay`, `replayOf` and `promptVersion`); and
`attention_changes` by `kinds` or `excludeKinds`. Source-read polling dominates
the change log, so exclude `source_read` and `source_read_failed` to see
attention changes.

`signal_changed` follows every source scan while processing is enabled. Re-read
`attention_status` and compare its `changeSeq`: it advances only for events that
can change attention records, so an unchanged value means list reads are still
current.

Page with `after` / `nextCursor`; read all pages while `hasMore` is true. Pass
`order: "desc"` to read newest first, then pass each `nextCursor` as `before`. An item
page is a current view, so restart pagination after invalidation when reconciling
changed existing records. The changes operation has a durable append-only cursor.

## Export and evaluate

`attention_trace_read` exports a run with exact rendered input, context and prompt,
source text, raw completion, parsed interpretation, versions and feedback. Read
UTF-16 chunks using `offset` and pass the returned `revision` on subsequent reads;
restart from zero if the export changed. `infer_trace_read` on `infer` supplies
provider request/response evidence for each correlated request ID. Correlated
account attempts are also in the exported events.

`attention_blob_read` recovers content-addressed source evidence;
`attention_event_read` recovers event bodies omitted from bounded pages.
Source-read events retain the exact API arguments, result blobs, timing and
failures; message provenance links back to the corresponding source-read event.

`attention_feedback` records an idempotently keyed, attributed correction, label,
outcome or behavioral observation. It does not mutate predictions or declare a
request resolved. `attention_replay` takes `runId` and a fresh `requestId`; it uses
the original frozen input/context with current defaults and prompt, appending a
non-promoting evaluation attempt. Repeating the admission key does not enqueue
another run. Processing must be enabled to execute queued evaluations.

SQLite stores live under `<STACK_STATE_DIR>/attention` and
`<STACK_STATE_DIR>/infer`. Trace retention is durable. Subscription inference
does not expose a reliable dollar price: token usage is observed, dollar cost is
unavailable rather than reported as zero. A provider timeout or lost response is
unknown and is never silently retried.

The backend rejects a provider-side `max_output_tokens` parameter. Inference's
`maxOutputTokens` is a post-response threshold checked against available usage;
it does not cap generation or spend. An over-threshold response remains in the
inference trace and reports `infer_output_budget_exceeded`.
