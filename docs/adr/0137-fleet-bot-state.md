# 137. Inspect and maintain one Bot's state in Fleet

Status: accepted, 2026-09-30. Applies [ADR 0135](0135-owner-state-maintenance.md) to Bots with the shared flow of [ADR 0136](0136-system-state-view-and-shared-maintenance-flow.md).

## Decision

Fleet gains a local-only **Bot state** window. It shows one Bot, which the operator picks in the window or from the State chip on a Bot card; the inspector node is `bot-state`. The window has eight views:

- **Overview**: incarnation, generation and each stored category.
- **Workspace**: file listing and bounded previews.
- **Conversation**: generations and reset.
- **Queue**: content-free receipts across roots.
- **Uploads**: status, content, removal.
- **Launch**: count and digest, with values only on an explicit reveal.
- **Log**: revision-fenced chunks.
- **Recovery**: metadata only.

Each view uses the Bot's own reads. Every maintenance action goes through `bot_state_plan` and its own `bot_<kind>` apply, with `botId` in the input, and uses the shared plan/receipt flow.

Everything below the Bot picker is keyed by the Bot incarnation. A removed and re-created Bot ID therefore shows none of the old selections, reads or recoverable receipts. Recovery slots are per incarnation and decision.

Views re-read on `bot_state_changed`, `bots_changed`, `chat_queue_changed` and scoped reconnects, but not on every thread notice. Native file writes need an explicit refresh.

The Overview lists the cleanup blockers that `bot_state_read` reports. It links to the existing controls that resolve them: Bot lifecycle, Workers, Proc schedules, Browser controllers and event subscriptions. Nothing is stopped, closed or restarted implicitly.

- **Reset** requires an explicit choice to retain or purge the current history.
- **Retired histories** are purged one at a time. Legacy shared history is never offered for purge.
- **External workspaces** can be read but not cleared. File content is shown as plain text or as binary metadata. Symlinks and special files are listed without being followed, and a partial-cleanup quarantine is marked.
- **Start fence**: an unresolved `maintenanceRequestId` shows its receipt. Releasing the fence is a separate, confirmed `bot_state_fence_release` that never claims the cleanup completed.
