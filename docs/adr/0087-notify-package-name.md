# 87. Name the durable notification Package API `notify`

Status: accepted, 2026-09-26. Amends the package name and event topic in
[ADR 0083](0083-durable-notifications-api.md); its notification record and
lifecycle decisions were later superseded by
[ADR 0095](0095-one-dismissal-with-an-outcome.md).

## Decision

The owner-managed Package API is `notify`, packaged as `@stack/notify`.
Discovery, the owner child, socket, MCP and WebSocket addresses use `notify`.
Its change Event is `notify_changed`. The operations remain `notification_*`:
they act on a Notification, the domain term in [CONTEXT.md](../../CONTEXT.md),
and their schemas and behavior do not change.

On first startup with a previous store, move the whole `notifications` state
directory to `notify`, preserving the SQLite database and any journal files.
The database file and table retain their descriptive notification names.
If both directories exist, refuse startup rather than choose a history or
silently merge independent records. The old and new Package API addresses and
Event topics are not served concurrently.

## Consequences

Clients must select `notify` and resubscribe to `notify_changed` after the
owner is rebuilt and restarted. Existing notification IDs, revisions,
acknowledgment and dismissal survive the transition. A store-directory
conflict needs explicit operator reconciliation before startup.
