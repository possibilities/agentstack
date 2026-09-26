# Quickstart

AgentStack runs local Codex Bots and account-bound ACP Workers under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the sibling `~/code/codexnk` workshop checkout for setup. Setup installs the pinned GitHub release through that workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the required `api`, `auth`, `bots`, `roles`, and `workers` socket children and the WebSocket, Inspector, and UI canvas children. It serves `owner` status on its own socket and hosts the configured MCP Package APIs in the owner process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`. The MCP URLs default to `http://127.0.0.1:8743/mcp/{auth,bots,owner,roles,workers}`; set `AGENTSTACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations and owner-managed event subscription tools; socket and WebSocket event subscriptions remain separate.

The WebSocket child serves every configured Package API at `ws://127.0.0.1:8744/websocket/<name>` and forwards operations and event subscriptions to its socket Server. Set `AGENTSTACK_WEBSOCKET_PORT` to change the port; `0` allocates one and prints the startup URLs. The listener reads current `api.yaml` configuration when admitting a new connection, so newly enabled paths work without restarting it and disabled paths reject new connections. Existing connections continue until closed. A temporarily unreadable configuration rejects new connections as unavailable; configuration does not establish socket Server liveness. The live reference reflects the current configuration, while printed URLs are a startup snapshot. Send JSON frames `{ "id": 1, "method": "tools/list" }`, `{ "id": 2, "method": "tools/call", "params": { "name": "owner_status", "arguments": {} } }`, or `{ "id": 3, "method": "events/subscribe", "params": { "topics": ["pids_changed"] } }`. Responses echo `id` with `result` or `error`; subscribed connections receive `{ "method": "events/changed", "params": { "topic": "pids_changed" } }`. Scoped events also require `scope` in subscription params. Notices have no payload and are not replayed; snapshot state after subscribing and after each notice. If the upstream socket closes, the listener sends `events/disconnected`; resubscribe and snapshot again. The listener accepts local browser origins; set `AGENTSTACK_WEBSOCKET_ORIGIN` to pin a specific origin.

Bots receive private MCP URLs bound to their current launch. On the owner-managed MCP transport, event-bearing Package APIs also offer `events_catalog`, `events_subscribe`, `events_status`, and `events_unsubscribe`. An agent discovers a topic and read-only operation with `events_catalog`, subscribes from its Bot thread, and receives later refreshed values as Codex turns. See [operations](operations.md#agent-facing-event-subscriptions) for scope, coalescing, restart, and delivery behavior.

To create an account, call `account_login_start` with `{}` on the auth Package API (also available in Inspector), open the returned `authUrl` in a browser on the same machine, and enter the `userCode` at the provider. Poll `account_login_status` (or subscribe to `login_changed`) until the attempt completes. The result's `account` is its immutable ID; `account_list` returns IDs and the active choice. Use `account_login_replace` with an existing ID to sign in again. The first account becomes active; `account_activate` chooses the ID for newly created bots when available. A bot may also start unbound. Existing bots retain their main thread and account assignment across restarts; `bot_assign` changes the assignment without restarting the process. Sign-in does not alter the regular Codex CLI account.

For ACP Workers, call `worker_account_prepare` for Grok or Devin, run its returned native sign-in command, then call `worker_account_confirm`. A Codex Worker binds an existing Codex ID but needs a matching OpenCode sign-in. `worker_catalog({accountId})` lists account-bound model/effort choices. A Bot can call `worker_start` with that exact selection, an absolute Git repository root, a task, and a fresh `requestId`; the returned Worker retains its own Git worktree and ACP session. Read status and transcript while it works, then send a follow-up turn in the same session. See [operations](operations.md) for recovery and cleanup.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages, `docs_get` returns one package's document, and `docs_snapshot` returns one consistent catalog for a full reference. MCP and WebSocket URLs are included when their ports are fixed.

The browsable Package API reference is built into UIX. Open **API reference**
from anywhere on the bench, or follow a contextual operation link. Its searchable
reader uses `docs_snapshot` and exposes descriptions, full input/output schemas,
transports and scoped event subscriptions. The direct entry is
`http://127.0.0.1:8745/x/fleet?reference=overview` with the default UI port.
There is no separate docs listener, `agentstack docs` command or Markdown twin.

The owner also starts the standalone UI app at `http://127.0.0.1:8745/` and
prints this index URL.
Its root lists current local links, Package API URLs, owner processes, and
running bots; the live open bench is at `/x` (also `/x/fleet`). Spaces are
physical regions of one shared canvas, initially Fleet. System is a global
left dock; API reference and record inspection share the right dock. Space
navigation moves the camera, and window headers let you arrange the composition.
The owner
also prints the canvas URL. Set `AGENTSTACK_UIX_PORT` before starting to choose
another port. `pnpm build` prepares `packages/uix` for `agentstack serve`.
Both pages follow the system light/dark preference. The owner stops the app
on shutdown.

The owner starts the official MCP Inspector as a headless child and prints
`AgentStack Inspector: http://127.0.0.1:6274/`. Open that URL to see every
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
