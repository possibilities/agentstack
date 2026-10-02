# 167. Canvas destination isolation

Status: accepted, 2026-10-02. Part of the Client program (M8c): the Canvas may now be opened against a
local server or, remotely, against another ([ADR 0101](0101-remote-uix-through-access.md),
[ADR 0152](0152-independent-client-bootstrap-and-ui-handoffs.md)), and a platform root can be reset or
replaced while the same browser origin keeps answering. It adds no window, control or operation to the UI,
and one read-only field to `serve_status`.

## Decision

**A Canvas destination is `{serverId, authority, origin}`.** `serverId` is the stable installation identity
the Access connection descriptor already pins devices to: the Access instance UUID. `authority` is `local`
(trusted loopback render) or `remote` (an Access-authenticated viewer). `origin` is the origin the page was
served from, as the proxy admitted it: the loopback `Host` for a local render, the signed
`x-stack-ui-origin` for a remote one. The Canvas never derives, guesses or persists an identity.

**The server names itself in `serve_status.serverId`.** `serve` reads the Access instance UUID from the Access
store without writing it (the same read the factory-reset inspection already makes), and reports `null` until
Access has created its store. A local render reads it with its other trusted-local reads, so the first
snapshot already carries the destination. A remote render never executes trusted-local reads; its destination
starts with `serverId: null` and completes when the scoped gateway answers `serve_status`. A status that names
nothing changes nothing. The first name completes the destination in place; a different one later means
another platform now answers at this origin and is never adopted in place (see below).

**Every persisted Canvas key lives in one namespace.** All browser storage goes through `ScopedStorage`
(`lib/stack/destination.ts`), which prefixes `stack.destination.<serverId>.<authority>.<origin>.` and
percent-encodes the origin including its dots, so one destination's prefix cannot match another's keys. The
short names inside it are:

| name | holds |
| --- | --- |
| `uix.bench.v2.<space>` | each space's window arrangement and camera |
| `uix.docks.v1`, `uix.inspector.v1` | dock sizes and the inspector pin |
| `uix.chats.v1`, `uix.workers.v1`, `uix.proc.v1`, `ui.hud.v1`, `uix.browse-viewers.v1` | window arrangements and selections |
| `uix.roles.v1`, `uix.signal.author.v1` | last Role edited, last feedback author |
| `uix.notify-compose.v1.<endpoint>` | the Compose draft and its exact uncertain send |
| `state-flow.<key>` | unconfirmed maintenance requests (identity strings only) |
| `worker-catalog-held.v1` | Worker catalog discovery fences |
| `source-setup.create`, `source-setup.requests.<receiver>` | Source receiver creation and hook-request journals |
| `uix.browse.intent.<handoff>` (sessionStorage) | a Browse take or finish and its exact retry arguments |

**Until the destination is complete, persistence is inert.** There is no storage object: stores are
detached, nothing is read or written, and nothing is recovered or dispatched from a record. Compose stays
unready and says why; the Source journal and the Browse intent refuse to record, so what they guard is not
sent; a state flow neither saves nor recovers; the bench, docks and inspector keep working in memory. Implicit
Worker catalog discovery waits until its saved fences have been read. When the destination completes,
storage attaches and each view reads its own destination once, keeping what was done meanwhile unless that
destination saved something.

**A different server replaces the tree.** `StackProvider` keys its tree by an epoch. When the store reports
a different identity, the tree is rebuilt from a blank snapshot (resources empty, endpoints kept): no loaded
data, draft, queued work, recovery record or connection carries across, and a record stays in the namespace that wrote it.
A stored request is never sent to a server other than the one that recorded it.

**Records written before this are quarantined.** Unqualified `stack.uix.*`, `stack.ui.*`,
`stack.state-flow.*`, `stack.source-setup.*` and `stack.worker-catalog-held.*` keys name no platform. They
are not read, not migrated by inference (the single-bench `stack.uix.bench.v1` upgrade is retired), not
shown and not cleared by the Canvas, and no notice is added. They sit in the browser until a deliberate
device clear ([device state contract](../device-state-clear-contract.md)).

**Hydration is unchanged.** The first client render matches the server render: the destination comes from
the snapshot, the storage objects are wrappers that touch the browser only when used, and every read happens in an
effect after mount, as the earlier hydration fixes require.

## Not decided here

This is not authority and not a secret: a script on the origin can read the namespaces, and Access remains
the permission boundary. It does not fence other tabs beyond the existing per-record checks. A server that
cannot name itself (an older build, or an Access store not yet created) keeps nothing between loads;
that is deliberate, not an error. Replacing the tree resets the Shell's in-page location to the one the page
was served for.

## Verification

`test/destination.test.mjs` covers the identity, the namespace and its escaping, cross-destination isolation,
legacy quarantine, detached stores, recovery and journals, catalog fences and the store's adoption of a name.
`test/destination-browser-check.mjs` serves two disposable platform roots one after another from the same origin and
port against one browser profile and shows that neither sees the other's bench arrangement, inspector
pin, Compose draft or unconfirmed request, that an unnamed server writes nothing, and that the same installation
restores its own. `packages/serve` tests cover `serve_status.serverId` against `access_snapshot`.
