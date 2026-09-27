# 74. Lab inference over the loopback WebSocket

Status: accepted, 2026-09-26. Amends [ADR 0052](0052-private-experimental-inference.md)'s
socket-only Transport. The window's page-local runs and long WebSocket calls are
superseded by [ADR 0081](0081-infer-request-ledger-api.md). Adds a second experiment to the Lab space of
[ADR 0073](0073-lab-space-and-call-speech.md).

## Decision

The `infer` Package API adds the `websocket` Transport so UIX can reach it. It
still has **no `mcp` Transport**: Bots and other agents gain no route to spend
account allowance, which was the accidental-spend path ADR 0052 was most
concerned with. The WebSocket listener is loopback-only with Host and Origin
checks, the same local-user trust boundary as the Bot and account controls UIX
already operates.

The WebSocket bridge's 10-second default forwarding timeout is shorter than
inference's own bounds (up to 20 seconds of `model/list` discovery, then one
backend request bounded at 30 seconds). A bridge that timed out first would
report a failure while a possibly charged request continued, so `infer_models`
forwards with a 30-second and `infer_complete` with a 75-second timeout, beside
`voice_dial`'s existing exception.

The Lab's **Inference** window (`inference`) exercises both operations on an
explicitly chosen, enabled Bot account. Nothing is discovered when the bench
loads, since every window is mounted on the open bench and discovery starts an
app-server: choosing an account discovers its models once, and a refresh control
repeats it. Model and effort default to the first offered model at its default
effort. Each Run, from the button or ⌘Enter, makes exactly one `infer_complete`
request; the window names the account whose allowance it spends and allows one
run at a time. Failures are shown in place and never retried.
`infer_outcome_unknown`, a lost connection or a forwarding timeout is reported
as an unknown outcome that may have been charged, with the request ID when
known. Completed runs, with output, token usage and elapsed time, are kept on
the page only.

## Consequences

Any local process or loopback page that passes the WebSocket Origin check can
now make a spending inference request, as it could already start Bots or change
accounts; the server's one-request-per-account limit still applies. ADR 0052's
other constraints are unchanged: explicit enabled Bot accounts, fresh discovery
before each request, no tools, turns, retries, token refresh or Platform
fallback, and an experimental, unsupported backend route. Removing the Lab
window should also remove the `websocket` Transport unless another UI uses it.
