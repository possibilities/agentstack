# Operations

## Build and verification

`scripts/install.sh --install` installs the exact codexnk release dependency,
builds AgentStack, and links its editable command. The release installer requires
GitHub CLI access to `possibilities/codexnk-codex`; it verifies the pinned tag,
commit and asset checksum. The installed runtime is shared with AgentStart,
whose consumer pin must stay aligned. Vendor Codex remains untouched.

`pnpm test` rebuilds each package before running compiled tests. `pnpm build` builds all packages. Package builds remove only their own `dist` directory, so deleted compiled files cannot survive a build.

## State and processes

State defaults to `~/.local/state/agentstack`. Set `AGENTSTACK_STATE_DIR` to use another location. Each Package API owns `<state>/sockets/<name>.sock` (`api`, `auth`, `codex`, `bots`, and `owner` under `agentstack serve`); Codex app servers use a fresh opaque `<state>/app/<nonce>.sock` path on each launch. Use the running Server's reported URL rather than deriving a path from its ID. Configuration, account IDs, active choice and server records are in `<state>/configuration.sqlite`; Codex credentials are in `<state>/secrets.sqlite`. Existing `<state>/servers/*.json` records are imported once and removed after successful import. App-server output lives under `<state>/logs/<id>.log`. These directories are private to the local user; sockets and databases use mode `0600`.

The `auth` Package API creates an account through device sign-in (`account_login_start` with `{}`, then `account_login_status` or `login_changed` events for its verification URL, one-time code, and result), makes an ID active for new Servers (`account_activate`), signs in again under the same ID (`account_login_replace`), or removes one (`account_remove`). IDs are immutable UUIDs; a UI can number the current accounts densely without changing Server bindings. The first successful sign-in becomes active. Removing an account fences new launches, stops and deletes Servers assigned to or last launched with it (including bot workspaces), deletes its credentials, then selects the oldest remaining account if necessary. This includes Servers pending a restart under another account. A failed removal remains marked for retry under the same ID. New Server history is isolated per Server so it can be removed with it; ambiguous older shared history remains untouched. The login process has a sixteen-minute limit and does not modify ordinary Codex or AgentUsage storage. A new app server may start without an active account. It still receives a private identity directory, an initially empty capabilities directory, and private history storage; the identity directory omits credentials until an account is bound. A new Server binds the active account when one exists. An existing Server changes account only through `server_assign` or `bot_assign`, which do not restart it. Stop it, then start it, before the new account is used. A running Server keeps its launched identity until then; `account` in its view is the assignment and `runningAccount` is the live identity. codexnk receives an ephemeral credential input only when an account is bound at launch.

Each managed Server has a private `<state>/runtime/<id>` temporary root. codexnk creates its own runtime home beneath it. AgentStack watches that home's `auth.json` for a completed refresh and also reconciles it before another launch, after the Server exits, and after owner recovery. Only a valid, strictly later `last_refresh` from the Server's recorded credential generation can replace SQLite credentials. If either timestamp is missing, freshness cannot be established and the database is not overwritten. A missing or partial file is retried; ambiguous or conflicting runtime state remains private for diagnosis instead of replacing a newer database value. Several simultaneous Servers for one account can still race to refresh at the provider; this is best effort. Sign in again under the same account ID when the saved token is exhausted or conflicting. When a stopped Server's runtime copy is definitively stale and the saved generation has advanced, its next launch moves that copy under `<state>/runtime-recovery/<id>/<uuid>` for diagnosis and uses the saved generation. Invalid or ambiguous copies still block the launch. Removing the Server removes its recovery copies.

The owner starts its required `api`, `auth`, `codex`, `bots`, WebSocket, Inspector, and UI canvas children in separate process groups and serves the `owner` Package API, docs, and MCP HTTP in-process. If a child fails or exits, the owner reports the failure and shuts down. Normal shutdown closes public ingress and the WebSocket, Inspector, and UI canvas children, drains in-flight calls, then stops `auth`, `bots`, `codex`, and `api` in dependency order. The Codex Server gracefully stops its app servers. Each child is signalled with SIGTERM and escalated to SIGKILL after a bounded grace period. The owner does not restart failed children automatically.

`agentstack serve` hosts the read-only browser reference at its printed
`http://127.0.0.1:<port>/docs` URL as part of the owner lifecycle. It binds
only to `127.0.0.1` and reads one `docs_snapshot` from the `api` socket
on each request. An unavailable discovery socket produces a retryable
unavailable page. The owner closes the listener on shutdown. The page also
serves a markdown twin at `index.md` (or with `.md` appended) with the same
live catalog and unavailable handling. The docs listener does not call
the other Package APIs or expose their control operations. The
optional `agentstack docs` command can still run the reference independently.
If `agentstack serve` is invoked again against a running owner, it reports that
owner's PID, docs URL, and UI canvas URL and exits without claiming sockets or starting
children. A fixed MCP port already in use is refused before startup, even if
the owner socket cannot be reached; an unrelated listener is never assumed to
be AgentStack.

