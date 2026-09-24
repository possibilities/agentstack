# AgentStack repository guidance

- Use the terms in [`CONTEXT.md`](CONTEXT.md) and the decisions in [`docs/adr/`](docs/adr/) when changing a Package API or Server lifecycle.
- A Package API declares its transports in `packages/<name>/api.yaml` and its typed operations and events in `packages/<name>/api.ts`. Shared socket, MCP, WebSocket, and discovery code lives in `packages/api/`; the process owner lives in `packages/owner/`.
- Keep operation schemas, descriptions, and package exports in sync. The live reference uses `docs_snapshot`; update its tests when the discovery contract changes.
- `pnpm test` builds the packages and runs their compiled tests. Use a disposable `AGENTSTACK_STATE_DIR` for lifecycle checks; never claim or remove a live owner's socket to make a test pass.
- `scripts/install.sh --check` prints the installation plan. `--install` installs the pinned codexnk runtime, builds, and links the command; neither command restarts a running owner.
- A Bot's `mainThreadId` is its sanctioned root. AgentStack thread and future subagent views must include only that root and its descendants. Other top-level Codex threads on the same socket are not Bot threads; `threads_changed` is an invalidation notice, not evidence that a sanctioned thread changed.

## The UI (`packages/uix`)

`packages/uix` is the central UI for interacting with AgentStack. The `/x` canvas ([ADR 0024](docs/adr/0024-live-canvas-workbench.md)) is how a human sees every Package API and operates `auth` ([canvas auth controls](docs/adr/0026-canvas-auth-controls.md)) and Codex voice calls ([ADR 0028](docs/adr/0028-main-thread-voice-call.md)); other APIs remain read-only there. Its data layer is in `lib/stack/` and its components are in `components/canvas/`.

- **Always maintain it.** When you change a Package API's operations, output fields, events, scopes, or transports, update the UI in the same change so it still compiles and still shows the truth: `lib/stack/types.ts`, the store's reads and subscriptions, the affected cards and inspector views, and the `/x.md` twin. Renamed, removed, or re-typed data must never silently break or go stale in the UI. Run `pnpm --filter @agentstack/uix typecheck`.
- **Never extend it implicitly.** Do not add new windows, cards, views, controls, mutating actions, interaction patterns, or UI dependencies as a side effect of other work. New UI is added only when the human explicitly asks for it. The inspector already renders every record field generically, so new fields on existing records need no new UI.
- **Nag the human instead.** If your change adds something the UI does not yet express (a new Package API, operation, event, record state, or a workflow that would benefit from a control), do not build it. Tell the human in your final report: say what is missing and suggest the UI it might need, then ask whether to build it. Repeat the reminder at later boundaries while it stays unresolved.
- Changes reach the owner-served app only after a rebuild and an authorized owner restart ([ADR 0013](docs/adr/0013-owner-managed-ui-canvas.md)). A rebuild replaces the `.next` directory a running owner is serving, so do not rebuild in place under a live owner without the human's go-ahead. Use `next dev` or a separate checkout for verification.
