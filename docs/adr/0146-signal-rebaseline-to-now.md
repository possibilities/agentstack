# 0146 — Signal checkpoint reset rebaselines exact sources to now

Status: accepted, 2026-09-30. Extends [ADR 0135](0135-owner-state-maintenance.md).

## Context

Captured-content clearing keeps source cursors and suppression. Resetting those
cursors to the beginning could reinterpret old transcripts and spend inference.
The human approved rebaseline-to-now only (03·D1), not historical replay.

## Decision

`attention_checkpoint_plan` observes exact sanctioned Chat/Worker source positions,
or all currently visible sources, while processing is paused and reads/inference
are drained. The first-enable baseline must exist. Pending interpretations block
until resolved or disposed through the separate captured-content lifecycle.
Planning does not admit messages or retain upstream read bodies.

Apply reobserves heads and local cursors; changed inventories, heads or owner state
invalidate the plan. Serialize maintenance observations and refuse resume while
they run. Commit exact cursor replacement, partial-buffer/reconciliation reset,
checkpoint generation markers and the StateJournal receipt in the owner database.
Keep captured content, suppression, unknown outcomes, Infer correlation, activation,
defaults and sibling checkpoints. Identical retry/restart returns the original
receipt without another source read; interrupted admission remains unknown.

## Consequences

Reset admits no inference. Resume reads from the new position, skipping messages
present at the bound head; later new or changed observations can interpret under
the existing settings. Source inventories and Worker forward-cursor scans are
bounded and fail closed on unreadable sources, rather than claiming empty history.
No timestamp filter, backfill or native transcript clearing is introduced. Local
operator authority only; remote Access refuses these operations.
