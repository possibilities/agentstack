# 104. A Brain space, and Brain change notices on the local WebSocket

Status: accepted, 2026-09-28. Adds an eleventh Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md), after the Scrape space of
[ADR 0103](0103-scrape-space-and-local-operator-exposure.md), and gives the `brain` Package API of
[ADR 0059](0059-isolated-brain-and-platform-clients.md) its first UI. Uses the independent
transport selections of [ADR 0096](0096-explicit-transport-exposure.md). Leaves remote UIX policy
of [ADR 0101](0101-remote-uix-through-access.md) unchanged.

## Decision

**Brain** (`/x/brain`, key `b`, a new `brain` accent) is where people search and read collected
research, submit material, and follow ingestion and recurring sources. The number keys are all
taken, so its shortcut is a letter. It has five windows, ordered find, read, add, watch, maintain:

- **Search** (`brain-search`) runs `search` with its match mode and filters (tag, source type,
  content kind, sensitivity, collection and update dates), pages with `next_offset`, and marks the
  snippet's matched terms. **Context** runs `context` on the same query and copies citation-ready
  text. Before any query it shows the index from `stats`: counts, recent documents, top tags and
  source types. An `index_changed` notice after a search offers to run it again rather than
  replacing results under the reader.
- **Reader** (`brain-reader`) shows one Research document from `get`, head/tail truncated at
  20,000 characters with **Load full**. Opened from a hit, it highlights that chunk, by offset in an
  untruncated body and by the chunk's own text otherwise. Content is untrusted plain text: nothing
  renders as HTML or loads, and only an http(s) source opens, on request, without a referrer. Its
  links open linked documents. **Delete** is confirmed and describes what is purged.
- **Ingest** (`brain-ingest`) submits a URL or text with title, tags, collection and notes. Each
  draft carries its own idempotency key, so a repeated or lost submission resolves to the same job;
  a failed draft keeps its key. Results use Brain's terms (admitted, duplicate, already indexed)
  and follow each job through `share_read_states` until it reaches a terminal state and names its
  document. These labels exist only in page memory, because job reads never return submitted
  content. Server-side file and directory paths remain API-only.
- **Jobs** (`brain-jobs`) shows worker health from `brain_status` and ledger counts from
  `jobs_stats`, then **Needs attention** (failed, blocked, waiting to retry), **Active**, **Done**
  and **All**, optionally narrowed to one Run. A row expands to `jobs_show` diagnostics, the
  document once indexed, and the dispositions the ledger's legal transitions allow, each with a
  reason (required to exclude). **Reveal content** calls `jobs_reveal` only after a confirmation
  that it appends an audit record, and keeps nothing after closing.
- **Sources** (`brain-sources`) lists `sources_status`: health, schedule and next due time, latest
  Run with its counts, checkpoint, pause reason. Each source can **Sync**, **Preview** (dry run) and
  **Pause…/Resume…** with a reason; the footer previews or syncs every due source. A Run filters
  Jobs. Definitions stay API-only through `sources_apply`.

`research-document`, `ingestion-job` and `research-source` are new node kinds whose homes are the
Reader, Jobs and Sources. Their inspector views show the generic record with field notes; a
document hands off to the Reader. The palette searches Brain for the typed text, jumps to a job by
number and lists sources. The space flags attention for a closed channel, a stopped or failed
ingestion worker, unhealthy share ingress, failed or blocked jobs (which stay until retried or
excluded), stale leases and unhealthy enabled sources. Waiting retries do not raise attention.

Brain publishes three invalidation topics: `jobs_changed` (ledger or worker health),
`sources_changed` and `index_changed`. A separate read-only connection polls `PRAGMA data_version`
each second, so it sees commits by the ingestion worker, share ingress, operation calls and external
CLIs, and compares cheap primary-key and count fingerprints that never read document bodies;
lease heartbeats publish nothing. A mutating operation compares immediately, and a retag, which
rewrites FTS rows in place, announces `index_changed` directly. The WebSocket selects every topic.
MCP selects none: offering Bots these watches is a separate decision.

Recovery, backup, `doctor`, `retag`, source definitions and the `share_*` device operations
remain API-only.

## Consequences

Remote UIX receives only Brain's read-only operations, because Access has no Brain control
allowlist. A remote session can search, read, and inspect jobs and sources, but it cannot submit,
change jobs or sources, delete or reveal, even with `uix:control`. The windows say these controls
are available only on the local UIX. `share_read_states` is read by the local UIX as the trusted
same-user reader its description names; Access still filters the IDs a device client may read.
