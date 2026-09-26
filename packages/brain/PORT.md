# AgentStack Brain backend

Ported from source snapshot `abbed107948dcafd0e3a786ebb4d9e1283cca65a`; the source's MIT license is retained in `LICENSE`.

## Runtime and state

`api.createContext` creates an empty schema-v12 SQLite index, starts a cancellable ingestion worker, and starts authenticated share ingress. It never imports a source manifest or admits a due Source Run automatically. Source Run admission remains explicit through `sources_sync`; the worker executes already-admitted jobs. SQLite schemas and content-addressed Artifact layouts are retained; Node's `DatabaseSync` replaces the original SQLite runtime, including read-only connections and nested/immediate transactions.

All default state is under `<AGENTSTACK_STATE_DIR>/brain`, or `~/.local/state/agentstack/brain`:

- `research.db` and SQLite sidecars
- `artifacts/`
- `share-token` (fresh 32-byte token, private file)
- `share-ingress.json` (private listener registration, removed on clean shutdown)
- `doctor-notify.json` (only after explicit notification)

The share listener uses `AGENTSTACK_BRAIN_SHARE_HOST` (default `127.0.0.1`) and `AGENTSTACK_BRAIN_SHARE_PORT` (default `8877`; zero allocates an ephemeral port). `/v1/health`, `/v1/share` and `/v1/shares` retain their request/response shapes and bearer authentication. Status reports the token file path, never the token. `share_token_reveal` and `share_token_rotate` are explicit non-read-only operations; rotation updates the running listener immediately.

The worker polls at one second. Expired-lease recovery and a bounded self-health probe run every 60 seconds. `brain_status.health` reports `ingestion_worker_failed`, `ingestion_maintenance_failed` or `share_ingress_unhealthy`; the package does not terminate its hosting process on a health failure. The owner owns process restart policy. The `prepareCloseContext` lifecycle hook aborts extraction and operation waits before socket draining. Final context closure clears maintenance, closes HTTP connections, awaits owned work and closes SQLite. URL extraction and discovery still run only through Agentscrape, whose detached process groups are cancelled and reaped through propagated AbortSignals on managed shutdown. Standalone dispatcher signal-exit handlers are not installed by managed extraction.

## Package API and operator tools

Typed operations cover research reads, durable admission, sanitized job/Run inspection, audited content reveal and dispositions, Source definition/application/sync/pause/resume, deletion, structural retagging, doctor, backup and frozen/scoped recovery. `jobs_show` is structurally read-only; `jobs_reveal` is the separate sensitive, audited operation. API callers cannot redirect the served database or destination Artifact store.

Every Package API response and published root output schema is an object, including over shared MCP. `jobs_list` returns `{ jobs: [...] }`; `sources_list` and `sources_status` return `{ sources: [...] }`; `sources_apply` and `sources_sync` return `{ results: [...] }`. Source-sync result entries are admissions, or admission/execution/wait results when `wait` is requested. `get` and `submit` retain their existing object-valued alternatives, with an explicit object root in the published union schema. The internal operator dispatcher's array outputs are unchanged.

Inputs derive from the internal operator contract; output schemas are generated from the domain TypeScript types by `scripts/generate-output-schemas.mjs`. `generate:schemas` refreshes them and the test command checks drift. The JavaScript compiler API used for generation is separately pinned as `typescript-compiler`; the workspace compiler remains `typescript`.

`node packages/brain/dist/src/cli.js` retains full operator dispatch (including scoped `worker --once`) for recovery and maintenance. It is not installed as a separate executable. The original standalone transport, share-serving/Portless wrappers and installation/service scripts are replaced by AgentStack lifecycle and shared transports. No source activation or real-network smoke is installed. The bundled `config/sources.example.json` is empty.

New backup manifests use `kind: "agentstack_brain_backup"`. SQLite remains compatible, but old application-specific backup-manifest discriminators are not accepted by this verifier. A backup retains its external content-addressed Artifact inventory: preserving the database snapshot alone is not a full Artifact backup.

## Verification

Tests are Node test-runner regressions using temporary directories, synthetic recovery generations, stubbed Agentscrape and local HTTP listeners. They cover the public API, real share requests, read-only SQLite, v1/v2/v12 migrations, FTS retagging, idempotency and concurrent admission/claims, fenced completion, source checkpoints, backup integrity, frozen offline/controlled-online recovery, subprocess cancellation and lifecycle shutdown. No live store, client settings, token or operator source manifest is read.

`test/mcp.integration.test.ts` performs a real shared-MCP initialization handshake, discovery and calls through the Brain Unix socket, including every array wrapper and both `get`/`submit` object alternatives. `test/api.test.ts` proves a persisted due Source admits no Run at startup or during a simulated maintenance tick, then verifies explicit synchronization executes. `test/lifecycle.integration.test.ts` launches the shared `runApi` child, starts a stub extractor with a signal-resistant descendant, and verifies both SIGINT and SIGTERM settle an active socket admission wait, yield exit 0, remove the socket and ingress registration, stop the listener, terminate the owned process group and leave the durable ledger reopenable. Standalone extraction signal exit-code behavior remains covered separately in `test/agentscrape.test.ts`.
