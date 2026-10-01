# 0151 — Access retirement is exact expired metadata, not identity revocation

Status: accepted, 2026-09-30. Extends [ADR 0135](0135-owner-state-maintenance.md).
Human decision 04·D1: no new manual audit pruning; preserve automatic retention.

## Decision

Add opaque identities to existing UI-session metadata; never expose bearer values
or token hashes for selection. Exact UI-session, pairing and invitation plans
require expiry. Active/unexpired entries block; use revocation separately to end
authority. Apply rechecks exact rows under the Access SQLite transaction and commits
retirement with the durable maintenance receipt. Missing/changed rows are stale.

Keep server/client/grant/credential identities, revocation state, enrollment and
Share receipts. In particular, enrollment authority may outlive an invitation
until the device QR expires. Retired pairing request/invitation IDs keep minimal
digest markers so manual retirement cannot create a second admission from the same
intent. No implicit global expiry cleanup runs as part of exact retirement.

Audit has no manual pruning operation. Existing mutation cleanup prunes rows below
`max(seq)-999` before appending mutation audit entries; the preserved policy can
temporarily exceed 1,000 rows after new entries. Maintenance appends its own audit
entry without using a request to delete previous audit evidence.

## Consequences

Access invalidation is published after commit. Identical request/restart returns
the original result, including unknown interrupted admission, without removal.
Device credentials, cookies, outboxes and backups remain independent copies.
All new controls require local operator authority and are absent from MCP and
remote Access, even with a UI control grant or read-only annotations.
