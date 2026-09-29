# Quickstart

AgentStack runs local Codex Bots and account-bound ACP Workers under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the `~/workshops/codexnk` Workshop checkout for setup. Setup installs the pinned GitHub release through that Workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the configured Package API socket children, including `signal`, `browse`, and `worker`, plus the shared WebSocket, Inspector, and UI canvas children. It serves `owner` status on its own socket and hosts the configured MCP Package APIs in the owner process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`. Discover the MCP URLs with `owner_status` (loopback port 8743 by default); `signal` has no MCP transport. Set `AGENTSTACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations and owner-managed event subscription tools; socket and WebSocket event subscriptions remain separate.

In another terminal, run `agentstack open` for UIX or `agentstack open inspector` for Inspector. The command opens a private, one-use bootstrap link without printing the secret. Sessions last eight hours and end on owner restart or `agentstack revoke-local`. Bare UI URLs show connection instructions until authenticated. Anonymous MCP and WebSocket clients are refused. Native operator clients use `operatorHeaders(env)` from `@agentstack/api` as their HTTP/WebSocket headers; reload these after restart or revocation. Never copy credentials into URLs, logs or discovery. Bot/Worker launch URLs already carry signed identity.

Brain starts with an empty research index under `<state>/brain`. The AgentStack Chrome and Android clients pair through Access's authenticated tailnet ingress to share links and text. Brain's listener on loopback port `8877` is an internal backend. See [Brain and device sharing](brain.md) for storage, ingestion behavior and client configuration.

The WebSocket child serves all configured Package APIs on one connection at `ws://127.0.0.1:8744/websocket`, forwarding operations and independent event subscriptions to their socket Servers. Set `AGENTSTACK_WEBSOCKET_PORT` to change the port; `0` allocates one and prints its URL. Each MCP/WebSocket declaration requires independent `operations` and `events` selections: `all`, a positive name list, or `[]`. The listener validates current `api.yaml` selections against every configured WebSocket package's live socket metadata when admitting a connection. Its package set and resolved operation/topic selections are fixed for that connection: reconnect to use changed selections. Invalid configuration or unavailable metadata rejects new connections; admission does not guarantee continued socket availability. Send JSON frames `{ "id": 1, "method": "tools/list", "params": { "package": "owner" } }`, `{ "id": 2, "method": "tools/call", "params": { "package": "owner", "name": "owner_status", "arguments": {} } }`, or `{ "id": 3, "method": "events/subscribe", "params": { "package": "owner", "subscription": "status", "topics": ["pids_changed"] } }`. Responses echo `id` with `result` or `error`; notices include `{ "method": "events/changed", "params": { "package": "owner", "subscription": "status", "topic": "pids_changed" } }`. Use a distinct subscription ID for each watch, replace a watch by repeating its ID, and remove it with `events/unsubscribe` using `{ "package": "owner", "subscription": "status" }`. Scoped events also require `scope`. Notices have no data and are not replayed; snapshot state after subscribing and after each notice. If an upstream subscription closes, `events/disconnected` identifies the affected package and subscription; resubscribe and snapshot again. The listener accepts local browser origins; set `AGENTSTACK_WEBSOCKET_ORIGIN` to pin a specific origin.

