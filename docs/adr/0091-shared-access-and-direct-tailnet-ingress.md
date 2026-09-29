# 91. Shared Access authority and direct tailnet ingress

Status: accepted, 2026-09-27. Extends [ADR 0078](0078-declared-http-surfaces-and-operation-selection.md); supersedes the unauthenticated remote exposure in [ADR 0077](0077-content-collections.md) and Brain's shared device token in [ADR 0059](0059-isolated-brain-and-platform-clients.md). Preserves [ADR 0039](0039-worker-wakeups-and-scoped-mcp.md)'s private Bot/Worker invocation context and [ADR 0088](0088-isolated-space-benches.md)'s System bench.

## Decision

`access` is the owner-managed authority for durable clients, pairing requests,
grants, credential generations, admission receipts and audit. Same-user socket
and loopback WebSocket control can approve and revoke. The explicitly authorized
Access window lives in System. Access is not exposed on internal MCP.

Device pairing and every device data request use a dedicated TLS listener bound
to a Tailscale address. The listener checks kernel TCP source and destination,
then the local Tailscale CLI's running/self-address evidence and `whois --json
--proto=tcp` for that source on every request. No proxy header, DNS suffix,
configured listener name, Serve configuration, or public-cloud claim supplies
provenance. Serve/Funnel forwarding fails closed. The listener remains disabled
until the operator supplies a direct tailnet bind and TLS certificate/key. Setup
never changes Tailscale configuration. Brain and Content backends refuse remote
binds. Brain's backend-only liveness token is ephemeral and cannot be revealed.

Pairing is client-initiated, expires after ten minutes and requires a matching
human approval code on trusted local control. A separate 256-bit redemption
secret is generated and durably retained by the client before admission; the
server echoes it in the initial receipt and stores only its hash. This permits
safe retries after a lost initial response without retaining plaintext secrets
server-side. The approval code alone can never redeem. Approval, denial,
redemption and rotation are transactional. Identical redemption retries return
the same credential until pairing expiry or the first refresh rotation.

Credentials expire after 30 days and are individually revocable. Five-minute
opaque access tokens have an explicit Brain or Content audience. Refresh rotates
on every exchange. The client persists its refresh request ID before sending;
the exact retry deterministically recovers the same result for five minutes,
unless a later generation supersedes it. Unknown, expired or superseded recovery
requires re-pairing; clients never guess another request ID. No server secret
store contains raw redemption, refresh, access, handoff or session tokens.
Client, grant or credential revocation fences all dependent tokens and sessions
on their next request. An already admitted Brain job is not cancelled.

Each installation has a durable UUID `serverId`. Pairing receipts introduce it;
redemption, refresh and authenticated API requests must supply the expected
`X-Stack-Server-ID` before any admission. `/v1/access/me` authenticates a
Brain-audience token without a data permission and reports current scopes and
credential identity. Disconnect likewise requires no data scope. Browser
navigation uses server-bound handoffs and resource cookies instead of a custom
header. Pairing approvals can select a subset of requested scopes; revisioned
grant updates apply immediately to existing tokens and Content sessions.

Brain scopes are `brain:share` and `brain:status`; `content:read` is independent.
Every successful remote admission records a client/job receipt, including a
duplicate job admitted by another client. Status filters through those receipts.
A share's client field is set from its authenticated, locally approved kind:
Chrome maps to `chrome-extension`, Android to `android-share`; browser-kind
clients cannot submit shares. Device-supplied payload labels confer no authority.
A lost acknowledgement is retried through the existing admission deduplication
boundary. Outboxes and observed job IDs remain bound to their original server.

Content keeps separate document/artifact ports. Broad credentials travel only
in Authorization headers. Browser handoffs are one-use, expire after 60 seconds,
and cover one document, item, or immutable artifact version. A fragment handoff
is removed before exchange. Documents use a Secure HttpOnly resource cookie;
artifacts use a resource-scoped `/view/<credential>/...` path so relative assets
load without cookies from an opaque sandbox. Both last 15 minutes, and issuance
and every subsequent asset request require tailnet and current grant checks.
The view URL is narrow bearer authority and must not be logged; no pairing,
refresh or general access credential enters a URL. Real Chromium verification
demonstrated that SameSite cookies alone broke sandboxed bundle assets.
Remote artifact responses use an opaque-origin CSP sandbox with scripts allowed
but fetch, workers, frames and forms denied. This deliberately gives up artifact
same-origin fetch/storage to prevent scripts reading other authenticated content
on the shared artifact origin. No broad browser cookie is issued. Responses are
`no-store`; content downloaded by an authorized client cannot be recalled.

Public-cloud grants have a distinct network policy and an explicit positive
operation selection. They issue no credentials yet. Hosted-connector OAuth and
a separately authenticated remote MCP transport are deferred; no route forwards
to the internal MCP listener or accepts caller-supplied Bot/Worker identity.
Trusted-local `grant_evaluate_operation` is the reusable policy evaluator, not
authentication: callers must independently authenticate the grant and verify
network provenance before using its decision.

## Consequences

Chrome and Android use one Stack connection for Brain and Content. Existing
shared-token clients must re-pair. A different ingress URL does not silently
retarget old outboxes. An operator must drain those entries before migration or
explicitly reconcile them; the migration never sends held content elsewhere.
Direct TLS provisioning and a working local Tailscale CLI are operational
requirements. Public-cloud use, QR pairing, device-node pinning, and richer
Content navigation remain separate work. See [the Access runbook](../access.md).
