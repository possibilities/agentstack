# Quickstart

Agentstack runs the local Codex Package APIs under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the sibling `~/code/codexnk` workshop checkout for setup. Setup installs the pinned GitHub release through that workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the required `api`, `auth`, `codex`, `bots`, MCP, and WebSocket children and serves `owner` status and `pids_changed` events on its own socket in-process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`; the serve output prints their paths. The MCP child serves the four configured Package APIs as Streamable HTTP tools on loopback at `http://127.0.0.1:8743/mcp/{auth,bots,codex,owner}`. Set `AGENTSTACK_MCP_PORT` to change the port. MCP exposes operations only.

The WebSocket child serves every Package API at `ws://127.0.0.1:8744/websocket/<name>` and forwards operations and event subscriptions to its socket Server. Set `AGENTSTACK_WEBSOCKET_PORT` to change the port; `0` allocates one and prints the URLs. Send JSON frames `{ "id": 1, "method": "tools/list" }`, `{ "id": 2, "method": "tools/call", "params": { "name": "owner_status", "arguments": {} } }`, or `{ "id": 3, "method": "events/subscribe", "params": { "topics": ["pids_changed"] } }`. Responses echo `id` with `result` or `error`; subscribed connections receive `{ "method": "events/changed", "params": { "topic": "pids_changed" } }`. Scoped events also require `scope` in subscription params. Notices have no payload and are not replayed; snapshot state after subscribing and after each notice. If the upstream socket closes, the listener sends `events/disconnected`; resubscribe and snapshot again. The listener accepts local browser origins; set `AGENTSTACK_WEBSOCKET_ORIGIN` to pin a specific origin.

To sign in, call `account_login_start` on the auth socket, open the returned `authUrl` in a browser on the same machine, and enter the `userCode` at the provider. Poll `account_login_status` (or subscribe to `login_changed`) until the attempt completes. The first account becomes active; `account_activate` chooses the identity used by newly created app servers. Existing Servers retain their account and main thread when restarted, including after AgentStack restarts. Sign-in does not alter the regular Codex CLI account.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages and `docs_get` returns one package's document. MCP and WebSocket URLs are included when their ports are fixed.

`agentstack serve` also prints the loopback URL for its browsable reference,
`http://127.0.0.1:<port>/docs`. The page reads those two discovery operations
each time it loads, shows the configured Package APIs, MCP and WebSocket URLs, and socket
change events, and refreshes when the document changes. Set
`AGENTSTACK_DOCS_PORT` before starting to choose a port; otherwise an available
port is selected. The optional `agentstack docs` command still serves an
independent reference on a separate loopback port when needed.

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
