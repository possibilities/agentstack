# Local trust boundary

Stack is designed for one trusted local user account. Its Package API and Codex app-server control sockets live in mode `0700` state directories and use mode `0600` sockets. Anyone who can act as that OS user or read its state directory can control these local processes. Do not place the state directory on a shared filesystem.

Bots launch with unrestricted filesystem/network access and no approval prompts by default. A caller can explicitly narrow those settings through `bot_start.args`. The private workspace and state directories separate bot data, but they are not an operating-system sandbox around bot actions.

Codex account credentials and raw per-bot launch arguments live in `<state>/secrets.sqlite`, separate from account IDs and bot metadata in `<state>/configuration.sqlite`. Arguments may contain sensitive configuration values; `bot_list` does not return them. Both files are mode `0600`; they are not encrypted against the local user. Device sign-in uses a temporary private Codex home and an OAuth link surfaced through the `auth` socket. A new bot gets a short-lived private input copy of the chosen credentials, removed after readiness. codexnk's private runtime copy is retained under `<state>/runtime/<id>` until Stack reconciles any refresh into SQLite after exit. A conflicting or unreadable copy may be retained for diagnosis. Do not expose sign-in links, database files, or private runtime directories outside the trusted local user.

`<state>/roles.sqlite` is mode `0600` and holds role instructions, skill file bytes, and additional MCP definitions. `role_snapshot` and Role edit responses return MCP server summaries, omitting connection definitions. The socket-only `role_launch_snapshot` supplies complete definitions to native Worker launch; URLs, argv, environment values and HTTP headers can all contain secrets. Prefer environment variable references for credentials. Each Bot launch copies enabled role resources into a private directory under `<state>/roles/<id>/`; it never edits the user's Codex home or source project. A Worker snapshots that Role in private `<state>/workers/roles/<id>.json` and writes skill/rule copies only inside its newly claimed, self-ignored Git worktree. Codexnk still discovers other project or home skills independently, so strict skill exclusivity is not yet guaranteed for custom working directories or future ambient installations.

Worker credentials are isolated under private `<state>/worker-accounts/<id>/` profiles. Codex/Grok use OpenCode, Devin uses its native CLI, and Claude uses a private `CLAUDE_CONFIG_DIR` with an account-specific native credential store. Ambient provider credentials and routing overrides are removed from Claude's environment; AgentUsage accounts are not imported. Stack does not put credentials in Worker API output, Git worktrees, or the transcript. A Worker can run tools in its worktree under the same OS user and is not sandboxed by the worktree boundary. `<state>/workers.sqlite` keeps session and turn identity, bounded transcript text and pending permission options; it does not store Role MCP header values. A lost native response becomes an unknown outcome rather than an automatically retried task.

An enabled trusted-project Role entry permits the matching Bot launch to load that project's Codex config, not merely its MCP entries. It is an explicit local-user decision recorded by canonical path and never applied to an unrelated Bot cwd. Repository skills are intentionally available; the new codexnk carry excludes home-level skill and personal marketplace discovery when its three invocation axes are used, but that behavior is not in the currently installed runtime.

The package sockets own control operations. MCP requires an operator bearer credential or a signed, currently live Bot/Worker identity. Local WebSocket requires an operator bearer header for native Origin-less clients, or a one-use browser ticket bound to an authenticated UI session and exact Origin. Anonymous clients are refused. Host and Origin checks remain mandatory alongside authentication. Socket and WebSocket events deliver topic names only; server-managed MCP event tools separately re-read selected operations and deliver values into Bot turns. Read arguments and status persist in private `<state>/event-subscriptions.sqlite`, not values. Discovery exposes schemas, metadata and credential-free endpoints. Do not proxy the local listeners. See [ADR 0113](adr/0113-authenticated-local-control.md).

