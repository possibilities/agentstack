# 159. Receive GitHub webhooks durably and expose filtered watch inboxes

Status: accepted, 2026-10-01. Extends [ADR 0033](0033-agent-facing-event-subscriptions.md),
[ADR 0078](0078-declared-http-surfaces-and-operation-selection.md) and
[ADR 0096](0096-explicit-transport-exposure.md). Preserves
[ADR 0120](0120-codex-native-input-admission.md)'s native admission boundary and
[ADR 0146](0146-server-independent-internal-mcp.md)'s sole subscription owner.

## Decision

`packages/source` is a Server-supervised Package API process, not an agent-side
poller or another Bot wakeup service. Its separate loopback HTTP surface receives
GitHub webhook POSTs at `/github/webhooks/{endpointId}`. Socket is the local
superset; MCP selects agent discovery, delivery reads and watches; WebSocket
declares the local UI-ready control contract. Receiver/credential/remote-hook and
maintenance operations require local operator authority and remain absent from
MCP and remote UI admission. Workers gain no GitHub MCP operations.

Each receiver has an immutable repository, organization, enterprise, App,
Marketplace or Sponsors target and a unique generated secret. HMAC-SHA256 verifies the original bytes before
JSON/form interpretation. Unknown future event/action names and new payload
fields remain accepted. Receiver-specific targeting is checked where the target
is represented in the authenticated body; pings and App-wide events need no
repository. Signed target IDs observed on admission bind later target checks and
survive repository/organization renames; watch repository-ID filters remain
stable across such changes. The signature does not authenticate routing headers, whose values
remain observed metadata rather than authority.

The package pins the official `@octokit/openapi-webhooks` specification instead
of the obsolete hand-crafted Octokit webhook schema project. Discovery provides
every event/action, supported hook types, permission guidance and chunked bundles
of all reachable payload-schema components for Cloud and supported GHES versions.
It is an explanatory catalog, not a strict intake validator. A catalog version
does not establish live availability under one installation's permissions.

## Retention and consumption

Private SQLite under `<STACK_STATE_DIR>/github` commits the original request,
compact summary, receipt/digest, receiver evidence and matching inbox entries
before returning HTTP 202. Identity is receiver plus delivery GUID. Identical
redelivery returns the same local sequence; conflicting bytes/routing for that
identity fail. Arrival sequence is not upstream causal order. Retained payload
admission has a 10,000-body and configurable byte bound (default 512 MiB); full
storage refuses intake rather than silently dropping history.

Watches declare ANDed routing selections and JSON Pointer predicates, with ORed
values in each selection. Filters are immutable. `start: "now"` starts at the
current cursor; a numeric start explicitly backfills retained matching arrivals.
Matching is frozen on admission, including while a watch's notifications pause.
Read snapshots return oldest pending summaries, a pending count and cursors.
Later arrivals change the snapshot even when its oldest page is unchanged, so
Stack's coalescing/deduplication cannot hide the existence of a backlog.

`github_watches_changed` can select exact `watch:<uuid>` scopes. Agents attach
Stack's existing `events_subscribe` to `github_watch_read`; the shared owner
resubscribes and resnapshots on interruption. No new input queue, independent
subscription database, turn polling or webhook-triggered command execution is
introduced. Agent processing and native admission never acknowledge the inbox.
Explicit compare-and-set consumption is shared-watch coordination, not a promise
of exactly-once agent side effects.

Exact owner-maintenance plans clear original bytes atomically with receipts but
retain identities/digests, compact summaries and watch matches. They neither
acknowledge pending entries nor permit redelivery to recreate removed content.
Payload predicates cannot evaluate cleared bytes during a new query/backfill;
existing watch matches remain inspectable. SQLite logical removal is not secure
erasure. Retained metadata is disclosed, not automatically evicted.

## Setup and remote effects

Public reachability requires an explicit operator-managed HTTPS proxy of only the
webhook path. GitHub Cloud cannot reach a tailnet-only origin; Access credentials
are not webhook credentials. The package starts no tunnel, changes no network
policy and imports no archived state or credentials. Request concurrency, body
memory, 25 MiB body size and listener deadlines are bounded. The shared API HTTP
listener owns listening and shutdown; GitHub owns route policy and signature
verification. Shutdown refuses admission and drains handlers before closing state.
The shared installation-reset fence also blocks webhook intake and native calls;
GitHub's owned state directory participates in the stopped installation reset
defined by [ADR 0158](0158-installation-factory-reset.md).
Upstream GitHub hooks remain retained external configuration; installation reset
does not delete/disable them or reconstruct old receivers and secrets.

Local setup reads expose exact settings links, prerequisites, steps, capability
limits, signed-arrival evidence and failure counters. Native `gh` supplies existing
authentication without bringing tokens into records or the UI. Repository and
organization automation observes a complete bounded hook inventory, reviews an
exact URL-matching/previously managed create/update plan, then rechecks local and
remote revisions before mutation. Unrelated hooks are untouched. Current secrets
travel through stdin, not process arguments or logs. App, enterprise, Marketplace and Sponsors hook
configuration and GHES management remain manual; the API describes that limit
instead of pretending every hook type offers identical administration APIs.

Remote mutation receipts fence request IDs and consume plans before dispatch.
Success, definite refusal and unknown outcome are distinct. Same-ID retries return
the receipt; unknown or interrupted actions never automatically replay. Explicit
ping, test and redelivery report GitHub admission, not signed local arrival.
Upstream attempt reads correlate GUIDs with the local ledger. GitHub does not
automatically redeliver failures and may omit payloads exceeding its size limit;
neither the ledger nor the catalog can claim missing upstream history.

## UI boundary and verification

This is API-only delivery. Existing generic reference/inspection and System child
discovery continue to work; central UI record types and remote-admission fences
stay truthful. New setup, receiver, delivery and watch views require a separate
UI-team change. Handoff material belongs outside the repository; this ADR is the
maintained architecture contract, not a transient assignment.

Owner-boundary checks use real private sockets and HTTP requests with disposable
Stack state, the actual shared MCP subscription owner, process-boundary `gh`
fixtures and restart/cleanup evidence. Discovery and Server lifecycle checks
verify the new process, schemas and exposure without publishing a tunnel,
changing real GitHub hooks or restarting the human's live Server.
