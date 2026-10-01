# 0144 — Brain payload retirement preserves admission and recovery authority

Status: accepted, 2026-09-30.

## Context

Terminal Ingestion jobs can retain content without an indexed document. Runs capture
checkpoint/recovery intent independently. Source checkpoints are not index contents;
resetting them may regenerate network work. Artifact metadata and object bytes occupy
different stores. ADR 0135 requires exact owner plans and persistent uncertainty.

## Decision

Brain co-locates its StateJournal with the research ledger and redacts exact terminal
job/Run payloads atomically with receipts. Retain admission digests, transitions,
dispositions, timing, identities and immutable recovery generation/snapshot/approval
authority. Cleared jobs cannot reopen. Equivalent device admissions compare the
retained original intent digest and return the same job; changed intent still conflicts.
Operator-controlled jobs are retired only through their drained terminal Run.

The human approved checkpoint reset while indexed documents remain (02·D1). Require
paused/drained sources and verify the protected Proc source schedule. Reset admits no
work and stays paused; subsequent explicit resume/sync may re-read/re-admit and spend.
Source removal permanently disables/tombstones its stable identity, retaining source
definition/checkpoint history, documents and already admitted jobs. Never revive it
through manifest updates or resume; use a new identity.

Artifact collection checks Resource, derivation, provenance, job and recovery
references. Remove registration with durable admission first, then hold the SQLite
write fence while descriptor-relative exact byte removal runs. Partial/unknown
filesystem outcomes survive restart and never automatically execute again. Missing
or corrupt paths without an exact snapshot fail closed. Retrieval remains structurally
read-only; clearing never rewrites FTS or opens external backups.

## Consequences

Logical redaction is not media erasure: WAL/free pages, backups, source histories and
other owner/device copies remain. Recovery authority is deliberately not a purge
target. Local-only operations emit independent jobs/source/index invalidations.
