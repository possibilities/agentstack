# Brain and device sharing

Brain is AgentStack's research collection and retrieval Package API. It keeps an independent SQLite index, ingestion ledger, source definitions and content-addressed research artifacts. The Chrome and Android apps are AgentStack clients whose first feature is sharing links or text into Brain.

## Storage and first start

Brain initializes fresh storage below `<AGENTSTACK_STATE_DIR>/brain`; the default is `~/.local/state/agentstack/brain`. No prior research database, artifact store, token, source subscriptions or device preferences are adopted. The retained SQLite schema makes a later deliberate import more practical, but copying or migrating existing data is a separate operation.

The AgentStack owner starts Brain with the other Package APIs. It owns the ingestion loop and device-share listener and stops them at shutdown. Use a disposable `AGENTSTACK_STATE_DIR` and ephemeral ports for development. A package rebuild does not reload an already running owner.

| Setting | Default | Purpose |
| --- | --- | --- |
| `AGENTSTACK_STATE_DIR` | `~/.local/state/agentstack` | Parent directory of all AgentStack state. |
| `AGENTSTACK_BRAIN_SHARE_HOST` | `127.0.0.1` | Explicit address for the device-share listener. |
| `AGENTSTACK_BRAIN_SHARE_PORT` | `8877` | Device-share HTTP port; `0` requests an ephemeral test port. |

The local Package API is available through the same socket, MCP and WebSocket mechanisms as other packages. Read `docs_get` for `brain`, or the live `/docs` reference, for operation inputs and outputs. The API canvas's existing catalog also describes the operations; it is not a dedicated research browser.

## Ingestion and retrieval

Admission records intent durably before extraction. A successful submission can mean a new job, a duplicate of the same intent, or content already indexed. It does not promise that newly admitted content is searchable yet. Observe the job's state to establish completion; an observer timeout does not cancel it.

The ingestion worker handles local materialization and delegates URL extraction and source discovery to the installed `agentscrape` command. An unavailable dependency leaves the job in an inspectable retry or failure state. Brain does not substitute a second HTTP extractor.

Research reads use read-only database connections. The research store owns migrations, index writes and the ingestion ledger. Jobs retain attempts and transitions; retry appends execution evidence. Ordinary job listings and summaries omit raw intent and artifact bodies. Explicit content inspection and operator dispositions retain their audit records.

Source definitions are versioned policy. Source synchronization admits a durable run; its completion proves discovery and child-job admission, not that every discovered URL has finished indexing. Due checks are invoked explicitly by a caller or an external scheduler. A fresh installation has no enabled personal sources or recurring schedule.

## Configure a device client

1. Build and start the desired AgentStack instance. The share listener defaults to `http://127.0.0.1:8877` on that machine.
2. For a phone or another computer, configure the listener with that machine's explicit reachable private-network address. Loopback on a phone refers to the phone itself. Reachability is independent of authorization.
3. Read `brain_status` for the actual `shareUrl` and `shareTokenFile`. Call `share_token_reveal` with `{ "reveal": true }` through a local control transport to obtain this instance's bearer token, then configure the client's endpoint and token. The token is private local state; no prior application's token is reused.
4. Use the client's connection check, then share a small test link or text. Confirm admission and later status in its history or Brain's job reads.

Every share, share-status and health request authenticates. The [share v1 contract](brain-share-contract.md) describes requests, responses, limits and errors. This device listener does not expose AgentStack's other local control APIs.

`share_token_rotate` generates a new token and changes the running listener immediately. Its response contains the replacement token; update each device's configuration afterward. The old token stops working, while held shares retain their intent and can retry after credentials are repaired. Token reveal and rotation are explicit sensitive operations, excluded from read-only access and from the canvas's current controls.

Client build, installation and platform-specific setup instructions live in `packages/chrome` and `packages/android`. These are new AgentStack application identities. Browser extension installation, Android device installation, and changing an active owner's bind address are explicit deployment steps.

## Offline behavior

Both clients durably hold an undelivered share and retry when delivery is possible. Their UI distinguishes **held** from **admitted**, and only the server reports indexing completion. A replay after a lost response resolves to the same admitted job instead of creating a second one.

Share outboxes are bounded to 200 entries and seven days. Expired, rejected or abandoned entries are disclosed rather than silently dropped. Credentials can be repaired without losing held intent. Destination identity binds held content and observed job IDs to the correct server, so changing configuration must not silently send old content to a new destination or display unrelated status.

## Verification and retained compatibility

`pnpm test` covers the repository's compiled tests, including Brain and client contract checks. Run `pnpm --filter @agentstack/uix typecheck` for catalog maintenance. Android's platform build additionally requires its documented JDK and Android SDK; a JavaScript workspace test is not evidence that an APK was assembled or run on a device.

The port retains schema-v12 database structures, durable ingestion semantics and the version-1 share protocol where practical. New backup manifests use `agentstack_brain_backup`; older application-specific backup discriminators need a future explicit migration. A database snapshot alone does not include its external research artifact bytes. All active product names, storage defaults and platform identities use AgentStack. External extraction remains a separately installed dependency. Neither the port nor its tests read the previous application's live research store.
