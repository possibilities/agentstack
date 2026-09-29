# 83. Durable notifications without a presentation surface

Status: superseded by [ADR 0095](0095-one-dismissal-with-an-outcome.md), 2026-09-28. Accepted 2026-09-26. Builds on the Package API and transport contracts in
[ADR 0001](0001-package-apis.md) and [ADR 0010](0010-shared-websocket-transport.md).

## Decision

`notifications` is an owner-managed Package API with socket, MCP and loopback
WebSocket transports. It persists every notification under Stack state,
including messages a future UI may display only transiently. Sending returns a
stable ID. Callers can update text or source by ID with a revision fence; no
separate group/replacement key exists. An optional caller-supplied UUID makes
retries of identical initial sends safe, even if the record has since changed.

Acknowledgment and dismissal are independent, one-way, idempotent timestamps.
An update does not reopen a dismissed notification or reset acknowledgment.
`notification_dismiss_all` atomically dismisses undismissed records, without
deletion. Newest-first cursor pages support independent state and source filters.
`notifications_changed` is a payload-free invalidation notice, not a delivery
receipt. No buttons, actions, callbacks, OS presentation or retention pruning
are part of this API.

## Consequences

History survives owner restarts and remains available to a future inbox. The
initial API deliberately has no interface to show banners or dismiss records;
presentation and any richer grouping semantics require an explicit later choice.
