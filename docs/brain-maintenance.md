# Brain maintenance invariants

The [port decision](adr/0059-isolated-brain-and-platform-clients.md) establishes package and platform ownership. These constraints preserve the research engine's behavior through runtime adaptation and later changes.

## Database and artifacts

- `ResearchCache` opens existing databases structurally read-only and refuses a missing or incompatible store. `ResearchStore` alone creates, migrates and writes the index and ledger. Do not substitute a writable connection to make a read succeed.
- `chunks_fts` is an ordinary, non-contentless FTS5 table. To change indexed tags or content, delete the affected rows and reinsert **every indexed column**. Updating only a tag column can silently corrupt retrieval.
- Keep resource identity, document identity and content digests distinct. Equal artifact bytes do not establish that two resources are identical.
- Filesystem artifact publication and SQLite cannot form one atomic transaction. Preserve staging, validation and reconciliation. When purging content, commit reference removal before unlinking bytes; retain bytes referenced elsewhere.
- Deleting a research resource removes its searchable content and content-bearing provenance. Lifecycle records remain, with locators and payloads redacted rather than recoverable through job inspection.

## Ingestion

- Admission stores immutable intent and returns the durable job identity before materialization. Queued and duplicate are successful admission outcomes; waiting observes the job and must not imply execution when it times out.
- Claims have expiring leases and fencing tokens. Cancellation, expiry or replacement must prevent a late executor from committing a stale result.
- Perform extraction outside write transactions. Commit successful document/index effects, provenance, child jobs, source checkpoint effects and job completion together where they share the database.
- Retry creates a new attempt on the same job, preserving earlier attempts and operator dispositions. Infrastructure unavailability, bounded item retries, permanent content failures and authentication/configuration blocks remain distinguishable.
- Source run success establishes durable discovery and child-job admission, not completion of every child. Checkpoints must never advance past unaccounted observations. Conditional validators and provider cursors remain tied to the exact source identity and definition version.
- Agentscrape owns all URL network reads, provider parsing and browser/session policy. Brain must not add a fallback network client when that dependency fails.

## Device clients

- Preserve the [v1 share contract](brain-share-contract.md). Authenticate and bound requests before any admission. Logs carry safe status and identity metadata, never tokens, content bodies or raw shared URLs.
- A Share outbox holds intent that the server has not acknowledged. The UI must say **held**, not saved or queued in Brain. A repeated request after an ambiguous response relies on server idempotency.
- Preserve destination binding for held payloads and observed job IDs. Updating a credential for the same destination is different from redirecting content to another server.
- Bounded history is client evidence, not a second ingestion ledger. Completed, blocked and failed states must come from authoritative server observations.
- Treat `packages/chrome` and `packages/android` as general AgentStack app identities. Add another feature only when requested; preserve the existing sharing feature's semantics during branding and platform work.

## Verification

Use disposable AgentStack state and stub external extraction. Never point a regression test at a live database, token, source manifest or owner socket. Exercise the public Package API and actual share listener as well as domain helpers; a passing TypeScript build does not establish lifecycle or wire compatibility. Platform build and device/runtime verification are separate evidence.
