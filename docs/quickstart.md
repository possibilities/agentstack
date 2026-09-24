# Quickstart

Agentstack runs the local Codex Package APIs under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and the sibling `~/code/codexnk` workshop checkout for setup. Setup installs the pinned GitHub release through that workshop's verified installer; no `codex` command on PATH is required.

From the repository root:

```sh
scripts/install.sh --install
pnpm test
node packages/owner/dist/src/cli.js serve
```

`agentstack serve` starts the required `api`, `auth`, `codex`, `bots`, and MCP children and serves `owner` status and `pids_changed` events on its own socket in-process. Each Package API is a line-delimited JSON socket under `<state>/sockets/<name>.sock`; the serve output prints their paths. The MCP child also serves the four configured Package APIs as Streamable HTTP tools on loopback at `http://127.0.0.1:8743/mcp/{auth,bots,codex,owner}`. Give an MCP inspector one of these URLs; no client connection is required for the process to run. Set `AGENTSTACK_MCP_PORT` before starting to change the port (or use `0` to allocate one and read the printed URLs). MCP exposes operations only; socket change-event subscriptions remain on the sockets.

To sign in, call `account_login_start` on the auth socket, open the returned `authUrl` in a browser on the same machine, and enter the `userCode` at the provider. Poll `account_login_status` (or subscribe to `login_changed`) until the attempt completes. The first account becomes active; `account_activate` chooses the identity used by newly created app servers. Existing Servers retain their account and main thread when restarted, including after AgentStack restarts. Sign-in does not alter the regular Codex CLI account.

Structured documents for every package API — operations with their JSON Schemas, event topics, and configured transports — come from the `api` socket: `docs_list` names the packages and `docs_get` returns one package's document. The MCP URLs are included when the port is fixed.

For a browsable reference, run `agentstack docs` in a second terminal while `agentstack serve` is running and open the printed loopback URL. The page reads those two discovery operations each time it loads, shows the four current package APIs, MCP URLs, and socket change events, and refreshes when the document changes. Set `AGENTSTACK_DOCS_PORT` to choose a port; otherwise an available port is selected.

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
