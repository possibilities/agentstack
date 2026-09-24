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

The `auth` Package API adds an account through device sign-in (`account_login_start`, then `account_login_status` or `login_changed` events for its verification URL, one-time code, and result), makes an account active for new servers (`account_activate`), signs in again under the same name, or removes one (`account_remove`). The first successful sign-in becomes active. Removing an active account selects the oldest remaining account. Each Server retains its recorded account across restarts; a removed account prevents its restart rather than switching identity. Account names are monotonic even after removal. The login process has a ten-minute limit and does not modify ordinary Codex or AgentUsage storage. New app servers require an active account. codexnk receives an ephemeral credential input, an initially empty AgentStack capabilities directory, and `<state>/history` for its session records.

Each managed Server has a private `<state>/runtime/<id>` temporary root. codexnk creates its own runtime home beneath it. AgentStack watches that home's `auth.json` for a completed refresh and also reconciles it before another launch, after the Server exits, and after owner recovery. Only a valid, strictly later `last_refresh` from the Server's recorded credential generation can replace SQLite credentials. If either timestamp is missing, freshness cannot be established and the database is not overwritten. A missing or partial file is retried; ambiguous or conflicting runtime state remains private for diagnosis instead of replacing a newer database value. Several simultaneous Servers for one account can still race to refresh at the provider; this is best effort. Sign in again under the same account name when the saved token is exhausted or conflicting.

The owner starts its required `api`, `auth`, `codex`, and `bots` children in separate process groups and serves the `owner` Package API on its own socket before they spawn. If a child fails or exits, the owner reports the failure and shuts down. Normal shutdown stops incoming socket calls, waits for in-flight calls, closes event subscriptions, then gracefully stops app servers. The owner signals its process groups with SIGTERM and escalates to SIGKILL after a bounded grace period. It does not restart failed children automatically.

`agentstack docs` is an optional read-only browser reference, independent of the owner lifecycle. It binds only to `127.0.0.1`, prints its selected URL, and reads `docs_list` and `docs_get` from the `api` socket on each page load. An unavailable discovery socket produces a retryable unavailable page. It does not call the other Package APIs or expose their control operations over HTTP.

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
