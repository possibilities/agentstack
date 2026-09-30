# 141. Retire exact Work bodies without deleting semantic identity

Status: accepted, 2026-09-30. Human decision 01·D1 approved children-first
tombstoning; extends [ADR 0135](0135-owner-state-maintenance.md) and
[ADR 0132](0132-native-hud-work-collaboration.md).

## Decision

HUD owns exact `journal_bodies` and `item_and_journal` maintenance. Both redact
authored journal bodies, references and edit before/after values while keeping
sequence, actor, kind, fields, scope revisions, timestamps and request IDs.
Journal-only maintenance retains current Work and metadata. Item-and-journal
also clears authored fields and metadata, retaining ID, hierarchy position,
semantic state, dependency IDs and a body digest.

Tombstones cannot be reopened, edited, focused or used for new Worker admission.
Create new Work instead. A parent with retained children blocks unless those
children are explicitly included in the same atomic selection. Closed tombstoned
children remain in the hierarchy; cleanup never completes or cancels Work.

Plans fail closed on unavailable Worker associations and block open admissions on
selected Work or descendants, plus active-sanctioned-root Chat focus. Dependency
reads are observations, not a cross-owner lease or a lock on external writers.
Worker-captured context and other owners' copies remain independently retained.

Apply rechecks observations, then binds the local item, metadata, journal, hierarchy
and focus snapshot in the same SQLite transaction as its receipt. It advances
content generation/revision and appends a content-free maintenance entry, forcing
tree pagination and timeline readers to refresh. Logical redaction makes no media,
WAL, backup or remote erasure promise. No new UI is introduced by this decision.
