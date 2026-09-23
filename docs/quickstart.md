# Quickstart

Agentstack runs the local Codex Package API and package UIs under one process owner. It requires Node 24 or newer, pnpm 12.5.1, and a `codex` executable on `PATH` when starting a Codex app server.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
node packages/owner/dist/src/cli.js serve
```

The last command prints admission URLs for the owner, Codex, and API pages. Open one of those exact URLs in a browser on the same machine. The first request exchanges its token in the address for an HttpOnly cookie and redirects to a clean URL. The UI defaults to `127.0.0.1:3000`; set `PORT=0` to let the operating system choose a free port or set `PORT` to another local port.

To serve only the Codex Package API, without the UI or process owner:

```sh
node packages/api/dist/src/cli.js codex socket
```

The command prints its Unix socket path. The two commands use the same state directory and cannot own the Codex socket at the same time. Stop either command with Ctrl-C and wait for it to exit before starting another instance.

See [operations](operations.md) for state, shutdown, and recovery, and [security](security.md) for the local trust boundary.
