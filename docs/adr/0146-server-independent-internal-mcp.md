# 146. Separate internal MCP availability from the Server lifecycle

Status: accepted, 2026-09-30. Supersedes the live-socket-only internal MCP
discovery and execution rules in [ADR 0096](0096-explicit-transport-exposure.md)
and [ADR 0140](0140-internal-mcp-over-stdio.md), and the socket prerequisite for
Role injection in [ADR 0123](0123-role-injection-for-native-clis.md).
Preserves explicit exposure, caller authority, external HTTP and WebSocket
admission, and the sole durable Bot subscription owner.

## Decision

Internal stdio MCP children initialize and list their selected tools without a
running Server. Installed typed Package API declarations supply tool schemas
and event descriptions; the shared resolver applies the current manifest's
explicit operation and event selections and Worker disclosure. Listing a tool
does not establish that its live owner is available or grant caller authority.
Invalid declarations and selections fail closed, not as an empty catalog.

Execution prefers the running private socket owner. A Package API can explicitly
opt an operation into standalone execution using its shared owner implementation
without creating its full server context. A read-only hint is not this opt-in:
live reads may still need an owner, and ordinary server context construction may
start listeners, workers or maintenance tasks. Stdio children never start a
second Bot or Worker supervisor, scheduler, ingestion worker or subscription
database. Third-party Role MCP definitions retain their configured transports.

The typed operation's `standalone` context factory opens and closes only the
resources its existing handler needs, per call. The shared execution boundary
validates input and output and preserves the operation's MCP content projection.
Discovery publishes `standalone: boolean` on each operation; this is owner
capability, not observed service health or permission for every caller/transport.

The first supported reads are API documentation, Brain research retrieval
(`stats`, `search`, `context`, `get`, `tags`), Role catalog/snapshot/preview reads,
and Content document search, graph, Artifact metadata, collection/item metadata
and bounded item bytes/media. Private Role launch/editor reads keep their existing
transport exclusions. Other operations remain service-dependent by default.

Brain uses its existing structurally read-only retrieval path under Stack state;
it creates no index, ingestion worker, share ingress or token. Content requires
an existing Vault and coordinates derived-index reconciliation with an immediate
SQLite transaction spanning observation and update. It may rebuild this derived
index, but never commits/pushes Vault history during standalone reads. Artifact
and collection metadata open structurally read-only without migrations or
maintenance journals. Returned static paths are not proof of a running origin:
static links still require the Content/Access services.

`stack roles inject` captures a consistent snapshot from the existing local Role
store through a structurally read-only connection. It neither initializes nor
migrates that store. Missing or incompatible storage fails with explicit recovery
rather than inventing an empty Role. Default and named selection use the same
owner semantics and instruction renderer. Installed declarations replace the
Serve status dependency for internal MCP name and HTTP-alias collision checks.
Native capability isolation and native authentication remain independent.

## Failure and authority boundaries

Only definite pre-dispatch connection absence permits standalone fallback.
Timeout, cancellation, owner error and post-dispatch connection loss do not:
an operation may already have acted. Nothing automatically replays a mutation.
Dependency failures are MCP tool results with `isError: true`, an actionable code
and recovery, and truthful dispatch status. An unavailable service does not
terminate the stdio connection; subsequent calls can succeed when its owner starts.

`stack_service_unavailable` means a definite pre-dispatch absence;
`stack_service_connection_failed` means a connection failed without dispatch;
`stack_service_outcome_unknown` means the request was dispatched without a complete
answer. Diagnostics name the package, operation and prerequisite without echoing
arguments, credentials or native payloads. A received owner error remains that
owner's error, not an excuse for standalone fallback.

Managed Bot and Worker identities retain their signed launch proof and live
instance checks. A missing owner never turns managed authority into operator
authority or relaxes self-only Worker reads. Operator credentials remain
revocable. Exposure and authority are rechecked at execution boundaries.

Internal operator launch authority must survive routine Server startup to make
same-connection recovery real, while explicit local revocation must still fence
it. External operator bearer credentials and browser sessions retain their
startup rotation. A revoked stdio connection never silently reacquires authority.

The existing permission-checked LocalAuth database holds separate HTTP and stdio
operator secrets in one authority row. Opening legacy state adds the missing
stdio secret transactionally without rotating HTTP authority or capabilities.
`rotateForStartup()` changes only the HTTP secret and deletes browser capabilities
after the Server socket is claimed. Explicit `serve_local_revoke` uses `rotate()`
to change both secrets and delete capabilities. Audience-specific validation
prevents either bearer from authorizing the other transport. A fresh operator
launch after revocation is a new authorization; an existing pipe keeps its captured
credential and remains denied. This extends [ADR 0113](0113-authenticated-local-control.md).

Deployment must load the new Server revocation implementation before relying on
it to fence new stdio launches. A pre-change running owner knows only the HTTP
secret. Existing operator MCP sessions need an explicit relaunch to adopt the new
audience; no compatibility fallback or credential refresh is introduced.

Generated event tools continue to use the Server's sole durable subscription
owner and sanctioned Bot thread lineage. Offline discovery creates no watches;
an unavailable owner produces a useful error. Existing subscriptions still
deliver out of band through native Codex admission, independently of the pipe.

External HTTP and WebSocket gateways retain their live metadata validation and
existing admission policy. Offline internal discovery does not expand a remote
surface or make a stopped HTTP listener reachable.

## Verification boundary

Use process-level MCP clients, actual built stdio children and disposable Stack
state to establish offline discovery, real standalone reads, precise dependency
errors, and recovery on the same connection. Role injection checks use a seeded
existing store and disposable harness probes, without model turns or accounts.
Explicit exposure, managed authority, revocation, ambiguous dispatch and external
transport regressions remain independently verified at their owning boundaries.
