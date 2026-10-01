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
symlinks or parent components, and cannot read special files. The owner's root is
opened in one kernel call: ancestor symlinks (such as macOS `/tmp`) resolve, but the
root itself must be a directory, not a symlink, and cannot contain dot components.
Plans bind the root's identity, so a re-pointed ancestor makes the plan stale. Clearing refuses
mounted-filesystem boundaries. It requires Python 3 with POSIX descriptor-relative
operations and never falls back to path-based recursive removal. Partial cleanup
can retain `.stack-clear-<uuid>` quarantine, named in the result for inspection.

## Implemented operations

| Owner | Inspection / selection | Maintenance and effect |
| --- | --- | --- |
| Bots | `bot_state_read`, `bot_workspace_list/read`, `bot_history_list`, `bot_queue_history`, `bot_launch_read`, `bot_log_read`, `bot_recovery_list`, `chat_upload_list/read` | `bot_state_plan` selects `workspace_clear`, `session_reset` with `history:retain/purge`, `history_clear` of one retired generation, `queue_bodies_clear` with exact IDs or an attributed retired generation, `log_clear`, `launch_args_clear`, `upload_remove` or `recovery_discard`. Apply through corresponding `bot_<kind>`. Terminal queue clearing retains original bytes/digest, destination and sent/unknown/cancelled outcome; pending/dispatching blocks. |
| Serve | `serve_state_list`, `serve_subscription_list/get`, `serve_settings_read`, enabled-only `serve_harness_releases` | `serve_subscription_remove` uses exact ID/revision. Pending reads are aborted; already admitted native input cannot be recalled. `serve_settings_update` uses the observed revision and applies developer mode immediately; disabling aborts/fences release checks while retaining observations. |
| Worker | Existing status/detail/transcript/turn/record/tool/diff reads; `worker_workspace_list/read` | Existing `worker_close` and `worker_remove` remain the removal authority. Worktree deletion requires explicit discard; source branch and provider-native history are distinct. |
| Infer | Existing request list/get, trace export and `infer_model_list` | `infer_history_plan({requestIds})` / `infer_history_clear`: terminal input, instructions, output, errors and events; preserve request digest, account/model/usage/timing and outcome. `infer_catalog_clear({accountIds?})` evicts exact account observations (omitted means all), aborts/fences discovery and never refreshes or dispatches inference. Already dispatched inference is untouched. |
| Notify | Existing notification list/get/counts | `notification_history_plan({ids})` / `notification_history_clear`: dismissed authored content/actions/prompts/responses/source/group; preserve send/dismissal digests and first outcome. |
| Proc | Existing schedule, execution, run and output reads | `proc_history_plan` / `proc_history_clear`: exact `run_output`, `execution_content` or removed `schedule_definition` selection. Active work blocks; protected Brain source schedules refuse. Schedule action input, argv, env and cwd redact with `contentClearedAt` and a spec digest; ID/authority/label/target/revision/timing stay. Captured executions and process summaries remain separate copies. |
| Signal | Existing message/run/evidence reads; `attention_infer_requests` pages correlated Infer request IDs | `attention_history_plan({scope:"all-captured-content"})` / `attention_history_clear`: paused and drained captured content, including cross-conversation source blobs and partial buffers. Retain suppression/cursors/identities and Infer correlation. |
| Content | `blob_stage_list`, `content_blob_list` alongside existing item/document/Artifact reads | `blob_stage_abort` retires a stage UUID/client key at its revision. `content_storage_plan({digests})` / `content_storage_collect` collects exact unreferenced collection CAS blobs. Items and finalized stages independently hold references. Existing Artifact `gc` is a separate store. |
| Usage | `usage_snapshot` | `usage_observations_plan({accounts:[{id,scope}]})` / `usage_observations_clear`: exact local observations; fence selected in-flight collectors and persist. Future collection regenerates; provider quota/credentials are independent. |
| Xcom | Existing archive/status/user/article reads; status includes `paused` | `xcom_control({paused})` persistently pauses/resumes admission. `xcom_history_plan` / `xcom_history_clear` selects posts with reimport/orphan-author policy, article attempts, or one scan checkpoint. Pause and wait for `sync.running:false`. Source rows/raw/FTS clear together. |
| HUD | `work_focus_list` includes retired roots; Work/tree/timeline and metadata reads expose redaction markers | `work_focus_retire_plan({target})` / `work_focus_retire` removes one retired-root focus. `hud_history_plan({items,scope})` / `hud_history_clear` redacts exact `journal_bodies`, or tombstones `item_and_journal` including metadata. Retain hierarchy/state/dependency IDs; require retained children first or explicit subtree selection. Open descendant Worker admissions and active-root focus block. Worker-captured context stays independent. |
| Brain | Research/jobs/source reads, audited `jobs_reveal`; job/Run `content_cleared_at`, Run `payload_digest`, source `removed_at` and `checkpoint_generation` | `brain_jobs_plan({ids,scope:"payload"})` / `brain_jobs_clear` for terminal jobs without indexed documents; `brain_runs_plan` / `brain_runs_clear` for terminal drained Runs including captured recovery jobs, retaining immutable authorization. `brain_source_plan({id,action:"remove"\|"checkpoint_reset"})` / `brain_source_clear` requires paused/drained source and protected Proc observation. `brain_artifacts_plan({digests})` / `brain_artifacts_clear` fences every live reference before collecting exact stranded objects. `brain_state_receipt_get` reads any receipt. Existing document deletion/cancel/exclude remain separate authorities. |
| Browse | Owner inventory links profiles, controllers and handoffs; provider volume coverage is explicit | Existing profile deletion, controller closure, handoff completion/cancellation and installation lifecycle operations. Profile deletion enforces default/controller/handoff restrictions and calls the native provider. |
| Auth / Access | Credential-metadata inventories link existing account/client snapshots | Existing account removal/reconciliation and Access revocation. Account removal can cascade; revocation retains identity/admission history. State inventory reveals no bearer values. |
| Roles | Catalog, injection-storage and external-shim inventory | Existing granular catalog edits/deletion and hash-fenced shim deletion. A current Role preview is not a retained launch snapshot. |
| Scrape | `scrape_queue_list` includes any `maintenanceFence`; `scrape_corpus_list({preset})` lists final local capture IDs | `scrape_queue_plan({ids,action:"cancel"\|"retry"\|"discard"})` / `scrape_queue_apply`: cancel pending-only, retry failed under a new generation, discard failed or receipt-retired remaining files. Native claims/publication recovery block. `scrape_corpus_plan({captures:[{preset,id}]})` / `scrape_corpus_clear` selects exact final overlay IDs, not shipped fixtures. `scrape_state_receipt_get` retains partial/unknown admission and planned retry names. External destination files never clear. |
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
cancelled; original queued bodies remain until separately selected for
`bot_queue_bodies_clear`. Sent/unknown admission evidence always survives that clear.
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

