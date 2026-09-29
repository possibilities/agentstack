# Quickstart

Stack runs local Codex Bots and account-bound ACP Workers under one process server. It requires Node 24 or newer, pnpm 12.5.1, and the `~/workshops/codexnk` Workshop checkout for setup. Setup installs the pinned GitHub release through that Workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/cli/dist/src/main.js serve
```

`stack serve` starts the configured Package API socket children, including `signal`, `browse`, and `worker`, plus the shared WebSocket, Inspector, and UI canvas children. It serves `serve` status on its own socket and hosts the configured MCP Package APIs in the server process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`. Discover the MCP URLs with `serve_status` (loopback port 8743 by default); `signal` has no MCP transport. Set `STACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations and server-managed event subscription tools; socket and WebSocket event subscriptions remain separate.

`stack --help` discovers package CLI exports independently of Package APIs. A package can export `cli.ts` (a typed `PackageCli` default export with `run(args)` and a description), `cli.yaml` (description plus an `exec` argv array), or both (YAML description and TypeScript handler). For example, `stack roles snapshot` reads the public Role summary from its local socket; it needs the server running. The Serve namespace owns its operational subcommands, not the API transport layer.

In another terminal, run `stack serve open` for UI or `stack serve open inspector` for Inspector. The command opens a private, one-use bootstrap link without printing the secret. Sessions last eight hours and end on server restart or `stack serve revoke-local`. Bare UI URLs show connection instructions until authenticated. Anonymous MCP and WebSocket clients are refused. Native operator clients use `operatorHeaders(env)` from `@stack/api` as their HTTP/WebSocket headers; reload these after restart or revocation. Never copy credentials into URLs, logs or discovery. Bot/Worker launch URLs already carry signed identity.

Brain starts with an empty research index under `<state>/brain`. The Stack Chrome and Android clients pair through Access's authenticated tailnet ingress to share links and text. Brain's listener on loopback port `8877` is an internal backend. See [Brain and device sharing](brain.md) for storage, ingestion behavior and client configuration.

The WebSocket child serves all configured Package APIs on one connection at `ws://127.0.0.1:8744/websocket`, forwarding operations and independent event subscriptions to their socket Servers. Set `STACK_WEBSOCKET_PORT` to change the port; `0` allocates one and prints its URL. Each MCP/WebSocket declaration requires independent `operations` and `events` selections: `all`, a positive name list, or `[]`. The listener validates current `api.yaml` selections against every configured WebSocket package's live socket metadata when admitting a connection. Its package set and resolved operation/topic selections are fixed for that connection: reconnect to use changed selections. Invalid configuration or unavailable metadata rejects new connections; admission does not guarantee continued socket availability. Send JSON frames `{ "id": 1, "method": "tools/list", "params": { "package": "serve" } }`, `{ "id": 2, "method": "tools/call", "params": { "package": "serve", "name": "serve_status", "arguments": {} } }`, or `{ "id": 3, "method": "events/subscribe", "params": { "package": "serve", "subscription": "status", "topics": ["pids_changed"] } }`. Responses echo `id` with `result` or `error`; notices include `{ "method": "events/changed", "params": { "package": "serve", "subscription": "status", "topic": "pids_changed" } }`. Use a distinct subscription ID for each watch, replace a watch by repeating its ID, and remove it with `events/unsubscribe` using `{ "package": "serve", "subscription": "status" }`. Scoped events also require `scope`. Notices have no data and are not replayed; snapshot state after subscribing and after each notice. If an upstream subscription closes, `events/disconnected` identifies the affected package and subscription; resubscribe and snapshot again. The listener accepts local browser origins; set `STACK_WEBSOCKET_ORIGIN` to pin a specific origin.

