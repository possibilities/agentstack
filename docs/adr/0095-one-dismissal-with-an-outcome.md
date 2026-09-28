# 95. Notifications are open or dismissed, with an outcome

Status: accepted, 2026-09-28. Supersedes the record, editing and lifecycle
decisions of [ADR 0083](0083-durable-notifications-api.md). The `notify` name,
state directory and `notify_changed` Event of
[ADR 0087](0087-notify-package-name.md) remain in force.

## Context

ADR 0083 gave a Notification two independent timestamps, acknowledgment and
dismissal, and replaced terminal-notifier's group with editing by ID under a
revision fence. People do not use notifications that way. Answering one or
clicking through to its content is what acknowledges it, and that also takes it
away. Two states left four combinations for every client to interpret, and
editing by ID was a second way to revise what a group already expresses.

## Decision

A Notification is **open** or **dismissed**. Dismissal happens once and records
its outcome, following alerter's activation types:

| Outcome | Meaning | `response` |
| --- | --- | --- |
| `closed` | Dismissed without engaging, including Dismiss all | null |
| `opened` | The person clicked through to the content | null |
| `action` | The person chose one of its actions | the action label |
| `replied` | The person answered its reply prompt | the reply text |
| `replaced` | A later send in the same group took its place | null |

Acknowledgment is not a separate state: `opened`, `action` and `replied`
are the acknowledged outcomes. `notification_dismiss` takes the outcome
(default `closed`) and response, and validates the response against the
record's own actions and reply prompt. The first dismissal wins; repeating it
returns the record unchanged, and a different outcome is refused with
`notification_already_dismissed`, so a late answer cannot overwrite a close.
A timeout, silence or `closed` outcome is never an answer.

Sending follows terminal-notifier and alerter. Besides title, message,
subtitle and source, a notification may carry:

- `group`, an exact replacement key. Sending with a group atomically dismisses
  the open notification in that group as `replaced`. A retried send ID
  replaces nothing.
- `open`, an http(s) URL the notification clicks through to.
- `actions`, up to eight unique answer labels in display order.
- `reply`, a placeholder that offers a free-text reply.

These are data for a future presentation surface. The API shows no banner and
executes nothing: `open` is followed by whoever presents it, and an answer is
read back with `notification_get`. `notification_update`,
`notification_acknowledge`, the revision and `updatedAt` are removed, so a
record changes only when it is dismissed. `notification_list` filters by
`dismissed`, `source` and `group`; `notification_dismiss_all` dismisses every
open notification, or one group's, as `closed`.

The store migrates in place under SQLite `user_version` 2. An acknowledged
version-1 record becomes an `opened` dismissal at the earlier of its two
timestamps; a dismissed-only record becomes `closed`. Plain sends hash exactly
as before, so a retried pre-migration send stays idempotent.

## Consequences

Clients read one state and one outcome instead of two timestamps. A producer
revising progress sends again with the same group rather than editing, so each
revision is its own record in history. Text is no longer editable, and a
version-1 edit history is not recoverable beyond its latest text. Loading the
new schema needs a rebuild and an owner restart; the store cannot be read by
the previous build afterwards. Presenting the new fields, and letting a person
answer, remains a separate UI decision.
