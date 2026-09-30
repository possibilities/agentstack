# 0129: Codex tools in the default MCP fleet

## Decision

[ADR 0137](0137-internal-mcp-over-stdio.md) supersedes HTTP for internal launches. External HTTP remains; both transports share the bridge handlers and per-connection backend.

Stack's authenticated loopback HTTP MCP listener includes five stable connections
alongside Package APIs:

| Connection | Upstream |
| --- | --- |
| `computer-use` | Typed native-app tools through the installed Codex REPL and `@oai/sky` |
| `chrome` | Typed Chrome tools through the installed browser plugin |
| `messages` | Discovered `messages` MCP tools |
| `computer-history` | Discovered `computer-history` MCP tools |
| `openai-developer-docs` | Discovered `openaiDeveloperDocs` MCP tools |

These are ordinary default-on fleet entries. Roles use the existing
`disabledInternalMcpServers` exclusions; Bot launch bundles, Worker sessions,
Role CLI injection, launch previews and Inspector consume the shared connection
catalog. A Role switch controls subsequent launches, not installed plugins or
the authority of an existing connection. Missing plugins retain their Role
entries and report availability errors during tool discovery.

The connections are MCP bridges, not Package APIs. They have no `api.yaml`,
socket operations, WebSocket exposure, generated event tools, or entries in the
Package API reference. Package APIs retain their independent manifest exposure
and Worker disclosure rules. Selecting a bridge for a Worker grants that
bridge's tools, including mutating tools; its upstream approvals remain in force.
No remote Access exposure is added.

## Ownership and lifecycle

Bridge routes use stateful Streamable HTTP MCP. Each initialized connection owns
a lazy app-server process and an ephemeral thread, with no inference turn. The
process runs `initialize`, `thread/start`, `mcpServerStatus/list`, and
`mcpServer/tool/call`. Each session serializes calls and owns its REPL and
approval context. Tool lists are read again before invocation. Native
pass-through tools retain their upstream schemas, content blocks, structured
output and metadata.

Every HTTP request uses the existing local operator or signed Bot/Worker
identity checks. A session ID additionally binds one route and one launch/session
identity. Authority is checked before invocation, around elicitation and before
returning results. Session termination, server shutdown, request cancellation,
and protocol timeout close the private child process group. Idle sessions expire
after 30 minutes; the listener allows 128 connections and 16 queued requests per
connection. A timed-out or cancelled call may have acted and is never replayed.

## Installation selection

The tool provider is the operator's desktop installation, independent of Bot and
Worker inference accounts. `STACK_CODEX_TOOLS_HOME` selects its absolute Codex
home (default `~/.codex`). `STACK_CODEX_TOOLS_BIN` optionally selects an absolute
executable. Otherwise the bridge tries that home's standalone runtime, then the
ChatGPT and Codex application runtimes. Stack downloads no runtime, enables no
plugin, and copies no account credentials. The child runs from the selected
home using its configured plugins, not a Worker's project directory or inference
credential environment overrides.

Chrome resolves `browser-client.mjs` from installed `chrome` or `browser`
plugins, selects exactly one Chrome extension browser, and fails explicitly
when none or several are available. It does not fall back to another browser
family or Stack's managed Browser profiles. Messages and Computer History need
their respective desktop plugins; Computer History also needs recording enabled.

## Approvals

The bridge thread uses `on-request`. Upstream elicitations are sent to the MCP
client making the call, with request and response `_meta` preserved. URL
elicitations retain their mode. Codex's extended forms remain forms on the MCP
wire, preserving their schema. Unsupported clients, malformed answers and
client errors cancel the request. No permission is inferred from a timeout,
disconnect or missing handler. Bots' and Workers' own approval policies and
client support still determine whether a human can answer; this bridge does
not add a UI approval workflow.

## Consequences

The existing Roles switches express selection without a separate integration
category. Installation readiness is distinct from selection; explicit checks and
their cached observations are described in [ADR 0131](0131-codex-tools-availability.md). Changes
take effect in the server-served app after the normal authorized rebuild/restart;
existing Bot and Worker launches keep their connection snapshots.
