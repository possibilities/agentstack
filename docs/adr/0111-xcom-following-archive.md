# 111. Keep the following-feed archive separate from Brain

Status: accepted, 2026-09-28.

Renumbered from 0110 after concurrent integration with the already-published Proc authority decision.

## Decision

`packages/xcom` owns one private, best-effort SQLite archive of the authenticated `twitter` CLI's following feed. Brain remains the general Research resource index and ingestion ledger. Xcom does not create Brain resources, use Scrape's URL extraction, or offer embeddings: both packages use FTS5 for lexical research retrieval, but Xcom's source-specific pagination, head/backfill checkpoints, author observations and full X Article catch-up do not belong in Brain's generic ingestion worker.

The database lives under `<AGENTSTACK_STATE_DIR>/xcom/following.sqlite3`. No existing xarchive database, credentials or configuration are imported at setup. The retained xarchive tweet, article, attempt, metadata and `scan_state` layouts permit a future **explicit**, stopped-service database copy. A separate `head_scan_state` keeps recent refresh independent of a paused historical cursor. Startup upgrades FTS projections and observed-user metadata from copied records without rewriting posts. Tweet and article FTS indexes remain separate so an API caller can select tweet text, article title/body or both. A user is an **observed post author**, not an authoritative account on the following list.

An owner-supervised child performs bounded, paced CLI requests. **Automatic scheduling is disabled by default** while the separate xarchive seeding and explicit copy remain outstanding; `AGENTSTACK_XCOM_AUTO_SYNC=1` enables it after the handoff. With scheduling enabled, startup and hourly wakes prioritize a due head scan (every six hours), then resume initial two-calendar-month backfill, then catch up on missing articles. Each run processes at most 50 pages; cursor, page and post writes commit together. Transient failures retry the same cursor with delays; permanent failures leave it saved. Head and backfill scans each cap at 1,500 pages. Scan ends, older-only pages, repeated known head pages and page caps are heuristics—not completeness proofs. Old stored posts are not deleted or silently updated. The X CLI may truncate pages, omit posts or return an out-of-order feed.

## API and consequences

MCP offers status, nonblocking sync admission, search, bounded context, post reads/traversal and observed-author reads. Socket additionally offers explicit FTS repair. No WebSocket or UI controls are introduced. The UI's generic API reference discovers the schemas, but a dedicated UI for archive health, sync and research browsing requires an explicit UI decision.

The CLI's authenticated local installation is an operator prerequisite. Xcom never reads the independent xarchive default path, and tests inject a fake provider or a nonexistent executable. Shutdown aborts CLI calls and timers before closing SQLite; the owner does not remove another process's socket or modify a running archive database.
