# 97. An Inbox space for notifications

Status: accepted, 2026-09-28. Adds a sixth Canvas space beside those of
[ADR 0079](0079-system-space.md) and [ADR 0082](0082-roles-space-for-instruction-fragments.md),
on its own bench as in [ADR 0088](0088-isolated-space-benches.md). Gives the
Notifications of [ADR 0095](0095-one-dismissal-with-an-outcome.md) their first UI.

## Decision

**Inbox** (`/inbox`, key 6) is where people send, read, answer and dismiss
Notifications. It uses a new `notify` accent (sky; amber already belongs to
auth) and has three windows:

- **Inbox** (`notify-inbox`) lists notifications newest first, 25 per page with
  Load older. Open, Dismissed and All map to `notification_list`'s `dismissed`
  filter; a Source picker filters by exact source. Open rows show a dot and mark
  questions (actions or a reply prompt) and links; dismissed rows show their
  outcome. Rows that arrive after the first load flash once. ↑/↓ moves and shows,
  D dismisses the focused open row. **Dismiss all…** asks first and says that it
  closes every open notification, not only the filtered view.
- **Notification** (`notify-detail`) shows one record: title, subtitle, the
  message as markdown (no raw HTML; links open on an explicit click), details,
  and either its outcome or the ways to answer it. Each action is a button, a
  reply prompt is a text field sent with ⌘Enter, **Open link** is a real link
  that also records `opened`, and **Dismiss** records `closed`.
- **Compose** (`notify-compose`, added 2026-10-02) sends operator Notifications
  from the live `notification_send` schema: Notice, Question with bounded unique
  choices, or Reply prompt, plus declared optional content fields. The Inbox's
  **New notification** header action reveals it. Its window destination is
  `notification-compose`; window geometry remains in the space registration.
  A versioned localStorage draft is pinned to the UI origin and Notify endpoint.
  The first edit allocates a UUID; dispatch first persists that ID and exact input.
  Lost acknowledgements and reload keep the intent frozen for an explicit identical
  retry. Changing uncertain intent requires explicit local discard, which cannot
  recall an already stored Notification. Failed draft persistence prevents sending.
  Sends omit `subscribe` and show **No Bot watch (operator send)**, following
  [ADR 0154](0154-notification-send-and-watch.md). **Sent — stored** confirms only
  storage, then selects the returned record in Notification. Group replacement is
  disclosed before sending; closed/opened/replaced/read/silence are never approval.
  Remote Compose is hidden unless live WebSocket exposure and `ui:control` allow
  sending; disconnection disables sends without losing the draft.

**Choosing never dismisses.** Selecting, focusing or inspecting a notification
changes nothing; only the explicit controls above dismiss it, once. A refused
second dismissal is reported rather than retried.

`notification` is a new node kind whose destination is the Inbox window. The
inspector shows the generic record with field notes from discovery and an
**Open in Inbox** hand-off; the palette finds loaded notifications. Open
notifications, and a closed `notify` channel, are Inbox space attention.

The store keeps the chosen filter, the pages loaded for it and the latest record
per ID. `notify_changed` re-reads counts and as many pages as are loaded, so
older rows neither vanish nor go stale, and a response for a filter the Inbox
has left is dropped. The Notification window and the inspector watch their
record by ID, so it stays current when no loaded page lists it. Writes re-read
lists and counts whether or not their acknowledgement arrives.

The `notify` Package API gains `notification_counts`: open and total counts,
overall and per source. The space badge and Source picker need totals that a
25-row page cannot provide.

## Consequences

The palette finds only notifications this page has loaded. Sources are listed
from counts, so notifications sent without a source can be shown under All
sources but not selected alone. There is no arrival toast outside the Inbox;
presenting notifications elsewhere remains a separate decision. Loading the
space into a running owner needs a build and an owner restart
([ADR 0013](0013-owner-managed-ui-canvas.md)).
