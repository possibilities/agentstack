# Brain and device sharing

Brain is AgentStack's research collection and retrieval Package API. It keeps an independent SQLite index, ingestion ledger, source definitions and content-addressed research artifacts. The Chrome and Android apps are AgentStack clients whose first feature is sharing links or text into Brain.

## Storage and first start

Brain initializes fresh storage below `<AGENTSTACK_STATE_DIR>/brain`; the default is `~/.local/state/agentstack/brain`. No prior research database, artifact store, token, source subscriptions or device preferences are adopted. The retained SQLite schema makes a later deliberate import more practical, but copying or migrating existing data is a separate operation.

The AgentStack server starts Brain with the other Package APIs. It owns the ingestion loop and device-share listener and stops them at shutdown. Use a disposable `AGENTSTACK_STATE_DIR` and ephemeral ports for development. A package rebuild does not reload an already running server.

| Setting | Default | Purpose |
| --- | --- | --- |
| `AGENTSTACK_STATE_DIR` | `~/.local/state/agentstack` | Parent directory of all AgentStack state. |
| `AGENTSTACK_BRAIN_SHARE_HOST` | `127.0.0.1` | Internal backend; remote binds are refused. |
| `AGENTSTACK_BRAIN_SHARE_PORT` | `8877` | Internal HTTP port; `0` requests an ephemeral test port. |

The local Package API is available through the same socket, MCP and WebSocket mechanisms as other packages. Read `docs_get` for `brain`, or the live `/docs` reference, for operation inputs and outputs. The UI **Brain** space ([ADR 0104](adr/0109-brain-space.md)) searches and reads the index, submits URLs and text, and follows the ingestion ledger and Research sources. It re-reads after Brain's `jobs_changed`, `sources_changed` and `index_changed` notices, which the WebSocket carries and MCP does not.

## Ingestion and retrieval

Admission records intent durably before extraction. A successful submission can mean a new job, a duplicate of the same intent, or content already indexed. It does not promise that newly admitted content is searchable yet. Observe the job's state to establish completion; an observer timeout does not cancel it.

The ingestion worker handles local materialization and delegates URL extraction and source discovery to the AgentStack-owned Scrape engine. An unavailable dependency leaves the job in an inspectable retry or failure state. Brain does not substitute a second HTTP extractor.

Research reads use read-only database connections. The research store owns migrations, index writes and the ingestion ledger. Jobs retain attempts and transitions; retry appends execution evidence. Ordinary job listings and summaries omit raw intent and artifact bodies. Explicit content inspection and operator dispositions retain their audit records.

Source definitions are versioned policy. Source synchronization admits a durable run; its completion proves discovery and child-job admission, not that every discovered URL has finished indexing. Proc's protected five-minute schedule invokes due checks through Brain's Package API; Brain remains the cadence and checkpoint authority. A fresh installation has no enabled personal sources, so the scheduled check admits nothing until an operator configures and enables one. See [Proc](proc.md) for trigger and outcome semantics.

## Research network policy

Research uses public-only egress by default. HTTP extraction pins approved DNS addresses and checks each redirect. Browser presets use a disposable, network-constrained Browse guest; an unenforceable provider returns `network_policy:browser_egress_unverifiable` rather than borrowing an unrestricted browser. Existing signed-in profiles are not reused. Static HTML, Markdown, PDF and feeds remain available through Scrape's constrained HTTP path.

Private sources require an explicit operator grant over the Brain socket:

```json
{"name":"egress_grant_create","arguments":{"scope":{"kind":"source","id":7,"version":2},"policy":{"privateDestinations":[{"address":"192.168.1.20","port":443}]}}}
```

Use `{ "kind":"job", "id":123 }` to grant one submitted URL root instead. Destinations are numeric TCP endpoints, not hostname patterns. Children inherit the root/source scope; source version changes invalidate older grants. `egress_grant_list` inspects grants and `egress_grant_revoke {id}` revokes one. These operations are socket-only and reject agent callers. Adding a grant does not retry an already failed job: inspect it, then explicitly use `jobs_retry` if appropriate. Share fields cannot grant network access.

`jobs_show.network_policy` reports effective authority in the existing inspector. Attempts retain policy evidence. Permanent network refusals do not automatically retry; revocation also prevents active work from committing stale results. There are no dedicated grant controls yet. See [ADR 0112](adr/0112-research-network-egress.md).

## Configure a device client

1. Configure the shared HTTPS [Access ingress](access.md) on the server's Tailscale address. Keep the Brain backend on loopback.
2. Connect the device to Tailscale, enter the Access origin in its settings, and select Pair.
3. Compare the device's approval code in **System → Access**, select its permissions, and approve. Select Check approval on the device. The connection serves AgentStack generally, not only Brain.
4. Use the client's connection check, then share a small test link or text. Confirm admission and later status in its history or Brain's job reads.

Every share, share-status and health request authenticates. The [share v1 contract](brain-share-contract.md) describes requests, responses, limits and errors. This device listener does not expose AgentStack's other local control APIs.

Shared-token reveal and rotation have been removed. Access grants and credentials are individually revocable through **System → Access**. Every remote request requires verified tailnet traffic, the expected server identity, and an appropriate audience token. Existing clients must pair again; held shares never silently change destination.

Client build, installation and platform-specific setup instructions live in `packages/chrome` and `packages/android`. These are new AgentStack application identities. Browser extension installation, Android device installation, and changing an active server's bind address are explicit deployment steps.

## Offline behavior

Both clients durably hold an undelivered share and retry when delivery is possible. Their UI distinguishes **held** from **admitted**, and only the server reports indexing completion. A replay after a lost response resolves to the same admitted job instead of creating a second one.

Share outboxes are bounded to 200 entries and seven days. Expired, rejected or abandoned entries are disclosed rather than silently dropped. Credentials can be repaired without losing held intent. Destination identity binds held content and observed job IDs to the correct server, so changing configuration must not silently send old content to a new destination or display unrelated status.

## Verification and retained compatibility

`pnpm test` covers the repository's compiled tests, including Brain and client contract checks. Run `pnpm --filter @agentstack/ui typecheck` for catalog maintenance. Android's platform build additionally requires its documented JDK and Android SDK; a JavaScript workspace test is not evidence that an APK was assembled or run on a device.

Schema v13 additively extends Brain's own database with network scopes, grants and attempt evidence; migration grants no private access. Durable ingestion semantics and the version-1 share protocol are preserved. New backup manifests use `agentstack_brain_backup`; older application-specific backup discriminators need a future explicit migration. A database snapshot alone does not include its external research artifact bytes. Browser extraction requires the separately configured Browse runtime and agent-browser toolchain. Neither setup nor tests read the previous application's live research store.
