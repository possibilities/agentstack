# @agentstack/codex

Typed Codex app-server lifecycle operations for agentstack APIs.

Every invocation uses the required codexnk release at
`~/.local/libexec/codexnk/codex`, installed by AgentStack's setup through the
codexnk workshop. `server_start` has no executable override and never searches
PATH or falls back to vendor Codex.

`attachInputMiddleware(url, threadId, decide, onResolved)` is a trusted host-side
client for codexnk's opt-in human-input gate. It uses the **Codex** app-server
WebSocket URL returned by `server_start`, including its private `unix://` socket;
AgentStack's own event WebSocket is not an input-control channel. The handler
sees direct typed `turn/start` and `turn/steer` text and finalized realtime
handoffs on the attached thread; other submission paths are outside this gate.
returns `pass`, `replace` or `intercept` but must not execute an intercepted
effect until `onResolved` confirms the disposition (or `read(inputId)` recovers
it). `complete` attaches an idempotent effect receipt to a committed intercept.
Call `detach()` to end observation and restore the unregistered path. An
unexpected `close()` leaves the configured unavailable policy active until
another owner attaches. This library API
does not expose input authority to the browser UI.
