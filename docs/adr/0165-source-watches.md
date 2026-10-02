# 165. Source watches: definitions, a not-pinned inbox and explicit acknowledgement

Status: accepted, 2026-10-02. Phase 2 of the Source space of [ADR 0164](0164-source-space.md),
over the watches of [ADR 0159](0159-github-webhook-ledger-and-watches.md) and the occurrence
and runtime intake of [ADR 0160](0160-poll-occurrences-and-runtime-event-intake.md). Receiver
setup, secret handling and hook plans (phase 3) are [ADR 0166](0166-source-receiver-setup.md).

## Decision

A fifth window, **Watches** (`source-watches`, column 3, fixed), and the node kind
`github-watch` (a UUID; its destination is that window, a link or `?focus=github-watch:<id>`
opens its inbox, the inspector resolves it). A watch is a durable filtered inbox with an
immutable filter, so the window reads definitions and offers no way to edit a filter: a changed
filter is a new watch.

**Definitions.** Each card shows the label, **Notifications on/off**, the filter (shared
`describeFilter` chips), the acknowledged cursor, the matched high-water `through` and the
pending count. The list operation carries definitions only; pending and `through` come from
`github_watch_read` with one entry, for up to 32 watches, re-read on every deliveries notice
(a disabled watch captures silently) and the selected watch's own inbox.

**Creation** reuses the Deliveries filter editor (`source-filter-editor.tsx`, one draft shape
and serialization) and can start from the ledger's current filter. A UUID is shown (the
idempotency key), the label is trimmed, and the start is **now** (default) or an explicit
**backfill after sequence N** that must not exceed the newest arrival. "Review definition"
freezes one deep-frozen request, shows it in words and as the exact JSON that will be sent,
and warns that a payload predicate cannot match a delivery whose original payload was cleared,
and that an empty filter matches everything. Reviewing sends nothing; "Create watch" sends
exactly the reviewed request. If the answer is lost the watch is read back (`github_watch_get`):
created, absent or unknown, and a repeat with the same UUID and definition is safe.

**The inbox is not a pinned snapshot.** `github_watch_read` takes no `through`. The first read
asks for the owner's cursor (no `after`); later pages follow `after` = the exclusive `nextCursor`
(or the last loaded row once the end was reached). Matches that arrive while reading are
announced ("New matches arrived", pending and `through` move) and loaded only on request; loaded
rows never move. The inbox refreshes on the scoped `watch:<id>` notices, on
`github_deliveries_changed`, on the unscoped `github_watches_changed` (the watch may have been
removed) and on every (re)connect; a refresh re-reads the loaded range from the owner's cursor and
replaces summaries in place. If the owner's cursor is not the one the rows were read from, the rows
are replaced and every review mark is cleared ("The acknowledged cursor moved").

**Acknowledgement is explicit and bounded by review.** Each entry has a keyboard-accessible
**Reviewed** checkbox, a **Details** disclosure and **Mark through here** (this entry and every
older loaded one). The cursor can only move through an unbroken run from the oldest pending entry,
so **Acknowledge through #N** names exactly that run; marks after a gap are listed as not covered.
The confirmation names the cursor move (`#base` to `#N`), every entry in the range, the entries
marked without opening their details, how many stay pending and that the move is forward-only. It
sends `github_watch_acknowledge` with `through` and `expectedAcknowledgedThrough` = the cursor the
rows were read from. The confirmation closes if the review or the cursor changes under it.
**Nothing acknowledges on view, navigation, reload, a notice, polling, native admission or Worker
intake.** On `github_watch_cursor_changed` (or `github_cursor_invalid`) the inbox is read again from
the owner's cursor, every mark is cleared, review is required again and the request is not retried.
A lost answer reads the cursor back: moved to the requested position (the answer was lost), unchanged
(not applied; marks kept) or elsewhere (conflict); if it cannot be read back the result is stated as
not confirmed and nothing is retried.

**Settings.** The configuration revision and the consumption cursor are shown as separate things. The
label and **Notifications / occurrence polling** change `github_watch_update` against
`expectedRevision`; a stale revision is refused and the watch read again. Disabling pauses scoped
notices and occurrence polling; matching and the inbox continue. **Remove** retires the ID after
a confirmation naming the exact watch and requiring the first eight characters of its ID; it
does not remove attached Stack subscriptions (they are removed in System, Subscriptions,
Occurrences).

**Agents.** "Use from an agent" has copyable `events_subscribe`, `events/poll` and `events_listen`
requests carrying the watch's ID and links to the `github_watch_events` occurrence section of the
API reference for semantics. It states that polling, native admission and Worker intake never
advance the consumption cursor. There is no operator wake or target action.

## Remote boundary

Definitions, counts and inboxes read on a remote Access session over the same read-only
operations. Every watch mutation (create, update, acknowledge, remove) is hidden, review marks are
not offered, and the gateway fences them even with `ui:control` (the `source` package has no
remote mutation allowlist).

## M7a follow-up

The payload-clear Maintenance disclosure lists every saved clear request left without a confirmed
receipt, whatever is chosen now (recovery slots are keyed by the exact selection). It opens itself,
waits for the Source connection, reads only each request's receipt, never re-plans or resends, and
lets the person forget a request explicitly.

## Consequences

People can create, review and consume watch inboxes without risking silent acknowledgement, and
see what was skipped. Acknowledgement by a UI is an operator's explicit act on a cursor that agents
may share; the confirmation says so, and says that an independent consumer should create its own
private watch with the same filter. The compare-and-set bounds the damage. Receiver setup, secrets,
hook plan/apply/probe, redelivery and `gh` discovery are phase 3 ([ADR 0166](0166-source-receiver-setup.md)).
