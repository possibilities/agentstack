# Quickstart

Agentstack runs the local Codex Package APIs under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the sibling `~/code/codexnk` workshop checkout for setup. Setup installs the pinned GitHub release through that workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the required `api`, `auth`, `codex`, and `bots` socket children and the WebSocket, Inspector, and UI canvas children. It serves `owner` status on its own socket and hosts the configured MCP Package APIs in the owner process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`. The four MCP URLs default to `http://127.0.0.1:8743/mcp/{auth,bots,codex,owner}`; set `AGENTSTACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations only; socket and WebSocket event subscriptions remain separate.

The WebSocket child serves every configured Package API at `ws://127.0.0.1:8744/websocket/<name>` and forwards operations and event subscriptions to its socket Server. Set `AGENTSTACK_WEBSOCKET_PORT` to change the port; `0` allocates one and prints the startup URLs. The listener reads current `api.yaml` configuration when admitting a new connection, so newly enabled paths work without restarting it and disabled paths reject new connections. Existing connections continue until closed. A temporarily unreadable configuration rejects new connections as unavailable; configuration does not establish socket Server liveness. The live reference reflects the current configuration, while printed URLs are a startup snapshot. Send JSON frames `{ "id": 1, "method": "tools/list" }`, `{ "id": 2, "method": "tools/call", "params": { "name": "owner_status", "arguments": {} } }`, or `{ "id": 3, "method": "events/subscribe", "params": { "topics": ["pids_changed"] } }`. Responses echo `id` with `result` or `error`; subscribed connections receive `{ "method": "events/changed", "params": { "topic": "pids_changed" } }`. Scoped events also require `scope` in subscription params. Notices have no payload and are not replayed; snapshot state after subscribing and after each notice. If the upstream socket closes, the listener sends `events/disconnected`; resubscribe and snapshot again. The listener accepts local browser origins; set `AGENTSTACK_WEBSOCKET_ORIGIN` to pin a specific origin.

To create an account, call `account_login_start` with `{}` on the auth Package API (also available in Inspector), open the returned `authUrl` in a browser on the same machine, and enter the `userCode` at the provider. Poll `account_login_status` (or subscribe to `login_changed`) until the attempt completes. The result's `account` is its immutable ID; `account_list` returns IDs and the active choice. Use `account_login_replace` with an existing ID to sign in again. The first account becomes active; `account_activate` chooses the ID used by newly created app servers. Existing Servers retain their bound ID and main thread when restarted, including after AgentStack restarts. Sign-in does not alter the regular Codex CLI account.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages and `docs_get` returns one package's document. MCP and WebSocket URLs are included when their ports are fixed.

`agentstack serve` also prints the loopback URL for its browsable reference,
`http://127.0.0.1:<port>/docs`. The page reads those two discovery operations
each time it loads, shows the configured Package APIs, MCP and WebSocket URLs, and socket
change events, and refreshes when the document changes. Set
`AGENTSTACK_DOCS_PORT` before starting to choose a port; otherwise an available
port is selected. The optional `agentstack docs` command still serves an
independent reference on a separate loopback port when needed. The page is
also served as markdown at `index.md` (or with `.md` appended to the page
URL).

The owner also starts the standalone UI app at `http://127.0.0.1:8745/` and
prints this index URL.
Its root lists current local links, Package API URLs, owner processes, and
running Codex Servers; the blank experiment canvas is at `/x`. Both pages
serve markdown twins at `/index.md` and `/x.md`. The owner
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

To serve only the Codex Package API, without the process owner:

```sh
node packages/api/dist/src/cli.js codex socket
```

The command prints its Unix socket path. The two commands use the same state directory and cannot own the Codex socket at the same time. Stop either command with Ctrl-C and wait for it to exit before starting another instance.

See [operations](operations.md) for state, shutdown, and recovery, and [security](security.md) for the local trust boundary.

All Codex app servers use `~/.local/libexec/codexnk/codex`. The `server_start`
request accepts `cwd`, optional `id`, and optional `args`; executable selection
is not configurable. `scripts/install.sh --check` prints the dependency pin and
installation plan without changes. Setup never starts or restarts services.
