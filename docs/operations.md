# Operations

## Build and verification

`scripts/install.sh --install` installs the exact codexnk release dependency,
builds AgentStack, and links its editable command. The release installer requires
GitHub CLI access to `possibilities/codexnk-codex`; it verifies the pinned tag,
commit and asset checksum. The installed runtime is shared with AgentStart,
whose consumer pin must stay aligned. Vendor Codex remains untouched.

`pnpm test` rebuilds each package before running compiled tests and checks the Next UI types. `pnpm build` builds all packages, then runs a Next production build and UI typecheck. Package builds remove only their own `dist` directory, so deleted compiled files cannot survive a build. The Next build uses `.next/build`; the UI integration test uses a separate temporary `.next/test-*` directory.

## State and processes

State defaults to `~/.local/state/agentstack`. Set `AGENTSTACK_STATE_DIR` to use another location. The Codex Package API owns `<state>/sockets/codex.sock`; its app servers use `<state>/app/<id>.sock`. Records are stored under `<state>/servers/` and app server output under `<state>/logs/<id>.log`. These directories are private to the local user and sockets use mode `0600`.

The owner starts its required Codex child in a separate process group. If the child fails or exits, the owner reports the failure and shuts down. Normal shutdown stops incoming socket calls, waits for in-flight calls, closes event subscriptions, then gracefully stops app servers. The owner signals its process groups with SIGTERM and escalates to SIGKILL after a bounded grace period. It does not restart failed children automatically.

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
