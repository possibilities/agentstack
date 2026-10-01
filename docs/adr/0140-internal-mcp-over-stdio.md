# 140. Use native stdio for Stack-provided MCP connections

Status: accepted, 2026-09-30. Supersedes the internal HTTP launch choice in
[ADR 0032](0032-bot-mcp-invocation-context.md),
[ADR 0123](0123-role-injection-for-native-clis.md) and
[ADR 0129](0129-codex-tools-in-default-mcp-fleet.md). Preserves the exposure
policy in [ADR 0096](0096-explicit-transport-exposure.md) and subscription
delivery in [ADR 0120](0120-codex-native-input-admission.md).

[ADR 0146](0146-server-independent-internal-mcp.md) replaces the live-socket-only
internal discovery and execution policy below. Stdio transport, launch authority,
native bridge ownership and durable subscription delivery remain unchanged.

## Decision

Every Stack-provided MCP connection in Bot, Worker and `stack roles inject`
launches uses stdio: Package APIs and all five Codex bridges. The shared
`@stack/api` launch descriptor carries an absolute Node executable and entry
path, explicit Stack state and catalog roots, installation environment, and
private authority. It works independently of the native harness's working
directory, PATH, HOME and inference-account isolation. Third-party Role MCP
definitions keep their selected HTTP or stdio transport. Name and internal
HTTP-listener alias collision checks remain.

`stack serve mcp <name> --stdio` runs one protocol-only child with the generated
launch environment. Missing authority fails closed. `stack serve mcp` retains
the authenticated HTTP listener for external consumers, including Inspector.
Discovery's MCP URL is an external-consumer address; Role launch previews
report internal `transport: stdio` without disclosing launch credentials.

## Shared policy and owners

Package MCP handlers are independent of transport. Each listing and call reads
live private-socket metadata and current `api.yaml` exposure, including explicit
Worker disclosure, and checks authority before and after forwarding. Stdio
never proxies HTTP or instantiates Package API contexts. Backend operations
still execute once in their owning running package process. Results preserve
the MCP content, structured content, schemas and metadata; cancellation closes
the pending socket request without replaying an interrupted operation.

Bot and Worker stdio children receive the same signed launch proofs formerly
carried in HTTP queries, serialized into a private environment value. Explicit
authority distinguishes Bot, Worker and operator; an absent, invalid or stale
managed binding never becomes an operator connection. Every Bot tool call
requires its own Codex `_meta.threadId`; one pipe can serve multiple sanctioned
threads. Worker identity remains bound to its exact durable Worker and live
runtime, with self-only ownership enforced by the package. Operator Role
injection carries the revocable local operator credential and cannot subscribe
Bot threads.

The serve process remains the sole durable event-subscription owner. A narrow
`serve_mcp_event` private-socket operation independently verifies the signed
Bot launch, live instance and sanctioned thread, then invokes the same event
service as HTTP. It is absent from MCP and WebSocket exposure. Stdio children
open no subscription database. Closing a pipe leaves the durable watch intact;
changed snapshots still arrive out of band as standalone `toolOutput` through
Codex `turn/start`, returning on admission without waiting for idle or completion.

Each Codex bridge connection owns one lazy `CodexMcpSession`, including its
serialized REPL state and native approval context. Shared handlers preserve
media, `_meta`, form/URL elicitation and authority rechecks around approval.
EOF, termination signals, cancellation and timeouts reap the private native
process; interrupted calls are never replayed. Stdout contains MCP frames only,
and diagnostics use stderr. HTTP retains its stateful session limits and expiry.

## Verification boundary

Process-level SDK clients exercise handshake, catalog refresh, calls, signed
authority, media, cancellation, elicitation and EOF/signal cleanup with disposable
state and native protocol fixtures. No HTTP listener participates in stdio
checks. The owner relay test verifies durable delivery after the subscribing
pipe closes. Existing Codex delivery tests own sanctioned lineage and native
start-or-steer admission. Bot bundles, ACP sessions without HTTP capability,
Claude SDK options and all three Role injection configurations exercise native
stdio definitions; additional HTTP Role servers still require HTTP support.
No live account, Bot, GUI or desktop plugin is needed for these checks.