Internal stdio MCP environments given to a Bot include a per-launch HMAC proof from a private `<state>/mcp-bot-identity.key`. The gateway verifies the proof and that the Bot still owns the exact instance before forwarding a tool call, then carries each call's Codex `threadId` metadata through the private socket as invocation context. Bindings are private to launch snapshots, never returned by discovery. Missing, invalid or stale managed bindings fail closed without operator fallback. The proof distinguishes Bot connections from ordinary local callers; it does not authenticate mutually untrusted processes running as the same OS user. The serve-owned subscription relay independently verifies the binding and sanctioned lineage before granting a wakeup target.

Workers receive signed internal stdio MCP bindings bound to durable Worker ID and exact runtime instance. The gateway verifies live records before admission, listings, calls and returning operation results. Positive `mcp.workerOperations` selections default to deny and intersect ordinary MCP exposure; read-only hints cannot expand them. Current policy is checked before calls and before releasing results. Sign-in state, Bot conversations, notifications and Proc output are excluded. Worker handlers restrict self-reads to the exact live Worker, including siblings on the same account/Bot. Selected Brain/Content retrieval deliberately discloses shared corpus data. Bot-bound lifecycle calls retain their own sanctioned-thread checks. Unrestricted same-user processes and third-party Role MCP servers remain outside this Package API policy; see [ADR 0114](adr/0114-explicit-worker-disclosure.md). External HTTP MCP retains authenticated operator and legacy signed-URL support; internal stdio never forwards through HTTP.

These controls do not isolate mutually untrusted same-user processes. Other local accounts can reach TCP loopback, but reachability alone no longer grants operator authority. Browser cookies are host-scoped rather than port-scoped: hostile HTTP servers on the same hostname are outside this browser trust boundary. Do not use this as a shared-host service or forward its listeners. The private authority database is mode `0600` beneath a mode `0700` directory; bootstrap/session/ticket records store token digests. Server restart and `stack serve revoke-local` rotate the operator credential and invalidate local browser capabilities.

WebSocket browser Origins must match `http://127.0.0.1:<UI port>` or `http://localhost:<UI port>` exactly; `STACK_WEBSOCKET_ORIGIN` replaces these with one explicit origin. Origin-less native clients require the operator bearer header. UI and loopback HTTP listeners validate Host; the browser CDP relay and managed gate validate Host and browser upgrade Origin. These checks accompany control authentication.

Proc can run arbitrary local-user argv. Operator schedules may target full socket operations; Bot schedules retain their durable Bot/root/thread authority and require current MCP target exposure. Proc resolves the current live launch on dispatch, forwards explicit scheduled context, and preserves downstream operator-only and ownership guards. Stopped Bots hold their schedules; missing identities and changed roots block them. Operator edits cannot promote Bot authority. Existing unattributed schedules require explicit operator reauthorization. Bot-owned schedule, execution and process output reads are ownership-checked. Process execution is still same-user OS authority, not a sandbox, and a same-UID process can reach operator sockets directly. See [ADR 0110](adr/0110-proc-durable-caller-authority.md).

The owned MCP Inspector binds to loopback separately from the MCP transport.
Every response first requires a separate local browser session. Its API also requires a per-launch token, injected into that protected page;
the server suppresses its token-bearing startup banner and prints only the bare
local URL. Its generated server list is read-only in Inspector and lives in a
private, temporary directory under the state directory. The Inspector's
authenticated UI can initiate tool calls, so it shares the local-user trust
boundary described above.

