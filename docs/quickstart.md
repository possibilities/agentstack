# Quickstart

Agentstack runs the local Codex Package APIs under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the sibling `~/code/codexnk` workshop checkout for setup. Setup installs the pinned GitHub release through that workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the required `api`, `auth`, `codex`, and `bots` socket children, serves `owner` status on its own socket, and hosts the configured MCP Package APIs in the owner process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`. The four MCP URLs default to `http://127.0.0.1:8743/mcp/{auth,bots,codex,owner}`; set `AGENTSTACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations only; socket change-event subscriptions remain on the sockets.

To sign in, call `account_login_start` on the auth socket, open the returned `authUrl` in a browser on the same machine, and enter the `userCode` at the provider. Poll `account_login_status` (or subscribe to `login_changed`) until the attempt completes. The first account becomes active; `account_activate` chooses the identity used by newly created app servers. Existing Servers retain their account and main thread when restarted, including after AgentStack restarts. Sign-in does not alter the regular Codex CLI account.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages and `docs_get` returns one package's document. The MCP URLs are included when the port is fixed.

`agentstack serve` also prints the loopback URL for its browsable reference,
`http://127.0.0.1:<port>/docs`. The page reads those two discovery operations
each time it loads, shows the four current Package APIs, MCP URLs, and socket
change events, and refreshes when the document changes. Set
`AGENTSTACK_DOCS_PORT` before starting to choose a port; otherwise an available
port is selected. The optional `agentstack docs` command still serves an
independent reference on a separate loopback port when needed.

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
