# State inspection and maintenance

Stack separates state by its owning Package API. Start with `serve_state_list`
over the local Server socket or local WebSocket; follow its owner reads to select
exact resources. `docs_snapshot` is the executable authority for operation inputs,
outputs and transport selections. [ADR 0135](adr/0135-owner-state-maintenance.md)
records the lifecycle and retry decisions.

## Inventory contract

All 18 Package APIs expose `<package>_state_read`. `bots_state_read` inventories the
owner; `bot_state_read({botId})` drills into one Bot incarnation.

An entry carries `ownerPackage`, `subject`, `kind`, `authority`, `location`,
`ownership`, `revision`, `observedAt`, `coverage`, nullable `items`/`bytes`,
`sensitivity`, `relationships`, `reads`, `actions`, `retention`, `regeneration` and
`issues`. A null byte/item count means unmeasured, not zero. Owner-wide inventories
are category maps, not logical-row censuses. `measure:true` scans at most 2,000
filesystem entries per category. Shared or overlapping stores must not be summed.

Inventory pages accept `offset`, `limit` (1–100) and optional `revision`. Pass the
first revision on continuations; changed observations require starting again.
`serve_state_list` also accepts an optional `owners` selection and returns each
owner's availability. Unavailable owners are gaps, not empty stores. Operation
links with empty arguments describe a drill-down; consult that operation's schema
and choose an exact resource before invoking it.

These controls are excluded from MCP and remote Access UI. Internal Bot dependency
reads are socket-only. Local operator schedules retain their existing authority.

## Plan and receipt protocol

1. Read the owner and choose an exact scope. Stop/pause and drain resources using
   their existing lifecycle controls where required.
2. Call the owner's plan operation. Inspect `resources`, `blockedBy`, `retained`
   and `regeneration`. Plans expire after one hour.
3. Apply with `{planId, expectedRevision: plan.revision, requestId}`. Bot applies
   additionally require `botId`. Preserve that UUID and identical input when a
   response is lost. A changed selection requires a new plan and request.
4. Read `<owner>_state_receipt_get` (Bot uses singular `bot_…`) after uncertainty.
   Status is `running`, `completed`, `partial`, `blocked` or `unknown`; inspect the
   per-resource `outcomes`. A completed receipt covers only its declared scope.
5. Refresh affected reads. Native file writers may not emit Stack events.

One plan can be admitted only once, even under a different request UUID. Repeated
identical requests return the original result, including after restart. Database
payload cleanup commits its receipt with its effects. Filesystem cleanup persists
admission before touching bytes and never automatically retries an interrupted
mutation. Receipts keep minimal identities/digests and disclosed residuals.

File listing is bounded at 10,000 siblings/selection entries; file reads return
base64 bytes in chunks no larger than 256 KiB. Paths are relative, cannot traverse
symlinks or parent components, and cannot read special files. Clearing refuses
mounted-filesystem boundaries. It requires Python 3 with POSIX descriptor-relative
operations and never falls back to path-based recursive removal. Partial cleanup
can retain `.stack-clear-<uuid>` quarantine, named in the result for inspection.

## Implemented operations

| Owner | Inspection / selection | Maintenance and effect |
| --- | --- | --- |
| Bots | `bot_state_read`, `bot_workspace_list/read`, `bot_history_list`, `bot_queue_history`, `bot_launch_read`, `bot_log_read`, `bot_recovery_list`, `chat_upload_list/read` | `bot_state_plan` selects `workspace_clear`, `session_reset` with `history:retain/purge`, `history_clear` of one retired generation, `log_clear`, `launch_args_clear`, `upload_remove` or `recovery_discard`. Apply through corresponding `bot_<kind>`. |
| Serve | `serve_state_list`, `serve_subscription_list/get` | `serve_subscription_remove` uses exact ID/revision. Pending reads are aborted; already admitted native input cannot be recalled. |
| Worker | Existing status/detail/transcript/turn/record/tool/diff reads; `worker_workspace_list/read` | Existing `worker_close` and `worker_remove` remain the removal authority. Worktree deletion requires explicit discard; source branch and provider-native history are distinct. |
| Infer | Existing request list/get and trace export | `infer_history_plan({requestIds})` / `infer_history_clear`: terminal input, instructions, output, errors and events; preserve request digest, account/model/usage/timing and outcome. |
| Notify | Existing notification list/get/counts | `notification_history_plan({ids})` / `notification_history_clear`: dismissed authored content/actions/prompts/responses/source/group; preserve send/dismissal digests and first outcome. |
| Proc | Existing schedule, execution, run and output reads | `proc_history_plan` / `proc_history_clear`: exact `run_output` or `execution_content` selection. Active work blocks; cursor gap/truncation and authority/outcome survive. Protected Brain source schedules remain Brain-controlled. |
| Signal | Existing message/run/evidence reads; `attention_infer_requests` pages correlated Infer request IDs | `attention_history_plan({scope:"all-captured-content"})` / `attention_history_clear`: paused and drained captured content, including cross-conversation source blobs and partial buffers. Retain suppression/cursors/identities and Infer correlation. |
| Content | `blob_stage_list`, `content_blob_list` alongside existing item/document/Artifact reads | `blob_stage_abort` retires a stage UUID/client key at its revision. `content_storage_plan({digests})` / `content_storage_collect` collects exact unreferenced collection CAS blobs. Items and finalized stages independently hold references. Existing Artifact `gc` is a separate store. |
| Usage | `usage_snapshot` | `usage_observations_plan({accounts:[{id,scope}],grokBot})` / `usage_observations_clear`: exact local observations; fence selected in-flight collectors and persist. Future collection regenerates; provider quota/credentials are independent. |
| Xcom | Existing archive/status/user/article reads; status includes `paused` | `xcom_control({paused})` persistently pauses/resumes admission. `xcom_history_plan` / `xcom_history_clear` selects posts with reimport/orphan-author policy, article attempts, or one scan checkpoint. Pause and wait for `sync.running:false`. Source rows/raw/FTS clear together. |
| HUD | `work_focus_list` includes retired roots | `work_focus_retire_plan({target})` / `work_focus_retire` removes one proven retired-root focus. Active-root focus uses existing `work_focus_set`; saved null is an inheritance barrier. Work/journal/Worker associations remain. |
| Brain | Owner inventory links existing research, jobs, source, reveal and maintenance reads | Existing document `delete`, job cancel/exclude and source pause remain the domain authorities. Document deletion redacts associated intents and collects unreferenced Artifacts. |
| Browse | Owner inventory links profiles, controllers and handoffs; provider volume coverage is explicit | Existing profile deletion, controller closure, handoff completion/cancellation and installation lifecycle operations. Profile deletion enforces default/controller/handoff restrictions and calls the native provider. |
| Auth / Access | Credential-metadata inventories link existing account/client snapshots | Existing account removal/reconciliation and Access revocation. Account removal can cascade; revocation retains identity/admission history. State inventory reveals no bearer values. |
| Roles | Catalog, injection-storage and external-shim inventory | Existing granular catalog edits/deletion and hash-fenced shim deletion. A current Role preview is not a retained launch snapshot. |
| Scrape | Owner inventory links extraction, preset, check and scrape-to-file queue reads | No new queue or corpus cleanup; publication recovery and generation claims retain their existing lifecycle authority. |
| API | Reference/discovery inventory | Derived discovery is regenerated from manifests, typed operations and live metadata. |