The UI canvas remains a separate loopback-only Next.js listener and child process.
It reads the Package APIs over local WebSocket and operates account and voice
controls, and its Lab can start `infer` requests that spend a chosen Bot
account's Codex allowance. `infer` has a WebSocket but no MCP Transport, so it is
absent from the Bot's direct MCP tool surface ([ADR 0074](adr/0074-lab-inference-over-websocket.md)). This does not prevent access through local sockets, WebSocket or Proc. Its
request ledger, `<state>/infer/traces.sqlite` (mode `0600`), keeps each request's
instructions, input and output for every local caller of `infer_request_get`, but
never credentials ([ADR 0081](adr/0081-infer-request-ledger-api.md)). The UI
requires a session before serving private server-rendered data. `stack serve open` obtains its one-use bootstrap through the private server socket; anonymous HTTP endpoints cannot issue authority.
Access optionally supplies a third, distinct direct-tailnet TLS origin for
authenticated browser-kind clients ([ADR 0101](adr/0101-remote-uix-through-access.md)).
It verifies kernel peers and Tailscale evidence per HTTP request and WebSocket
upgrade, refuses forwarded identity, requires an exact Origin for unsafe requests
and upgrades, and admits short-lived HttpOnly cookie sessions only for an approved
browser-kind Access credential. The remote Next render has no trusted-local socket snapshot;
the Access-owned gateway intersects live WebSocket exposure with `ui:view` or
`ui:control`, closes on grant changes and revocation, and never exposes `access`,
`auth`, voice or headful browser controls remotely. Remote Artifact scripts run
on their own sandboxed origin without access to UI cookies or network calls.
This does not authorize forwarding the local UI, local WebSocket or MCP ports,
or publishing the Access listener through Serve/Funnel or a public proxy.

The Roles resource editor explicitly reads complete MCP definitions through `role_editor_snapshot`; its launch preview includes exact MCP configuration. These operator reads are available over WebSocket (including approved remote UI sessions) but excluded from MCP. Connection definitions load client-side rather than entering server-rendered HTML. Ordinary Role snapshots and mutation replies remain credential-safe summaries; see [ADR 0107](adr/0107-hardening-and-operator-ui-integration.md).

## Research and device sharing

Brain's research database and content-addressed bytes are private Stack state under `<state>/brain`. Its backend liveness credential is ephemeral and is not written to a token file. The package initializes empty storage; it does not discover or import an earlier research application's files or credentials. Research content may itself be sensitive, and ordinary search/retrieval intentionally returns that content to an authorized local caller. Job summaries redact content by default; explicit content inspection and operator dispositions retain their audit semantics.

Chrome and Android pair through Access's authenticated tailnet ingress. Brain's backend Share listener is loopback-only (8877 by default); non-loopback binding is refused, and legacy shared tokens are not imported. Access verifies remote provenance and client scopes, stamps share attribution and filters status reads through client-bound receipts. Its `share_receive` and `share_read_states` socket seams are excluded from MCP and WebSocket. Client settings, Share outboxes and Share history use Stack application namespaces.

QR enrollment adds one-use local invitations and explicit phone-sponsored device
induction ([ADR 0127](adr/0127-qr-device-enrollment.md)). Native sponsors need the
locally assigned `access:enroll` scope and a separate access-audience bearer.
They can grant only requested scopes they hold, never enrollment authority. The
target keeps its own secret and ephemeral signing key; request/receipt QRs contain no device credential.
An invitation QR **does** carry short-lived one-use authority and must be kept
private. Revocation or a sponsor grant change fences pending redemption; already
issued devices remain independently revocable with durable sponsor provenance.
The receipt return channel establishes the new device's initially unknown server
destination. All network calls still require direct-tailnet TLS; no public relay
or remote UI Access control is introduced.
Redemption additionally requires an Ed25519 proof bound to the actual server
origin, installation UUID, enrollment ID and request commitment. A substituted
return destination cannot harvest proof usable at the legitimate server.

URL extraction and source discovery remain delegated to Agentscrape. Admission is durable and offline; accepting a URL does not assert that it was fetched, indexed or permitted by the extractor's network policy. An unavailable extractor leaves inspectable ingestion state rather than silently dropping the accepted share.

Brain research defaults to public-only egress. Operator-only socket grants allow exact TCP IP/port destinations for one submission root or source definition version; shares and agents cannot supply authority. Scrape validates DNS answers and pins HTTP destinations on every redirect. Browser extraction uses a fresh disposable Browse guest with IPv4/IPv6 OUTPUT filtering installed before Chrome, covering subresources and direct UDP/QUIC/WebRTC bypass paths. Unavailable enforcement returns `network_policy:browser_egress_unverifiable`; unrestricted profiles are never a fallback. Revocation is rechecked on queued attempts, active engine work, cache reuse and fenced completion. Existing sources receive no private grants. See [ADR 0112](adr/0112-research-network-egress.md).
