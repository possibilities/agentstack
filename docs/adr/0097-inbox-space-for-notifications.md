# 97. An Inbox space for notifications

Status: accepted, 2026-09-28. Adds a sixth Canvas space beside those of
[ADR 0079](0079-system-space.md) and [ADR 0082](0082-roles-space-for-instruction-fragments.md),
on its own bench as in [ADR 0088](0088-isolated-space-benches.md). Gives the
Notifications of [ADR 0095](0095-one-dismissal-with-an-outcome.md) their first UI.

## Decision

**Inbox** (`/x/inbox`, key 6) is where people read, answer and dismiss
Notifications. It uses a new `notify` accent (sky; amber already belongs to
auth) and has two windows:

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