### Bot lifecycle details

Bot maintenance requires available dependency inventories from Worker, Browse,
Proc and Serve. Close active Workers/processes, disable old-root schedules, close
controllers/resolve handoffs, remove event subscriptions and end voice explicitly
as reported by the plan. Identity and generation bind a plan across removal/reuse
of a human-readable Bot ID.

Dependency reads describe known Stack resources at observation time. They do not
lock arbitrary external processes or a concurrently issued local operator action;
filesystem snapshots additionally fence the selected file versions. Quiesce other
writers to the selected paths before applying a plan.

Reset retains Bot/account/workspace/settings identity while atomically retiring
the sanctioned root and advancing its history namespace. The next turn binds a
new root; server startup still autostarts recorded Bots. Legacy shared history is
labelled shared and cannot be purged wholesale. Pending Stack queue entries become
cancelled; original queued bodies and sent/unknown admission evidence remain.
Signal, Infer, HUD, Worker and Browser copies are independent owner state.

Partial or interrupted maintenance leaves `maintenanceRequestId` in `bot_state_read`
and prevents start or upload mutation. After inspecting the receipt and exact
resources, `bot_state_fence_release({botId,requestId,expectedGeneration})` releases
that fence; it does not turn an unknown result into a completed one. Upload removal
also retires its UUID for that Bot incarnation, preventing content resurrection
through an old upload retry. Recovery discard can lose the only unreconciled
credential refresh and is therefore a separate exact selection.

### Existing-reader truthfulness

Infer and Notification records expose `contentClearedAt`; Signal exposes
`contentGeneration` and cleared message/run markers. Existing UI reads invalidate
captured bodies and distinguish cleared content. Signal replay of cleared content
is refused; correlated Infer requests remain selectable for separate cleanup.
Native completion never changes HUD Work state.

## Coverage boundaries

The following remain explicit backend gaps rather than implied erase controls:

- Worker in-place Git reset, native-session reset/purge, transcript-only purge,
  retained-branch collection and catalog-only clearing.
- Browser default-profile reset, origin/category site-data clearing, resolved
  handoff redaction and orphan-volume collection.
- Brain terminal jobs without documents, source removal/checkpoint reset,
  terminal Run/recovery payload clearing and stranded-Artifact collection.
- Scrape queue cancel/retry/discard and corpus/session-state maintenance; live
  generation claims and publication recovery must remain authoritative.
- Roles retained injection-launch cleanup, standalone settings-receipt retirement,
  Auth cache-only clearing and Access history/session-specific retirement.
- HUD Work/journal body purge, Bot queued-body purge, Signal checkpoint reset,
  Infer catalog-only clearing and Proc removed-schedule payload redaction.
- Content vault/Git-history purge and temporary publication collection. Document
  and Artifact tombstones, local Git, remotes and backups retain independent copies.
- Client-local Canvas layouts/drafts and Chrome/Android outboxes/history. Device
  state is destination-bound; server maintenance cannot delete browser/device storage.

Filesystem sizes do not imply complete provider attribution. Logical database
clearing does not guarantee byte erasure from SQLite free pages/WAL, snapshots or
backups. Full-installation identity/data-generation reset is a separate operation
requiring coordinated Access and device receipt semantics.