The standalone Next.js UI app is served by an owned child on `127.0.0.1:8745`
by default. Its `/` index snapshots the owner and Codex Package APIs on each
request; `/x` is the experiment canvas, a live workbench that
snapshots every Package API over sockets, follows the loopback WebSocket
in the browser, and runs the auth API's operations — sign-in, activation,
and removal — from its Accounts window, inspector, and command palette.
Other Package APIs stay read-only there. Both pages serve markdown twins
(`/index.md`, `/x.md`). Set `AGENTSTACK_UIX_PORT` to
another available nonzero port before starting the owner. The canvas URL is
printed and returned by `owner_status` as `uixUrl`, alongside `indexUrl` and the
current docs, Inspector, and MCP URLs. The child serves the built `packages/uix/.next` output
and shuts down with the owner. Rebuild and restart the owner after changing the
app. A port already in use is refused before the owner creates any sockets.

The owner's MCP listener forwards tool calls to their socket Servers. Its
Inspector child reads a generated, read-only file under `<state>/inspector-*`;
the file is rewritten when configured MCP Package APIs change and removed on
shutdown. The Inspector binds to loopback on `AGENTSTACK_INSPECTOR_PORT` (6274
by default), keeps its own API token, and does not open a browser automatically.

When the Codex Package API starts, it reaps recorded child processes from a prior owner and launches every recorded Server again, including Bots and manually created Servers. A new Server starts with `mainThreadId: null`. Connect a UI to the Server's `url` (for example, `codex --remote unix://…` without `resume`); the first persistent root thread with a durable turn becomes its main thread. A blank TUI session does not bind it. Subsequent starts resume the stored ID, never substituting another thread after a failed resume. The Codex Package API checks the Server's private history after connecting and on thread changes, so a missed notice can be reconciled after restart. An explicit `server_stop` lasts until the next AgentStack startup. Old unconfirmed-start markers still block restart until their history is inspected.

`server_start` and `bot_start` retain caller-supplied Codex arguments for later launches. Omitting `args` reuses the saved array, while explicit `args: []` clears it. A running Server rejects different arguments; stop it before changing them without losing its main thread. The raw array is stored in `<state>/secrets.sqlite` and is not returned by `server_list` or `bot_list`. Existing records have no saved arguments and start with `[]` until reconfigured.

The owner supplies its bound MCP port to the Codex socket child, including when `AGENTSTACK_MCP_PORT=0`. On each Server launch, AgentStack discovers the currently MCP-configured Package APIs and gives Codex each owner's loopback URL under its Package API name; Bots use the same path. These launch-owned settings are not saved with caller arguments. A running Server retains its current connections until its next start, when newly configured Package APIs are picked up.

Starting a second Package API against the same state directory fails before it loads process records. An existing socket path is never removed during startup. If the previous process crashed and left `<state>/sockets/codex.sock`, first confirm that no Agentstack process is listening (`lsof -U | rg 'codex.sock'` and inspect the owning process). Remove **only that verified stale socket** and start again. Never remove a listening socket to force a second instance. On recovery, AgentStack checks both the recorded process command and the PID's exact listening endpoint before signalling it. If either cannot be verified while the PID remains alive, that Server stays fenced for inspection and other Servers continue. `server_list` and `bot_list` expose a nullable `recoveryIssue`; while set, the persisted `running` state is unverified and the canvas shows “Needs inspection” rather than a healthy process. The issue clears after a verified lifecycle transition. App-server socket paths are cleaned after their known child stops; startup never unlinks an existing app-server path. Inspect its owner and remove only a verified stale path before retrying a launch that reports one.

The `codex` Package API lists stopped records as well as running ones. A failed `server_start` may leave a stopped record for diagnosis; its child is terminated before the call returns an error. A log file can retain output across restarts of the same ID.

The required executable is always `~/.local/libexec/codexnk/codex`, regardless of
the owner's PATH. A missing runtime is an installation error, not a reason to
use another Codex. Existing records may retain a `codexBin` provenance field;
that field does not configure future launches. Reusing a live ID from another
runtime is refused until the operator stops it. Builds and setup leave running
processes untouched, so restart an old owner during an authorized maintenance
window to load the new runtime-selection code.
