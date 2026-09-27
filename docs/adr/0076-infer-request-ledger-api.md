# 76. The inference request ledger as API, with asynchronous admission

Status: accepted, 2026-09-26. Extends the durable dispatch records of
[ADR 0075](0075-headless-conversation-attention.md) and amends
[ADR 0052](0052-private-experimental-inference.md)'s single synchronous call.
Supersedes the Lab Inference window's page-local runs and its dependence on
long WebSocket calls from [ADR 0074](0074-lab-inference-over-websocket.md).

## Context

The Lab's Inference window used `infer_complete`, which holds one call open for
fresh discovery plus the backend request. Reaching it over the WebSocket needed
long per-operation forwarding timeouts, the window had to guess outcomes from
transport errors, and runs lived only in the page. ADR 0075 had meanwhile given
`infer` durable dispatch records keyed by request ID, but they were readable only
as raw traces. A UI needs prompt calls, readable records and change notices, as
other Package APIs provide.

## Decision

The `runs` table in `<state>/infer/traces.sqlite` is the one inference request
ledger, and reading it is part of the `infer` API. Every request from
`infer_complete` or `infer_start` is one run, in one of four states: `running`,
`completed`, `failed` (definite: nothing was sent, the backend refused it, or it
completed above the token threshold) or `unknown` (it may have been charged: it
was interrupted after it could have been sent, or `infer` restarted while it was
running). A run finishes exactly once; a late outcome never overwrites one already
recorded.

- **`infer_start`** takes the same input as `infer_complete` with a required
  request ID. It admits the run and returns its running record at once, then
  performs the same fresh discovery check and single backend request in the
  background. An identical resend returns the recorded run, whichever operation
  created it; a request ID never dispatches twice. Busy accounts and shutdown are
  refused at admission and are not recorded.
- **`infer_request_list`** pages the ledger newest first with short previews;
  **`infer_request_get`** returns one full record. `infer_trace_read` remains the
  dispatch evidence.
- **`infer_model_list`** reads discovery cached per account and never starts
  it. **`infer_discover`** starts a background `model/list`, coalesced per
  account. `infer_models` still discovers and waits, and it and every request's
  own fresh check also refresh the cache. The cache is held in memory.
- **`infer_changed`** is published for every run or cached discovery change.
- Shutdown cancels in-flight discovery and requests. A request cancelled before
  sending fails as `cancelled`; one that may have been sent is `unknown`.

`infer_complete` and `infer_models` keep their contracts for `attention`, as does
the WebSocket bridge's timeout for any caller of them. The Lab Inference window no
longer uses either. It reads the ledger and model cache through the shared store,
re-reading after `infer_changed` and after each `infer_start` or `infer_discover`
attempt. Requests survive a reload and are followed from running to their outcome.
If an admission response is lost, the window shows the request once the ledger
lists it; otherwise it offers Resend with the same request ID.

## Consequences

The Lab window lists every inference request, including those `attention` makes.
The ledger keeps prompts and outputs on disk with no retention limit or removal
operation. There is still no MCP Transport for `infer`.
