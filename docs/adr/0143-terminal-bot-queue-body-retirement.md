# 143. Retire terminal Bot queue bodies with atomic admission evidence

Status: accepted, 2026-09-30. Extends
[ADR 0135](0135-owner-state-maintenance.md) and
[ADR 0120](0120-codex-native-input-admission.md).

## Decision

Exact `bot_state_plan` queue-body maintenance selects terminal IDs or a recorded,
retired history generation of the current Bot incarnation. Pending/dispatching
entries block. Apply uses the stopped Bot lifecycle fence and the existing owner
dependency observations; it never cancels, stops, starts or reconciles delivery.

New queue admissions persist their original byte count, input digest and history
generation. Migration derives byte counts/digests from existing bodies, but never
guesses a legacy generation from thread ancestry. Those legacy rows remain exact-ID
selectable only. Clearing replaces input with an empty array and records
`contentClearedAt`; destination, ID, state, turn identity and unknown evidence remain.
Identical admission retries compare the retained digest. Cleared entries can never
return to pending/dispatching, and unknown still blocks later deliveries until an
explicit, independently verified reconciliation.

Queue bodies live in `chats.sqlite`, separately from the Bot filesystem-maintenance
journal. Queue plans/receipts therefore use the same owner `StateJournal` protocol
co-located with queue rows: effects and receipt commit atomically. Moving every Bot
journal or relying on cross-database WAL atomicity is unnecessary and unsafe.
`bot_state_receipt_get` reads both owner journals; request UUID reuse across them is
refused. Filesystem maintenance retains its original durable start-fence behavior.
Interrupted admitted cleanup returns unknown after restart and never executes again.

Native queued input/history, Signal captures, HUD/Worker associations, WAL/free pages
and backups remain independent copies. No new UI or live cleanup is authorized by
this backend capability.
