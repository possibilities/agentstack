# 139. Owner maintenance in existing spaces

Status: accepted, 2026-09-30. Uses the shared flow of [ADR 0136](0136-system-state-view-and-shared-maintenance-flow.md) for the owners of [ADR 0135](0135-owner-state-maintenance.md).

## Decision

Each owner's shipped maintenance appears where that owner's records already live. Every control is local-only and follows the live WebSocket selection. Each control calls only that owner's named operations.

- **Signal**: clears all captured content as one scope, gated on processing being paused. The plan also waits for reads and inference to drain. Its correlated Infer request IDs form a separate, explicit Infer selection. Clearing Signal never cascades into Infer.
- **Lab Infer**: selects up to 100 terminal requests; running and already-cleared requests cannot be selected.
- **Inbox**: in the dismissed view, selects dismissed notifications that still hold content. Clearing never answers anything, and the original outcome stays.
- **Content**: a Storage window lists upload stages, each retired at its exact revision. It also lists collection blobs one digest prefix at a time with their item and stage references. Only unreferenced blobs can be selected for a collection plan. Vault, Artifacts and Git are separate stores.
- **Proc**: a terminal run can clear its output, and a finished execution can clear its captured content. Each is one exact record. A completed output clear remounts the run's log. A removed schedule's detail ends in a Maintenance disclosure that redacts its stored definition (action input, or process arguments, environment and working directory) and then shows when, with the retained spec digest. Active and Brain-protected schedules are refused by the plan; captured executions are separate selections.
- **Fleet queue**: a Bot's Queue view lists each admission's original size, digest, generation and cleared marker. Its Maintenance disclosure, which also reveals the row checkboxes, clears queued message bodies for exact terminal entries (at most 100) or for one retired generation of this incarnation. An unknown admission stays unknown and is never a retry; entries recorded without a generation can only be selected by ID.
- **Lab Infer catalog**: a Maintenance disclosure evicts model observations from the server's memory for the chosen account or for all accounts. It is a direct action with an inline two-step confirm, not a plan: the catalog is derived and keeps no receipt. Clearing never discovers anything, and once the catalog was cleared in the Lab, choosing an account no longer discovers its models either; Discover models is the only way back.
- **Accounts Usage**: clears exact account/scope pairs and, separately, the Grok Bot observation. Provider quota, billing and credentials are untouched.
- **HUD**: a retired-root Chat focus can be removed from the item's focus list. The Resources window also lists every retired-root focus, including saved "no focus" rows that no item shows. An item's detail ends in a collapsed Maintenance disclosure that clears stored text, either journal bodies or the item and journal as a permanent tombstone, for the item alone or for its whole subtree (at most 100 items in one plan). The scope is chosen explicitly; open Worker admissions and live Chat focus block the plan, which the shared review lists. Identity, hierarchy, state and dependency IDs stay, and nothing here completes, cancels or reopens work. The item, tree and timeline show "Content cleared" in place of cleared text; a tombstone is read-only, and the timeline re-reads from the start when the item's content generation advances.
- **Workers**: a read-only Files tab shows the retained worktree. Close, remove and discard remain the lifecycle controls.
- **Xcom**: lives in System, since it has no space of its own. The window shows status and a persistent pause. Because Xcom publishes no events, a paused sync is re-read every two seconds for at most a minute until it drains. Post removal requires explicit reimport and orphan-author choices; checkpoint reset states that scanning resumes and may spend again.
- **System State**: each owner links to the space holding its existing controls. The owner groups state the maintained backend gaps as unsupported and offer no controls for them.

A completed receipt empties the selection it applied to. A partial or unknown receipt keeps the selection for inspection.

Maintenance 01 (HUD, Fleet queue, Proc schedules, Lab catalog) sets the shape later slices follow. The control sits in a collapsed Maintenance disclosure at the end of the record it affects, never as a window or a top-level button, and it opens itself while a flow is past idle so a retained receipt is never hidden. It is offered only when the plan, apply and receipt operations are all on the live WebSocket selection, and never remotely. Selections freeze while a flow is past idle, and each flow has one recovery slot per subject and action. Copy says what is cleared and what stays, and uses "Clear", "Redact" and "Tombstone", never "delete" or "complete".

## Consequences

Owners without shipped maintenance keep their existing domain controls, such as Brain deletion, Browse profiles, Roles edits, Auth removal and Access revocation. Device-local state still needs its own client contract.
