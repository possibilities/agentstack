# Operations

## Build and verification

`scripts/install.sh --install` installs the exact codexnk release dependency,
builds AgentStack, and links its editable command. The release installer requires
GitHub CLI access to `possibilities/codexnk-codex`; it verifies the pinned tag,
commit and asset checksum. The installed runtime is shared with AgentStart,
whose consumer pin must stay aligned. Vendor Codex remains untouched.

The Codex UI header displays the installed codexnk release version from the
receipt beside the resolved runtime binary. It does not display the setup pin
or the binary's unbranded `codex-cli 0.0.0` string. Missing, unreadable or invalid
release metadata displays `codexnk version unavailable` without hiding the
server tree. The badge describes the installed runtime for new servers, not
the version retained by an already-running process.

`pnpm test` rebuilds each package before running compiled tests and checks the Next UI types. `pnpm build` builds all packages, then runs a Next production build and UI typecheck. Package builds remove only their own `dist` directory, so deleted compiled files cannot survive a build. The Next build uses `.next/build`; the UI integration test uses a separate temporary `.next/test-*` directory.

## State and processes

State defaults to `~/.local/state/agentstack`. Set `AGENTSTACK_STATE_DIR` to use another location. The Codex Package API owns `<state>/sockets/codex.sock`; its app servers use `<state>/app/<id>.sock`. Configuration, account names, active choice and server records are in `<state>/configuration.sqlite`; Codex credentials are in `<state>/secrets.sqlite`. Existing `<state>/servers/*.json` records are imported once and removed after successful import. App-server output lives under `<state>/logs/<id>.log`. These directories are private to the local user; sockets and databases use mode `0600`.

The Codex page can add an account via browser sign-in, make an account active for new servers, sign in again under the same name, or remove one. The first successful sign-in becomes active. Removing an active account selects the oldest remaining account. Each Server retains its recorded account across restarts; a removed account prevents its restart rather than switching identity. Account names are monotonic even after removal. The login process has a ten-minute limit and does not modify ordinary Codex or AgentUsage storage. New app servers require an active account. codexnk receives an ephemeral credential input, an initially empty AgentStack capabilities directory, and `<state>/history` for its session records.

Each managed Server has a private `<state>/runtime/<id>` temporary root. codexnk creates its own runtime home beneath it. AgentStack watches that home's `auth.json` for a completed refresh and also reconciles it before another launch, after the Server exits, and after owner recovery. Only a valid, strictly later `last_refresh` from the Server's recorded credential generation can replace SQLite credentials. If either timestamp is missing, freshness cannot be established and the database is not overwritten. A missing or partial file is retried; ambiguous or conflicting runtime state remains private for diagnosis instead of replacing a newer database value. Several simultaneous Servers for one account can still race to refresh at the provider; this is best effort. Use **Sign in again** when the saved token is exhausted or conflicting.

The owner starts its required Codex child in a separate process group. If the child fails or exits, the owner reports the failure and shuts down. Normal shutdown stops incoming socket calls, waits for in-flight calls, closes event subscriptions, then gracefully stops app servers. The owner signals its process groups with SIGTERM and escalates to SIGKILL after a bounded grace period. It does not restart failed children automatically.

When the Codex Package API starts, it reaps recorded child processes from a prior owner and launches every recorded Server again, including Bots and manually created Servers. Each Server creates one main thread on its first successful launch and resumes that stored thread ID later. An explicit `server_stop` lasts until the next AgentStack startup. If the first `thread/start` has an uncertain result, that Server remains stopped with an unconfirmed-start error instead of creating another thread. Inspect its Codex history before recovering that binding; other Servers continue starting.

Starting a second Codex Package API against the same state directory fails before it loads process records. An existing socket path is never removed during startup. If the previous process crashed and left `<state>/sockets/codex.sock`, first confirm that no Agentstack process is listening (`lsof -U | rg 'codex.sock'` and inspect the owning process). Remove **only that verified stale socket** and start again. Never remove a listening socket to force a second instance. App server socket paths are cleaned after their exact child stops; startup also clears a non-listening app server socket for the requested ID.

If the UI port is occupied, set `PORT=0` or another free port. If a Next development lock remains, confirm the old owner process has exited before removing its lock. The normal UI and test UI use separate Next output directories.

The `codex` Package API lists stopped records as well as running ones. A failed `server_start` may leave a stopped record for diagnosis; its child is terminated before the call returns an error. A log file can retain output across restarts of the same ID.

The required executable is always `~/.local/libexec/codexnk/codex`, regardless of
the owner's PATH. A missing runtime is an installation error, not a reason to
use another Codex. Existing records may retain a `codexBin` provenance field;
that field does not configure future launches. Reusing a live ID from another
runtime is refused until the operator stops it. Builds and setup leave running
processes untouched, so restart an old owner during an authorized maintenance
window to load the new runtime-selection code.
