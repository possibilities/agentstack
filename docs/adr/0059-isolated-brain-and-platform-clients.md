# 59. Isolate Brain and make device clients AgentStack applications

Status: accepted, 2026-09-25. Extends [ADR 0001](0001-package-apis.md)'s typed Package APIs and follows [ADR 0041](0041-isolated-wiki-package-api.md)'s isolated state and Node runtime port.

## Decision

Port the research index, durable ingestion ledger, content-addressed research artifacts, source definitions, recovery and backup capabilities into `packages/brain`. The Package API runs under AgentStack's existing Node process owner and uses the shared socket, MCP and WebSocket transports. The Brain child owns its ingestion loop and authenticated device-share listener; shutdown must stop admission and execution and release owned resources. Agentscrape remains the URL extraction and source-discovery boundary.

All default Brain state belongs below `<AGENTSTACK_STATE_DIR>/brain`, defaulting to `~/.local/state/agentstack/brain`. This includes the SQLite database, artifact bytes, share token and operational state. No existing research data, credentials, client preferences, source manifests or source activation state are imported. Existing SQLite table layouts and ledger semantics are retained where practical so a future explicitly scoped migration need not begin with a schema translation. Preserving schema shape does not authorize or implement that migration.

The share listener keeps the version-1 request and acknowledgement contract and uses port 8877 by default. It binds loopback unless a host is explicitly configured. A fresh bearer token belongs to this AgentStack instance; every data or health route authenticates. Shared Package API transports remain local-user control surfaces, not remote device interfaces. Source cadence stays durable policy, with synchronization admitted through an explicit trigger rather than adding an independent timer.

Move the clients to `packages/chrome` and `packages/android`. Their product identity is **AgentStack**, and their brand mark is the same Lucide Layers mark used by the canvas. Give them independent AgentStack application/storage identities. Sharing into Brain is their sole initial feature; package and app identities are broad enough to host future features without another product rename. Notification-center features, additional sharing destinations, and mobile access to other UIs require later product work.

## Behavioral guarantees

- Admission durably identifies an ingestion job; it is not indexing completion. Retries preserve job identity and append attempts, with leases fencing late completion.
- Package shutdown has an optional pre-drain context hook for requesting cancellation while resources remain usable. Brain aborts its execution and observer waits there, before the socket waits for active operations; final context disposal still follows socket draining. Without this ordering, a waiting operation can prevent the very cancellation it needs to settle, eventually forcing process exit instead of cleanup. Packages without the hook retain their existing drain behavior.
- Research reads use structurally read-only database connections. Schema creation and mutation belong to the research store.
- Source discovery, observations, child-job admission and checkpoint advancement remain transactionally accountable. External extraction happens outside SQLite write transactions.
- Device Share outboxes retain their bounded offline delivery semantics. A held share is not saved; acknowledgement and later job state come from the server. The port additionally binds held content and observed job IDs to the configured server URL, preventing a settings change from silently redirecting content or interpreting another server's job IDs. The v1 protocol has no durable server/store identity, so replacing a database behind the same URL is not detectable by this binding.
- Content-addressed bytes and database references remain distinct. Deletion removes the research resource and its content-bearing provenance, retaining safe lifecycle history; shared bytes survive while still referenced.

## Consequences

AgentStack can run an empty, independently usable research system beside the original application. The owner has one more child and one additional listener to preflight and shut down. Device clients require their new endpoint and token to be configured explicitly; they do not adopt a prior installation's settings or history.

The existing API catalog exposes Brain's operations and schemas. No dedicated research canvas windows or controls are introduced by this port; those remain a separate UI decision under the repository's canvas rules.
