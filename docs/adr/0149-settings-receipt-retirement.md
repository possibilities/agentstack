# 0149 — Settings receipt retirement keeps permanent edit dedupe

Status: accepted, 2026-09-30. Extends [ADR 0128](0128-managed-runtime-settings.md),
[ADR 0130](0130-managed-settings-editors.md) and [ADR 0135](0135-owner-state-maintenance.md).

## Decision

Record target and admission time for new shared SettingsStore patch receipts.
Legacy rows have unknown age/target; never invent either. Retirement selects exact
targets, revisions strictly below current saved revision and an explicitly stated
window of at least seven days. Plans bind current revisions and eligible receipt
identities with a frozen cutoff, not a growing selection at apply time.

Move retired active receipt rows into permanent request-ID/intent-digest/revision
tombstones. Existing receipt content was already minimal, not saved setting values.
Delayed matching patches return the original result; changed intent conflicts even
after target removal/recreation. Saved selections, application snapshots and native
effective state remain unchanged. Settings application is a separate operation.

The owner StateJournal shares the exact settings SQLite connection so retirement
and the maintenance receipt commit together. Embedded journals preserve the owner's
existing journal mode; only independently owned StateJournal files select WAL.
Auth's attached configuration/Secrets rollback-journal commit contract must not
be weakened by embedding a maintenance journal. Interrupted admission stays unknown.

## Consequences

Bots and Workers expose local-operator exact plan/apply controls and reuse owner
receipt readers/events. Minimal tombstones are retained replay authority; no claim
of large disk reclamation, secret erasure or applying defaults is made.
