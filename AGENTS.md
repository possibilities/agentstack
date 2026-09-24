# AgentStack repository guidance

- Use the terms in [`CONTEXT.md`](CONTEXT.md) and the decisions in [`docs/adr/`](docs/adr/) when changing a Package API or Server lifecycle.
- A Package API declares its transports in `packages/<name>/api.yaml` and its typed operations and events in `packages/<name>/api.ts`. Shared socket, MCP, WebSocket, and discovery code lives in `packages/api/`; the process owner lives in `packages/owner/`.
- Keep operation schemas, descriptions, and package exports in sync. The live reference uses `docs_snapshot`; update its tests when the discovery contract changes.
- `pnpm test` builds the packages and runs their compiled tests. Use a disposable `AGENTSTACK_STATE_DIR` for lifecycle checks; never claim or remove a live owner's socket to make a test pass.
- `scripts/install.sh --check` prints the installation plan. `--install` installs the pinned codexnk runtime, builds, and links the command; neither command restarts a running owner.
