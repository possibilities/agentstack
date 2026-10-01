# 0145 — Scrape maintenance holds claims and retains permanent generation fences

Status: accepted, 2026-09-30.

## Context

The scrape-to-file queue represents one generation in pending, retry and failed files.
Native claim slots and publication recovery prevent duplicate extraction/publication.
Filesystem cleanup cannot commit atomically with a StateJournal receipt (ADR 0135).

## Decision

Resolve every physical form of an exact generation. Pending-only cancellation,
failed-only retry and failed/receipt-retired discard hold the existing native generation
slots. Maintenance never recovers or breaks existing live, dead or unresolved claims;
publication temporaries block rather than becoming extra deletion targets.

Persist the maintenance admission and permanent old-generation fence in one owner
database transaction before filesystem effects. Standalone processors read fences
structurally read-only and refuse those generations. Retry explicitly publishes a new
filename/generation without extraction in the maintenance call; record its planned
filename before publication so interrupted receipts identify the uncertain attempt.
Then remove only exact predecessor files through the shared descriptor-relative helper.
Identical requests, including after restart, return the original receipt and never
re-publish or re-extract. Separately planned discard may remove fenced leftovers.

Local corpus cleanup selects final preset/capture IDs only. Keep retired IDs in the
same ledger; future publication chooses a sequence above existing and retired samples.
Do not remove shipped fixtures, local definitions, temporary publication, external
destinations, Brain contents or authenticated Browse sessions. Unattributed native
retirement quarantine stays with its existing recovery owner.

## Consequences

Unknown remains unknown, with durable generation fences and queue reader markers.
Queue/corpus changes invalidate existing reads through `scrape_queue_changed`.
Minimal receipts and identity fences remain after body removal. A new retry can spend
or publish after the call returns; admission is not extraction completion. No native
provider, CLI or browser image changes are required.