Serve's `settings` category inventories `serve/settings.json`; `harness-releases`
inventories `serve/harness-releases.json`. The global developer-mode default is
disabled. Release observations survive disable and restart; restored evidence is
explicitly stale until verified. Enabled sampling or an explicit enabled check
can regenerate observations, but the previous different version is retained
history, not a reconstructible installed-version comparison. No global-settings
reset or release-cache deletion operation is supplied. See
[ADR 0138](adr/0138-developer-mode-and-harness-releases.md).

## Coverage boundaries

The following remain explicit backend gaps rather than implied erase controls:

- Worker in-place Git reset, native-session reset/purge, transcript-only purge,
  retained-branch collection and catalog-only clearing.
- Browser default-profile reset, origin/category site-data clearing, resolved
  handoff redaction and orphan-volume collection.
- Brain collection of missing/corrupt Artifact paths without an exact file snapshot
  remains unavailable. Recovery authorization and source definition/checkpoint history
  are retained authority, not deleted payloads. Backups are separate stores.
- Scrape authenticated browser sessions belong to Browse; unattributed retirement
  quarantine and publication temporaries stay with existing queue recovery. Maintenance
  never breaks live, dead or unresolved claim evidence to make a plan pass.
- Roles retained injection-launch cleanup, standalone settings-receipt retirement,
  Auth cache-only clearing and Access history/session-specific retirement.
- Signal checkpoint reset.
- Content vault/Git-history purge and temporary publication collection. Document
  and Artifact tombstones, local Git, remotes and backups retain independent copies.
- Client-local Canvas layouts/drafts and Chrome/Android outboxes/history. Device
  state is destination-bound; server maintenance cannot delete browser/device storage.

Filesystem sizes do not imply complete provider attribution. Logical database
clearing does not guarantee byte erasure from SQLite free pages/WAL, snapshots or
backups. Full-installation identity/data-generation reset is a separate operation
requiring coordinated Access and device receipt semantics.

Infer catalog eviction deliberately has no StatePlan or durable receipt: it drops
only regenerable in-memory model observations. Epoch fences prevent late discovery
from recreating the selected cache; request identities and trace history remain in
their own durable ledger. It is local-operator-only even though it consumes no spend.

HUD history maintenance advances the item revision/content generation and appends
a content-free maintenance journal entry, invalidating tree pagination and timeline
reads. Journal entries retain sequence, actor, kind, fields, timing and request IDs,
with null redacted edit values and `contentClearedAt`. Item tombstones use `[cleared]`
for title/objective and preserve semantic state, hierarchy and dependency IDs, not
authored links, labels or metadata. They cannot be edited, reopened, focused or used
for new admission; create new Work instead. Journal-only clearing retains current
bodies/metadata and permits new collaboration. Dependency reads fail closed and
describe observed Stack admissions; they do not lock arbitrary external writers.

Bot queue-body plans and receipts use the same owner `StateJournal` protocol,
co-located in `chats.sqlite` so payload removal and the receipt are one SQLite
transaction. Other Bot filesystem plans keep their existing journal and durable
start fence. `bot_state_receipt_get` reads either journal and request UUIDs cannot
be reused across them. New enqueue admissions record their Bot history generation;
legacy rows without attribution remain selectable by exact ID only. Generation
selection never guesses ownership from a thread ID or deletes native queue copies.
Cleared bodies cannot transition to pending/dispatching; identical enqueue retries
return their original terminal admission using the retained digest.
