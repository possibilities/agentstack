# 138. Owner maintenance in existing spaces

Status: accepted, 2026-09-30. Uses the shared flow of [ADR 0136](0136-system-state-view-and-shared-maintenance-flow.md) for the owners of [ADR 0135](0135-owner-state-maintenance.md).

## Decision

Each owner's shipped maintenance appears where that owner's records already live. Every control is local-only and follows the live WebSocket selection. Each control calls only that owner's named operations.

- **Signal**: clears all captured content as one scope, gated on processing being paused. The plan also waits for reads and inference to drain. Its correlated Infer request IDs form a separate, explicit Infer selection. Clearing Signal never cascades into Infer.
- **Lab Infer**: selects up to 100 terminal requests; running and already-cleared requests cannot be selected.
- **Inbox**: in the dismissed view, selects dismissed notifications that still hold content. Clearing never answers anything, and the original outcome stays.
- **Content**: a Storage window lists upload stages, each retired at its exact revision. It also lists collection blobs one digest prefix at a time with their item and stage references. Only unreferenced blobs can be selected for a collection plan. Vault, Artifacts and Git are separate stores.
- **Proc**: a terminal run can clear its output, and a finished execution can clear its captured content. Each is one exact record. A completed output clear remounts the run's log.
- **Accounts Usage**: clears exact account/scope pairs and, separately, the Grok Bot observation. Provider quota, billing and credentials are untouched.
- **HUD**: a retired-root Chat focus can be removed from the item's focus list. The Resources window also lists every retired-root focus, including saved "no focus" rows that no item shows.
- **Workers**: a read-only Files tab shows the retained worktree. Close, remove and discard remain the lifecycle controls.
- **Xcom**: lives in System, since it has no space of its own. The window shows status and a persistent pause. Because Xcom publishes no events, a paused sync is re-read every two seconds for at most a minute until it drains. Post removal requires explicit reimport and orphan-author choices; checkpoint reset states that scanning resumes and may spend again.
- **System State**: each owner links to the space holding its existing controls. The owner groups state the maintained backend gaps as unsupported and offer no controls for them.

A completed receipt empties the selection it applied to. A partial or unknown receipt keeps the selection for inspection.

## Consequences

Owners without shipped maintenance keep their existing domain controls, such as Brain deletion, Browse profiles, Roles edits, Auth removal and Access revocation. Device-local state still needs its own client contract.
