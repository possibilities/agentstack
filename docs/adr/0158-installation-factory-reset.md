# 0158 — Installation factory reset

## Status

Accepted, 2026-10-01, following human-approved F1–F6. Extends
[0135](0135-owner-state-maintenance.md) and the scope boundaries in
[0153](0153-exact-worker-state-maintenance.md),
[0155](0155-exact-browser-provider-maintenance.md),
[0156](0156-content-retention-and-publication-maintenance.md) and
[0152](0152-independent-client-bootstrap-and-ui-handoffs.md).
Does not implement the proposed device protocol in
[0157](0157-device-local-clear-request-and-receipt.md).

## Context

Individual maintenance deliberately preserves owner replay and identity evidence.
Returning the whole installation to first-run defaults requires different authority:
ending owned work, deleting credentials/configuration, rotating Access identity and
data generation, and safely stopping the Server before removing its open databases.
A receipt cannot live exclusively in the data it deletes.

## Decision

- Serve owns `serve_factory_reset_plan({scope:"installation"})` and
  `serve_factory_reset_clear` with an exact plan/revision/request UUID, literal
  `confirmation:"factory-reset"` and `externalWritersQuiesced:true`. The latter is
  the operator's declaration, not proof of arbitrary external process absence.
  Scope binds installation directory incarnation, generation, Access identity and
  exact account/keychain, linked Worker worktree and Browser provider identities.
  Ordinary owner data changes before quiescence are included in the whole generation;
  changed external scope invalidates the plan. Unknown top-level root entries and
  live/unresolved standalone Role launches refuse reset rather than being adopted.
  In-root Hypeman stores/staging also refuse before admission: provider database/disk
  ownership is not inferred from the enclosing Browser directory. Resolve/uninstall
  them explicitly through Browse first; an external selected provider stays outside
  root deletion and only exact recorded resource IDs are removed.
- An exclusive, fsynced sibling `<state>.factory-control/fence.json` precedes
  admission/effects. Shared socket and HTTP gates reject new owner calls, and MCP
  standalone reads and new Server/API/gateway/Role starts also check the fence.
  Only exact reset receipt/retry and narrow lifecycle-drain callbacks may pass.
  Return the durable `running` admission before effects; admission is not completion.
- The live parent closes ingress and observers, then drains owners in dependency
  order. Factory teardown signals lifecycle parents first and requires both process
  group absence and clean owner exit. Forced/error shutdown never licenses data
  deletion. Browse stays alive only for the pinned reset callback, drains controllers
  and removes selected instances before rechecked unmounted volumes. No new provider,
  VM or Browser incarnation is provisioned by factory inspection/cleanup.
- Auth removes only exact profile-reserved native keychain items after runtime
  shutdown. Worker verifies recorded linked-worktree/source/branch/incarnation claims
  before Git removes each worktree; source checkouts, branches, commits and retained
  refs stay. Foreign/unattributed provider resources are not adopted. Standalone
  native profiles/writers and independent Client service/login state are outside
  parent lifecycle authority.
- Content relocates the exact old Vault and owned Git directory to
  `<state>.retained-git/<requestId>/vault`, disclosing its content retention. This is
  not Git rewriting, copying, publishing or reconciliation. Linked/external Git
  metadata refuses deletion. The next active Vault begins empty, not imported from
  that retained copy. Unretained `.git` and cleanup quarantines elsewhere block.
- After verified teardown and owner cleanup, descriptor-relative POSIX maintenance
  clears active state with bounded snapshots and mount/special-file refusal. Sync
  the empty installation directory before atomically completing the receipt and
  reserving the next generation. Accounts, credentials, Roles, settings, owner
  ledgers, local sessions/signing material and Access identity in active state are
  removed. New Access identity is created only on a later explicit owner start;
  old destination-bound shares/clients never retarget or automatically pair.
- The private sibling control SQLite ledger holds content-free plan scope metadata,
  request digests, generation identities and receipts with full synchronous durability.
  `serve_factory_reset_receipt_get` reads it cold without creating erased contexts.
  `serve_factory_reset_recover` requires definitely absent writer PID and only marks
  interrupted admissions unknown. It never resumes effects. PID reuse/unknown
  liveness remains conservatively blocked. A crash before receipt insertion leaves
  an unexplained fence, not permission to replay.
- Successful reset also leaves its startup fence intact. Only
  `serve_factory_reset_fence_release` for the exact completed request/new generation,
  definitely absent reset-writer PID and still-empty installation releases it. It
  starts nothing and never releases partial/unknown reset outcomes. Cold operations
  use the same typed handlers through `stack serve factory-reset-control`.
- Factory operations/callbacks are private-socket-only, excluded from MCP and local
  WebSocket, and independently refused by remote Access selection. No new UI,
  remote reset, device signing/enrollment or external upstream patch is supplied.

## Consequences

Reset is destructive to active state and can explicitly stop owned work, but is
not secure media erasure or completion of HUD Work. Unknown native outcomes remain
unknown even when a new installation generation is permitted. Devices, Canvas,
independent Client host, personal native histories/keychains, external service/TLS/
Tailscale configuration, source/retained Git and backups remain independent copies.
Managed toolchain files inside active state may be removed; external installed
binaries and personal installations are not swept.

External writers must be quiesced by the caller; local fences and Git/provider
rechecks do not create a global OS lock. Interrupted effects preserve their exact
receipt/fence and require inspection, not automatic retry. Oversized file trees,
unsafe roots/mounts, unresolved owner teardown/claims and unavailable providers can
refuse or leave a partial/unknown reset. Tests exercise disposable states, real
owned Node lifecycle processes and fake native/provider resources only.
