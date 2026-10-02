# 164. A Source space for webhook receivers, deliveries and original payloads

Status: accepted, 2026-10-02. Adds a Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md) and gives the `source` Package API of
[ADR 0159](0159-github-webhook-ledger-and-watches.md) its first UI, after the
occurrence and runtime-intake work of [ADR 0160](0160-poll-occurrences-and-runtime-event-intake.md).
It supersedes the "no dedicated UI views" note of `docs/github-webhooks.md` for this
phase. This is phase 1 of three: **Observe**. Watches (phase 2) and receiver setup,
secret handling, hook plans and probes (phase 3) are deliberately not built; the
space makes no setup mutation of any kind.

## Decision

**Source** (`/source`, key `s`, a new `source` accent) is an evidence-first bench:
what arrived, and where it came from, before any setup. Four windows, left to right:

- **Receivers** (`source-receivers`, column 0) reads `github_status` and
  `github_endpoint_list`: the loopback intake, body limit, newest local sequence, and
  retained-payload capacity, then each receiver with its target, enablement, last
  signed delivery and ping, accepted / duplicate / rejected counts and last refusal.
  A receiver's disclosure shows **five separate facts** from the receiver and
  `github_setup_read`: local configuration, public prerequisite, remote configuration,
  request receipt, signed arrival. None implies another; the space never says
  "Connected". Setup steps and limitations are collapsed text. URLs are text with a
  copy control, never links.
- **Event catalog** (`source-catalog`, column 0) reads `github_event_catalog` by variant
  (Cloud, Enterprise Cloud, GHES 3.14-3.19), hook type and search, and
  `github_event_schema` one chunk at a time from a single variant and version, restarting
  rather than splicing two bundles. It is labelled documentation: an event the catalog
  does not list is still accepted and filterable.
- **Deliveries** (`source-deliveries`, column 1, fixed) is the ledger over
  `github_delivery_list`, oldest first. A session pins the **first response's `through`**,
  sends it with every later page, and follows the **exclusive `nextCursor`**; a short or
  empty page is not the end, only a null cursor is. The header says **Snapshot through
  #N**. Arrivals beyond N produce **New arrivals available** and never move the loaded
  rows; only a finished snapshot may **Continue to the newest** (the next range starts at
  the old watermark and appends), and **Start fresh** is a new session. **A changed filter
  is a fresh session**; filter values live only in page memory, never in URLs or browser
  storage. Filters AND across fields and OR within one; predicates support only
  `equals`, `one_of`, `contains`, `starts_with` and `exists`, and **keep scalar types**
  (`false`, `0`, `null` and the text "false" are different values; `one_of` may mix types
  as JSON lines). Arrow keys, Home and End move between rows.
- **Delivery** (`source-delivery`, column 2, fixed) shows one delivery: observed summary,
  discovered entities, receiver link, digest and, on request, the original body in
  32,000-character chunks as **escaped text only**: no markup, media or followed links.
  The SHA-256 digest is verified only after the whole body is reconstructed, and a
  partial body is never described as verified. Entity titles and URLs are payload-derived
  and shown as text. Opening a delivery by link (`?focus=github-delivery:N`, or the
  inspector) reads it with `github_delivery_get`, so it need not be in any ledger page.

`github-receiver` (UUID) and `github-delivery` (local sequence) are new node kinds, homed
in Receivers and Delivery. The inspector resolves both with read-only fields and the
operations they relate to; a delivery inspected before any page holds it is read on its
own. There is no `github-watch` kind until phase 2.

**Capacity speaks in words.** Retained-body count and bytes are shown against both
limits. Reaching either means **Full · intake refused (507 `github_storage_full`)**, never
queued or silently dropped; a receiver whose last failure is that code shows it, and the
space flags attention for a full or refusing store. Clearing space does not retrieve
deliveries GitHub could not make, and GitHub does not redeliver on its own.

**Payload clearing uses the shared flow.** In Deliveries, a local-only Maintenance
disclosure chooses up to 100 exact sequences whose original payload is retained, then
`StateMaintenance` (`github_history_plan`, `github_history_clear`,
`github_state_receipt_get`) prepares, reviews, applies and recovers the receipt. The action
is named **Clear original payloads**: summaries, digests, duplicate fences, watch matches
and acknowledgements remain, and it is neither secure erasure nor provider replay
recovery. The choice is frozen while a plan or receipt shows.

## Refresh

`source` is a Channel with `github_endpoints_changed` and `github_deliveries_changed`;
both are silent in Activity (every arrival publishes both). Notices are not replayed, so
every (re)connect re-reads status, receivers, held setups and delivery summaries and
revalidates the ledger at its watermark. Arrivals change nothing already loaded; a
cleanup changes cleared markers. The notice carries neither, so the status read decides:
each accepted delivery adds one retained body, so fewer bodies than the newest sequence
implies means a cleanup happened, and only then are loaded rows re-read (replacing
summaries in place at the pinned watermark). A row a payload predicate can no longer
match because its body was cleared keeps its place, marked. A reader holding a body when
a cleanup lands is replaced by the cleared marker.

## Remote boundary

All four windows read on a remote Access session through the gateway's read-only
selection. `github_setup_read`, status, catalog, delivery reads and payload reads are
read-only; native `gh`, hook, receiver mutation, secret and receipt operations and the
history plan, apply and receipt are fenced by Access (`localGithubOperation`,
`localStateOperation`) even with `ui:control`, and the `source` package has no remote
mutation allowlist. The UI hides Maintenance remotely rather than disabling it. The remote
page allowlist gained `/source` (`packages/access/src/remote-ui.ts`).

## Consequences

People can see what arrived and prove which receiver it came through, read the exact
signed body safely, and recover storage, without a setup UI existing yet. Receiver
creation, edit, manual secret reveal and rotation, `gh` discovery, hook plan/apply, probe,
provider attempts and redelivery stay API-only (phase 3), as do watches and their
acknowledgement (phase 2). `docs/github-webhooks.md`'s "no dedicated UI" note describes
the API phase only.