Bots receive private MCP URLs bound to their current launch. On the server-managed MCP transport, Package APIs with selected event topics also offer `events_catalog`, `events_subscribe`, `events_status`, and `events_unsubscribe`. An agent discovers a selected topic and exposed read-only operation with `events_catalog`, subscribes from its Bot thread, and receives later refreshed values as Codex turns. See [operations](operations.md#agent-facing-event-subscriptions) for scope, coalescing, restart, and delivery behavior.

To create an account, call `account_login_start` with `{}` on the auth Package API (also available in Inspector). Poll `account_login_status` for its `authUrl` and `userCode`, open the link manually, and enter the code at the provider. Poll (or subscribe to `login_changed`) until the attempt completes. The result's `account` is its immutable ID; `account_list` returns accounts and enablement. Use `account_login_replace` with an existing ID to sign in again. `bot_start` requires an explicit enabled account ID. Existing Bots retain their main thread and assignment across restarts; `bot_assign` changes the assignment for the next start after a stop. Sign-in does not alter the regular Codex CLI account.

For Workers, prefer `worker_account_login_start` for Grok, Devin or Claude and follow its native sign-in state. Creating a Codex Bot account also creates its paired Codex Worker; pass that Worker's ID to sign it in separately with the same ChatGPT login. `worker_account_prepare` and `worker_account_confirm` provide a terminal fallback. `worker_catalog({accountId})` lists account-bound model/effort choices. A Bot can call `worker_start` with that exact selection, an absolute Git repository root, a task, and a fresh `requestId`; the returned Worker retains its own Git worktree and native session. Read status and transcript while it works, then send a follow-up turn in the same session. See [operations](operations.md) for recovery and cleanup.

HUD tracks shared nested work through `work_create`, `work_update`, `work_tree` and
its collaboration journal. A Bot can select `work_focus_set` for its verified Chat;
Worker starts inherit that focus. Explicit `workItemId` selects a different Work
item and null opts out. Follow-ups preserve the preceding turn's association unless
changed. Each admitted turn retains its observed scope revision. See the
[HUD API workflow](../packages/hud/README.md); its dedicated UI space is separate.

Browser control defaults to the exact UI origins `http://127.0.0.1:<STACK_UI_PORT>` and `http://localhost:<STACK_UI_PORT>` (port 8745 by default). For `next dev`, configure `STACK_WEBSOCKET_ORIGIN=http://localhost:3000` on the server before an authorized restart, use the same state directory for Next, then run `stack serve open ui http://localhost:3000`. This replaces the default browser-origin allowance. UI obtains a fresh single-use ticket for every WebSocket connection; Origin-less native clients instead supply their operator bearer header.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages, `docs_get` returns one package's document, and `docs_snapshot` returns one consistent catalog for a full reference. MCP and WebSocket URLs are included when their ports are fixed.

Discovery is also available over authenticated MCP. Worker-visible reads must be named in `mcp.workerOperations`; omission denies all, and the effective list is intersected with ordinary MCP exposure. Read-only annotations alone grant no access. The API reference displays this effective selection. Workers can read their own records and selected shared Role/Brain/Content data; sign-in state, Bot conversations, notifications and Proc output are excluded. Changing a selection applies to subsequent calls in existing native sessions. See [ADR 0114](adr/0114-explicit-worker-disclosure.md).

The browsable Package API reference is built into UI. Open **API reference**
from anywhere on the bench, or follow a contextual operation link. Its searchable
reader uses `docs_snapshot` and exposes descriptions, full input/output schemas,
transports and scoped event subscriptions. The direct entry is
`http://127.0.0.1:8745/?reference=overview` with the default UI port.
There is no separate docs listener, `stack docs` command or Markdown twin.

The server also starts the standalone UI app at `http://127.0.0.1:8745/` and
prints this UI entry URL. The root serves the live Fleet open bench; there is no
separate index page. System holds current local links, full Package API MCP URLs,
server processes, and host/resource sampling.
Fleet holds Bot accounts,
Worker accounts, Bots, Usage and Model catalogs, with explicit Bot lifecycle
controls and a discovery-driven Bot tools dialog. Spaces are
physical regions of one shared canvas, initially Fleet. API reference and record
inspection share the right dock. Space
navigation moves the camera, and window headers let you arrange the composition.
The server
also prints the canvas URL. Set `STACK_UI_PORT` before starting to choose
another port. `pnpm build` prepares `packages/ui` for `stack serve`.
The UI follows the system light/dark preference. The server stops the app
on shutdown.

The server starts the official MCP Inspector as a headless child and prints
`Stack Inspector: http://127.0.0.1:6274/`. Run `stack serve open inspector` to see every
Package API that configures MCP, select one, and connect in the Inspector. Set
`STACK_INSPECTOR_PORT` to choose another fixed port. Stack derives the
Inspector's read-only server list from `packages/*/api.yaml` and updates it when
the configuration changes; refreshing the Inspector reads the current list.
Tool listings come from the running socket Servers, so they reflect their
current operation definitions. The Inspector stays available without an open
browser tab, and the server stops it on shutdown.

To serve only the Bots Package API, without the process server:

```sh
node packages/api/dist/src/transport-main.js bots socket
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
