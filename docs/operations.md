# Operations

## Build and verification

`scripts/install.sh --install` installs the exact codexnk release dependency,
builds AgentStack, and links its editable command. The release installer requires
GitHub CLI access to `possibilities/codexnk-codex`; it verifies the pinned tag,
commit and asset checksum. The installed runtime is shared with AgentStart,
whose consumer pin must stay aligned. Vendor Codex remains untouched.

`pnpm test` rebuilds each package before running compiled tests. `pnpm build` builds all packages. Package builds remove only their own `dist` directory, so deleted compiled files cannot survive a build.

## State and processes

State defaults to `~/.local/state/agentstack`. Set `AGENTSTACK_STATE_DIR` to use another location. Each Package API owns `<state>/sockets/<name>.sock` (`api`, `auth`, `codex`, `bots`, and `owner` under `agentstack serve`); Codex app servers use `<state>/app/<id>.sock`. Configuration, account names, active choice and server records are in `<state>/configuration.sqlite`; Codex credentials are in `<state>/secrets.sqlite`. Existing `<state>/servers/*.json` records are imported once and removed after successful import. App-server output lives under `<state>/logs/<id>.log`. These directories are private to the local user; sockets and databases use mode `0600`.

The `auth` Package API creates an account through device sign-in (`account_login_start` with `{}`, then `account_login_status` or `login_changed` events for its verification URL, one-time code, and result), makes an ID active for new Servers (`account_activate`), signs in again under the same ID (`account_login_replace`), or removes one (`account_remove`). IDs are immutable UUIDs; a UI can number the current accounts densely without changing Server bindings. The first successful sign-in becomes active. Removing an account fences new launches, stops and deletes its bound Servers (including bot workspaces), deletes its credentials, then selects the oldest remaining account if necessary. A failed removal remains marked for retry under the same ID. New Server history is isolated per Server so it can be removed with it; ambiguous older shared history remains untouched. The login process has a sixteen-minute limit and does not modify ordinary Codex or AgentUsage storage. New app servers require an active account. codexnk receives an ephemeral credential input, an initially empty AgentStack capabilities directory, and private history storage for its session records.

Each managed Server has a private `<state>/runtime/<id>` temporary root. codexnk creates its own runtime home beneath it. AgentStack watches that home's `auth.json` for a completed refresh and also reconciles it before another launch, after the Server exits, and after owner recovery. Only a valid, strictly later `last_refresh` from the Server's recorded credential generation can replace SQLite credentials. If either timestamp is missing, freshness cannot be established and the database is not overwritten. A missing or partial file is retried; ambiguous or conflicting runtime state remains private for diagnosis instead of replacing a newer database value. Several simultaneous Servers for one account can still race to refresh at the provider; this is best effort. Sign in again under the same account ID when the saved token is exhausted or conflicting. When a stopped Server's runtime copy is definitively stale and the saved generation has advanced, its next launch moves that copy under `<state>/runtime-recovery/<id>/<uuid>` for diagnosis and uses the saved generation. Invalid or ambiguous copies still block the launch. Removing the Server removes its recovery copies.

The owner starts its required `api`, `auth`, `codex`, `bots`, WebSocket, and Inspector children in separate process groups and serves the `owner` Package API, docs, and MCP HTTP in-process. If a child fails or exits, the owner reports the failure and shuts down. Normal shutdown closes public ingress and the WebSocket and Inspector children, drains in-flight calls, then stops `auth`, `bots`, `codex`, and `api` in dependency order. The Codex Server gracefully stops its app servers. Each child is signalled with SIGTERM and escalated to SIGKILL after a bounded grace period. The owner does not restart failed children automatically.

`agentstack serve` hosts the read-only browser reference at its printed
`http://127.0.0.1:<port>/docs` URL as part of the owner lifecycle. It binds
only to `127.0.0.1` and reads `docs_list` and `docs_get` from the `api` socket
on each page load. An unavailable discovery socket produces a retryable
unavailable page. The owner closes the listener on shutdown. The docs listener does not call
the other Package APIs or expose their control operations. The
optional `agentstack docs` command can still run the reference independently.
If `agentstack serve` is invoked again against a running owner, it reports that
owner's PID and docs URL and exits without claiming sockets or starting
children. A fixed MCP port already in use is refused before startup, even if
the owner socket cannot be reached; an unrelated listener is never assumed to
be AgentStack.

The owner's MCP listener forwards tool calls to their socket Servers. Its
Inspector child reads a generated, read-only file under `<state>/inspector-*`;
the file is rewritten when configured MCP Package APIs change and removed on
shutdown. The Inspector binds to loopback on `AGENTSTACK_INSPECTOR_PORT` (6274
by default), keeps its own API token, and does not open a browser automatically.

When the Codex Package API starts, it reaps recorded child processes from a prior owner and launches every recorded Server again, including Bots and manually created Servers. Each Server creates one main thread on its first successful launch and resumes that stored thread ID later. An explicit `server_stop` lasts until the next AgentStack startup. If the first `thread/start` has an uncertain result, that Server remains stopped with an unconfirmed-start error instead of creating another thread. Inspect its Codex history before recovering that binding; other Servers continue starting.

Starting a second Package API against the same state directory fails before it loads process records. An existing socket path is never removed during startup. If the previous process crashed and left `<state>/sockets/codex.sock`, first confirm that no Agentstack process is listening (`lsof -U | rg 'codex.sock'` and inspect the owning process). Remove **only that verified stale socket** and start again. Never remove a listening socket to force a second instance. App server socket paths are cleaned after their exact child stops; startup also clears a non-listening app server socket for the requested ID.

The `codex` Package API lists stopped records as well as running ones. A failed `server_start` may leave a stopped record for diagnosis; its child is terminated before the call returns an error. A log file can retain output across restarts of the same ID.

The required executable is always `~/.local/libexec/codexnk/codex`, regardless of
the owner's PATH. A missing runtime is an installation error, not a reason to
use another Codex. Existing records may retain a `codexBin` provenance field;
that field does not configure future launches. Reusing a live ID from another
runtime is refused until the operator stops it. Builds and setup leave running
processes untouched, so restart an old owner during an authorized maintenance
window to load the new runtime-selection code.
