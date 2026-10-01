# 0155 — Exact Browser provider maintenance

## Status

Accepted. Extends [0135](0135-owner-state-maintenance.md) and the Browser profile /
handoff lifecycle. Follows the human-approved CDP approach; no upstream patch.

## Context

Browser data lives in provider-owned volumes, not its JSON ledger. Bot defaults
cannot be deleted through ordinary profile removal, but an explicit reset should
discard sign-ins without losing profile identity/assignment. CDP offers scoped
storage and cookie deletion, not scoped HTTP cache or persisted-history erasure.

## Decision

- Add one Browse `StateJournal`. Provider/CDP/JSON effects persist admission before
  dispatch and never rerun after interruption. Partial receipts list known removed
  and leftover exact provider IDs; restart converts running admissions to unknown.
- Profile plans bind generation, assignment, Bot/controller/handoff lifecycle,
  provider root/connection and exact instance/volume incarnation. Apply holds the
  profile/handoff locks. The assigned stopped Bot holds its own start/stop/adoption
  mutex through a single-use owner-issued Browser callback. No implicit stop/start.
- Persist `maintenanceRequestId` before drain/mutation. Managed CDP/human input is
  held/drained/revoked. Profile ensure, deletion, controller selection and new
  handoffs refuse that fence, including after restart. Successful completion releases
  it; uncertain effects require explicit exact receipt/generation inspection/release.
- Reset advances generation under the same profile ID/default/assignment, removes
  only the owned exact old resources and creates a fresh provider volume/instance.
  Selected provider operations serialize against provider selection/installation and
  pin the observed connection through mutation. Other mounts block deletion.
- Site-data selection is exact HTTP(S) origins and category names. Use
  `Storage.clearDataForOrigin` for local storage, IndexedDB, WebSQL, file systems,
  service workers and, separately, origin CacheStorage. Cookie selection binds exact
  observed domain/path/partition identities; domain cookies are inherently shared
  across matching subdomains/ports and this is disclosed. Cookie values never enter
  plans/receipts. Check post-command cookie absence and quota usage; native writers
  can recreate data and quota does not measure local-storage values completely.
  No automatic navigation/sign-in; a temporary owned blank CDP target is closed.
- Refuse persisted history selection and never call whole-browser cache/cookie clear
  or substitute tab navigation-history reset. HTTP cache/history require whole-profile
  reset or a separately approved future native capability, not an external patch here.
- Resolved handoff messages/notes/issues redact; IDs, target/controller/profile,
  outcomes, timing and permanent request/action digests survive. Open handoffs block.
  Screenshots and live control URLs are not stored in this ledger. No inferred
  completion, human approval or erasure of upstream/caller copies.
- Orphan volumes must pass the exact Stack name/role/session/lease tags, have no
  Backend receipt (including incomplete/disposable leases) and no provider mount.
  Recheck exact resource before deletion and verify absence. Foreign volumes are
  not listed. Provider failure is unavailable, never an empty inventory.
- All controls require local operator authority, are excluded from MCP and refused
  through remote Access. Maintain existing wire types; new UI is a separate handoff.

## Consequences

Individual scopes stay honest about shared cookies, native writers, incomplete
recovery and external backups. No real VM/browser start or provider/image change is
needed for automated verification: fake provider and CDP boundaries exercise the
owner's actual plan/admission/receipt/recovery paths.