Bots receive private MCP URLs bound to their current launch. On the owner-managed MCP transport, Package APIs with selected event topics also offer `events_catalog`, `events_subscribe`, `events_status`, and `events_unsubscribe`. An agent discovers a selected topic and exposed read-only operation with `events_catalog`, subscribes from its Bot thread, and receives later refreshed values as Codex turns. See [operations](operations.md#agent-facing-event-subscriptions) for scope, coalescing, restart, and delivery behavior.

To create an account, call `account_login_start` with `{}` on the auth Package API (also available in Inspector). Poll `account_login_status` for its `authUrl` and `userCode`, open the link manually, and enter the code at the provider. Poll (or subscribe to `login_changed`) until the attempt completes. The result's `account` is its immutable ID; `account_list` returns accounts and enablement. Use `account_login_replace` with an existing ID to sign in again. `bot_start` requires an explicit enabled account ID. Existing Bots retain their main thread and assignment across restarts; `bot_assign` changes the assignment for the next start after a stop. Sign-in does not alter the regular Codex CLI account.

For Workers, prefer `worker_account_login_start` for Grok, Devin or Claude and follow its native sign-in state. Creating a Codex Bot account also creates its paired Codex Worker; pass that Worker's ID to sign it in separately with the same ChatGPT login. `worker_account_prepare` and `worker_account_confirm` provide a terminal fallback. `worker_catalog({accountId})` lists account-bound model/effort choices. A Bot can call `worker_start` with that exact selection, an absolute Git repository root, a task, and a fresh `requestId`; the returned Worker retains its own Git worktree and native session. Read status and transcript while it works, then send a follow-up turn in the same session. See [operations](operations.md) for recovery and cleanup.

Browser control defaults to the exact UI origins `http://127.0.0.1:<AGENTSTACK_UIX_PORT>` and `http://localhost:<AGENTSTACK_UIX_PORT>` (port 8745 by default). For `next dev`, configure `AGENTSTACK_WEBSOCKET_ORIGIN=http://localhost:3000` on the owner before an authorized restart, use the same state directory for Next, then run `agentstack open uix http://localhost:3000`. This replaces the default browser-origin allowance. UIX obtains a fresh single-use ticket for every WebSocket connection; Origin-less native clients instead supply their operator bearer header.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages, `docs_get` returns one package's document, and `docs_snapshot` returns one consistent catalog for a full reference. MCP and WebSocket URLs are included when their ports are fixed.

Discovery is also available over authenticated MCP. Worker-visible reads must be named in `mcp.workerOperations`; omission denies all, and the effective list is intersected with ordinary MCP exposure. Read-only annotations alone grant no access. The API reference displays this effective selection. Workers can read their own records and selected shared Role/Brain/Content data; sign-in state, Bot conversations, notifications and Proc output are excluded. Changing a selection applies to subsequent calls in existing native sessions. See [ADR 0114](adr/0114-explicit-worker-disclosure.md).

The browsable Package API reference is built into UIX. Open **API reference**
from anywhere on the bench, or follow a contextual operation link. Its searchable
reader uses `docs_snapshot` and exposes descriptions, full input/output schemas,
transports and scoped event subscriptions. The direct entry is
`http://127.0.0.1:8745/x/fleet?reference=overview` with the default UI port.
There is no separate docs listener, `agentstack docs` command or Markdown twin.

The owner also starts the standalone UI app at `http://127.0.0.1:8745/` and
prints this UI entry URL. The root redirects to the live open bench at `/x`
(also `/x/fleet`); there is no separate index page. System holds current local
links, full Package API MCP URLs, owner processes, and host/resource sampling.
Fleet holds Bot accounts,
Worker accounts, Bots, Usage and Model catalogs, with explicit Bot lifecycle
controls and a discovery-driven Bot tools dialog. Spaces are
physical regions of one shared canvas, initially Fleet. API reference and record
inspection share the right dock. Space
navigation moves the camera, and window headers let you arrange the composition.
The owner
also prints the canvas URL. Set `AGENTSTACK_UIX_PORT` before starting to choose
another port. `pnpm build` prepares `packages/uix` for `agentstack serve`.
The UI follows the system light/dark preference. The owner stops the app
on shutdown.

The owner starts the official MCP Inspector as a headless child and prints
`AgentStack Inspector: http://127.0.0.1:6274/`. Run `agentstack open inspector` to see every
Package API that configures MCP, select one, and connect in the Inspector. Set
`AGENTSTACK_INSPECTOR_PORT` to choose another fixed port. AgentStack derives the
Inspector's read-only server list from `packages/*/api.yaml` and updates it when
the configuration changes; refreshing the Inspector reads the current list.
Tool listings come from the running socket Servers, so they reflect their
current operation definitions. The Inspector stays available without an open
browser tab, and the owner stops it on shutdown.

To serve only the Bots Package API, without the process owner:

```sh
node packages/api/dist/src/cli.js bots socket
```

The command prints its Unix socket path. The two commands use the same state directory and cannot own the bots socket at the same time. Stop either command with Ctrl-C and wait for it to exit before starting another instance.

See [operations](operations.md) for state, shutdown, and recovery, and [security](security.md) for the local trust boundary.

All bots use `~/.local/libexec/codexnk/codex`. Sign in to a Codex Bot account through `auth`, read `account_list`, then call `bot_start` with `{ "account": "<enabled Codex Bot account UUID>" }` to allocate the
next `bot-N` and a private workspace. It defaults to `sandbox_mode="danger-full-access"` and `approval_policy="never"`. Supply `id`, `cwd`, or `args` to override
those launch choices and narrow access with later `-c` settings; a supplied external directory remains yours. Executable selection
is not configurable. A new bot returns `mainThreadId: null`; connect a TUI
with `codex --remote <url>` to create its first thread and send a turn. Once
durable, that thread becomes `mainThreadId` and can be joined later with
`codex --remote <url> resume <mainThreadId>`.
`scripts/install.sh --check` prints the dependency pin and installation plan
without changes. Setup never starts or restarts services.
