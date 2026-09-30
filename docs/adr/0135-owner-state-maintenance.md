# 0135 — Owner state inspection and maintenance

Status: Accepted

## Context

Stopping a Bot does not reset its sanctioned conversation or remove its workspace.
Dismissal, cancellation, identity removal, payload clearing and settings application
have different effects throughout Stack. A filesystem or database can also contain
several owners' content and retry evidence. Removing rows indiscriminately can
redispatch paid inference, adopt an old conversation or erase shared Work.

## Decision

Every Package API declares an owner-wide `<package>_state_read`. The Server's
`serve_state_list` aggregates live socket inventories and reports unavailable owners
explicitly; it never constructs their contexts. Inventories disclose ownership,
authority, sensitivity, retention, regeneration, coverage and operation links.
Filesystem byte observations are bounded; they are not logical record counts, and
overlapping/shared storage must not be summed as unique storage.

New state controls belong to local operator authority. MCP exposure excludes them;
Access excludes them from remote UI even when an operation is read-only. Explicit
operator Proc authority follows the existing trusted-local invocation contract.
Package manifests select local WebSocket operations independently of MCP. Access
itself retains its existing local-only administration boundary.

Cleanup is performed by each owner through exact, expiring plans. Application binds
the selected revision, resource identity and request UUID. A durable receipt
records completed, partial or unknown effects and retained copies. Retrying an
identical request returns that receipt; an interrupted admission never silently
executes again. Same-database synchronous effects and receipts commit atomically.
Filesystem effects commit admission first and can report partial/unknown outcomes.

Bot state maintenance shares its lifecycle serialization and requires a verified
stopped Bot plus available Worker, Browse, Proc and Server dependency evidence.
Unresolved cleanup retains a durable start fence. Reset changes the sanctioned
root binding and conversation-generation namespace together; old roots cannot be
adopted on restart. Retired histories remain separately attributed. Pending Stack
queue deliveries are cancelled; sent/unknown admission evidence is retained.
Only ledger-owned workspaces are eligible for clearing. Supplied workspaces can
be inspected but carry no Stack deletion authority.

Bounded file operations use descriptor-relative POSIX opens, renames and removals
through an isolated Python 3 interpreter because Node does not expose the required
macOS primitives. Symlink components and special files are refused; selection
snapshots fence file identity and revision. Deletion retires selected roots into a
private quarantine before removal. Missing capabilities fail explicitly.

Payload clearing preserves admission identities, original intent digests and
terminal authority/outcomes where these prevent replay. Unknown remains unknown.
Signal clears its whole captured-content scope because source reads and inference
contexts can span conversations; it retains source cursors, suppression identities
and Infer correlation. Collection items and finalized upload stages independently
retain CAS references. HUD retired-focus removal preserves shared semantic Work.

## Consequences

The maintained operation matrix and residual coverage live in
[`../state-control.md`](../state-control.md). An inventory link may require exact
resource selection before it is callable. An empty action list is not blanket
deletion permission. Provider-native, client-local and externally retained copies
need their own lifecycle authorities. Logical payload clearing is not secure media
erasure: SQLite pages/WAL, filesystem snapshots, Git history and backups may retain
bytes outside the live API projection.

Existing UI records must reflect cleared content and invalidate cached bodies.
New maintenance UI is an explicit separate task, with owner-specific workflows
rather than a global recursive-delete control.
