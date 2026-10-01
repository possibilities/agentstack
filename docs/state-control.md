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
| Installation factory reset (Serve) | `serve_factory_reset_plan({scope:"installation"})`; `serve_factory_reset_receipt_get({requestId})` | `serve_factory_reset_clear` adds literal `confirmation:"factory-reset"` and `externalWritersQuiesced:true` to the shared apply input. Return on admission; parent teardown precedes owner resource cleanup and active-state deletion. New data generation and later Access identity; installation stays stopped/fenced. Exact cold `serve_factory_reset_recover` records dead-writer uncertainty without replay; `serve_factory_reset_fence_release({requestId,expectedGeneration})` permits a later explicit start only after completed reset, absent writer and still-empty root. Private socket only; no MCP/WebSocket/UI control. |
| Worker | Status/detail/transcript/turn/record/tool/diff; `worker_workspace_list/read`; `worker_state_branches` retains recorded branch metadata after Worker removal | `worker_state_plan({ids,kind:"git_reset"\|"transcript"\|"branch"\|"native_session"\|"catalog",allowUnmerged:[]})` / `worker_state_clear`. Closed-only except catalog; reset preserves old tip at `refs/stack/retained/<worker>`. Transcript redaction keeps turn/replay/outcome/usage/settings/Work authority with `contentClearedAt`. Branch collection requires recorded, unreferenced, unchecked-out scope and merge into recorded base or per-branch override. Native purge requires disabled/drained account, idle sign-in and verified exact scope/version. Account-shared catalog clearing fences discovery. `worker_state_receipt_get` covers every kind; existing close/remove remain separate. |
| Bot / Worker settings receipts | Existing `bot_settings_read` / `worker_settings_read` | `bot_settings_receipts_plan({targets:[{id?}],retainDays:7})` / `bot_settings_receipts_clear`; `worker_settings_receipts_plan({targets:[{id?\|provider?}],retainDays:7})` / `worker_settings_receipts_clear`. Exact targets, below current revision and at least seven days old; retain unknown-age legacy rows and permanent minimal intent-digest/revision tombstones. Saved/loaded/native settings never change. Receipts are read through `bot_state_receipt_get` / `worker_state_receipt_get`. |
| Infer | Existing request list/get, trace export and `infer_model_list` | `infer_history_plan({requestIds})` / `infer_history_clear`: terminal input, instructions, output, errors and events; preserve request digest, account/model/usage/timing and outcome. `infer_catalog_clear({accountIds?})` evicts exact account observations (omitted means all), aborts/fences discovery and never refreshes or dispatches inference. Already dispatched inference is untouched. |
| Notify | Existing notification list/get/counts | `notification_history_plan({ids})` / `notification_history_clear`: dismissed authored content/actions/prompts/responses/source/group; preserve send/dismissal digests and first outcome. |
| Proc | Existing schedule, execution, run and output reads | `proc_history_plan` / `proc_history_clear`: exact `run_output`, `execution_content` or removed `schedule_definition` selection. Active work blocks; protected Brain source schedules refuse. Schedule action input, argv, env and cwd redact with `contentClearedAt` and a spec digest; ID/authority/label/target/revision/timing stay. Captured executions and process summaries remain separate copies. |
| Signal | Existing message/run/evidence reads; `attention_infer_requests` pages correlated Infer request IDs | `attention_history_plan({scope:"all-captured-content"})` / `attention_history_clear`: paused and drained captured content, including cross-conversation source blobs and partial buffers. Retain suppression/cursors/identities and Infer correlation. |
| Signal checkpoints | `attention_status` reports `checkpointGeneration` and per-source `checkpointResets` | `attention_checkpoint_plan({sources:["bot:<botId>:<threadId>","worker:<workerId>"]\|"all",mode:"rebaseline"})` / `attention_checkpoint_reset` binds current upstream heads and exact local cursor state. Processing must be paused, first baseline established and all pending/active interpretation drained or separately disposed. Atomic cursor/buffer replacement retains captured content, suppression, Infer correlation, activation and siblings. Reset/resume skips existing messages, not historical replay; later observations may admit inference. |
| Content | `blob_stage_list`, `content_blob_list`, `content_vault_history_plan({slugs,offset?,limit?,revision?})` (read-only exact-slug local ref/reflog commit/blob disclosure), `content_publication_list` alongside item/document/Artifact reads | `blob_stage_abort` retires a stage UUID/client key at its revision. `content_storage_plan({digests})` / `content_storage_collect` collects exact unreferenced collection CAS blobs. `content_publication_plan({ids})` / `content_publication_clear` collects exact dead-writer temporary claims with unchanged incarnations; shares `content_state_receipt_get`. Legacy paths, authority/replay evidence and published/source references remain. Existing Artifact `gc` is a separate store. No Git rewrite or device deletion. |
| Usage | `usage_snapshot` | `usage_observations_plan({accounts:[{id,scope}]})` / `usage_observations_clear`: exact local observations; fence selected in-flight collectors and persist. Future collection regenerates; provider quota/credentials are independent. |
| Xcom | Existing archive/status/user/article reads; status includes `paused` | `xcom_control({paused})` persistently pauses/resumes admission. `xcom_history_plan` / `xcom_history_clear` selects posts with reimport/orphan-author policy, article attempts, or one scan checkpoint. Pause and wait for `sync.running:false`. Source rows/raw/FTS clear together. |
| HUD | `work_focus_list` includes retired roots; Work/tree/timeline and metadata reads expose redaction markers | `work_focus_retire_plan({target})` / `work_focus_retire` removes one retired-root focus. `hud_history_plan({items,scope})` / `hud_history_clear` redacts exact `journal_bodies`, or tombstones `item_and_journal` including metadata. Retain hierarchy/state/dependency IDs; require retained children first or explicit subtree selection. Open descendant Worker admissions and active-root focus block. Worker-captured context stays independent. |
| Brain | Research/jobs/source reads, audited `jobs_reveal`; job/Run `content_cleared_at`, Run `payload_digest`, source `removed_at` and `checkpoint_generation` | `brain_jobs_plan({ids,scope:"payload"})` / `brain_jobs_clear` for terminal jobs without indexed documents; `brain_runs_plan` / `brain_runs_clear` for terminal drained Runs including captured recovery jobs, retaining immutable authorization. `brain_source_plan({id,action:"remove"\|"checkpoint_reset"})` / `brain_source_clear` requires paused/drained source and protected Proc observation. `brain_artifacts_plan({digests})` / `brain_artifacts_clear` fences every live reference before collecting exact stranded objects. `brain_state_receipt_get` reads any receipt. Existing document deletion/cancel/exclude remain separate authorities. |
| Browse | Profiles/controllers/handoffs plus `browser_volume_list` (verified ownership, occupancy/references; bytes unmeasured) | `browser_profile_reset_plan/clear` keeps ID/assignment, advances `generation`, loses sign-ins and creates a fresh exact provider volume/instance. `browser_site_data_plan/clear` selects ≤50 HTTP(S) origins and cookie/storage/CacheStorage categories. `browser_handoff_history_plan/clear` redacts exact resolved bodies while retaining admission digests. `browser_volume_plan/clear` collects exact unreferenced/unmounted owned volumes; foreign volumes excluded. `browse_state_receipt_get` and exact `browse_state_fence_release` cover interrupted provider/CDP effects. Same stopped-Bot/no-controller/no-open-handoff blockers; no implicit Bot stop/start or handoff. |
| Auth | `worker_account_list`; `worker_account_cache_plan({accountId})` exposes only the exact pure-cache allow-list and blockers | `worker_account_cache_clear` removes only owned Codex OpenCode `cache/opencode/models.json`. Account disabled, sign-in idle and observed native/runtime/catalog teardown drained; `worker_account_state_dependencies` observes known Worker fences. Profile/lifecycle revisions bind apply; partial/unknown filesystem results never rerun. Credentials, keychains, native session databases and sibling bytes remain; `auth_state_receipt_get` reads outcomes. Existing account removal/reconciliation is separate and can cascade. |
| Access | `access_snapshot` includes opaque UI-session IDs, pairing/invitation IDs and credential metadata; no bearer values | `access_history_plan({kind:"ui_sessions"\|"expired_pairings"\|"expired_invitations",ids})` / `access_history_clear` removes exact expired metadata atomically with receipt. Active/unexpired entries block; identities/credentials, revocation, enrollment/Share replay receipts and minimal retired digests remain. `access_state_receipt_get` reads durable outcomes. No manual audit pruning; the existing automatic sequence prune retains the most recent 1,000 rows before new mutation audit entries are appended. |
| Roles | Catalog, `role_launch_list` injection metadata and external-shim inventory | `role_launch_plan({ids})` / `role_launch_clear` selects exact exited injection directories, binding launch PID/start identity and file snapshot. Live, missing/legacy locks, interrupted teardown and symlink/special content block; descriptor-relative removal retains partial/quarantine or unknown receipts via `roles_state_receipt_get`. Bot/Worker materializations and external histories remain separate. Existing granular catalog edits and shims remain their own lifecycles. |
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

Serve's occurrence subscription inventory is separate from its snapshot/completion
inventory: `serve_occurrence_list` is bounded metadata, `serve_occurrence_get`
includes source arguments/errors and latest receipt details, and exact
`serve_subscription_remove` accepts either kind's intent revision. Removing a
subscription cannot recall admitted Worker inbox/native input or acknowledge its
source watch. Worker `worker_event_list` discloses receipt counts/truncation and
linked turn outcomes; closing cancels queued input and transcript retirement clears
event text too. Unknown admissions/interruption/turns never automatically replay.
See [ADR 0160](adr/0160-poll-occurrences-and-runtime-event-intake.md).

Infer and Notification records expose `contentClearedAt`; Signal exposes
`contentGeneration` and cleared message/run markers. Existing UI reads invalidate
captured bodies and distinguish cleared content. Signal replay of cleared content
is refused; correlated Infer requests remain selectable for separate cleanup.
Native completion never changes HUD Work state.

Worker transcript clearing advances Worker/turn `contentClearedAt`; existing
Conversation and Records feeds discard append-only cached bodies when that marker
changes. Turn identities, captured Work context, outcomes (including unknown),
usage/configuration records and admission digests remain. Git/native/catalog effects
persist admission before external mutation; a restart makes it unknown, never
rerunnable. Minimal recorded branch identities outlive Worker removal and collection,
so a recreated same-name branch is not silently adopted. Native inspection/apply
uses a single-use Worker callback while Auth holds its disabled-account/sign-in/
enable/removal mutex and Worker fences drained runtime/catalog teardown. External
processes are not covered by those locks. See [ADR 0153](adr/0153-exact-worker-state-maintenance.md).

Serve's `settings` category inventories `serve/settings.json`; `harness-releases`
inventories `serve/harness-releases.json`. The global developer-mode default is
disabled. Release observations survive disable and restart; restored evidence is
explicitly stale until verified. Enabled sampling or an explicit enabled check
can regenerate observations, but the previous different version is retained
history, not a reconstructible installed-version comparison. No independent global-settings
reset or release-cache deletion operation is supplied; explicit installation factory
reset is a separate destructive lifecycle. See
[ADR 0138](adr/0138-developer-mode-and-harness-releases.md).

### Installation factory-reset lifecycle

Factory reset is a separately confirmed whole-generation operation, not a batch of
individual maintenance controls. The plan binds installation directory incarnation,
data generation, Access identity and exact Auth/Worker/Browser resource identities.
Unknown root entries, live/unresolved standalone Role launches and unproven resources
refuse. The apply declaration requires independent writers to have been quiesced;
the Server does not claim a global OS lock. Ordinary state writes up to quiescence
are included in the selected generation, not silently retained.

Apply durably fences admissions/startup before returning a `running` receipt. The
parent closes ingress, drains owners and requires clean exit plus owned process-group
absence; failed/forced teardown does not authorize root deletion. Browse callbacks
remove recorded provider instances then unmounted volumes; foreign/unattributed
resources remain. Auth removes exact profile-owned keychain items, never personal
keychain services. Worker linked worktrees are removed through Git while source
checkouts/branches/commits/retained refs remain. Old Vault files and Git are relocated
unchanged to sibling `<state>.retained-git/<requestId>/vault`; the active Vault starts
empty, but retained authored bodies were **not erased**. Unretained Git metadata,
quarantines, mounts, special files or over-budget snapshots block root clearing.

An in-root `browser/hypeman` provider store or interrupted `hypeman-staging-*`
installation **blocks** factory reset before admission. Raw provider databases/disks
may contain foreign or orphaned resources; exact instance/volume-ID deletion does
not authorize sweeping them. Resolve/uninstall that store explicitly through Browse
first, or keep the selected provider outside the installation. External provider
resources are still cleaned only by exact proven claims; foreign resources remain.

Active accounts, secrets, Roles/settings, owner data/ledgers, sessions/signing keys
and Access identity are deleted only after verified teardown. The private sibling
`<state>.factory-control` keeps content-free scope/digest/generation evidence and
receipts outside that data. Device, Canvas and independent Client-host copies,
personal credentials/histories, source/retained Git, external binaries/configuration,
TLS/Tailscale and backups remain; factory reset is not secure media erasure or
confirmation of external native outcomes. Managed toolchain files inside active
state are part of that state and may be removed.

Use the same typed cold handlers after Server shutdown, with the **same** explicit
`STACK_STATE_DIR` as the reset installation:

```sh
stack serve factory-reset-control serve_factory_reset_receipt_get '{"requestId":"<UUID>"}'
stack serve factory-reset-control serve_factory_reset_recover '{"requestId":"<UUID>"}'
stack serve factory-reset-control serve_factory_reset_fence_release '{"requestId":"<UUID>","expectedGeneration":"<nextGeneration UUID>"}'
```

Receipt read does not initialize erased owners. Recovery requires definitely absent
reset-writer PID and marks interrupted admissions unknown without redispatch. PID
reuse/unknown liveness blocks. Partial/unknown and unexplained fences cannot be
released through this API; inspect exact resources and preserve evidence. Completed
reset also stays startup-fenced until exact request/new-generation release proves
writer absence and an empty root. Release starts nothing; a later explicit Server
start creates fresh defaults and a fresh Access identity, requiring new pairing.
See [ADR 0158](adr/0158-installation-factory-reset.md).

## Coverage boundaries

The following remain explicit backend gaps rather than implied erase controls:

- Worker native purge is scope-verified only for OpenCode 2.0.16, Devin 3000.11.3
  and Claude SDK 0.3.283 under the macOS offline guard; unknown versions, unsafe or
  missing scope and external writers block it. One native root per account/plan;
  verified descendants are disclosed, sibling Worker identities cannot be included.
  Native logs/caches/instruction blobs, external shares and backups remain. There
  is no implicit session reset/reopening, shared-profile deletion, remote branch
  deletion or retained-ref collection. Git resets refuse symlinks/submodules,
  checkout filters and overwriting an earlier different retained tip.
- Browser origin-scoped CacheStorage is supported; whole-browser HTTP cache and
  persisted Chromium navigation-history clearing are unsupported and never widened.
  Domain cookies are shared across matching subdomains/ports; selection preserves
  exact observed domain/path/partition keys. CDP cookie absence/quota observations
  are not an atomic lock against native pages or independent external clients.
  Profiles with unknown/partial effects remain durably fenced across restart until
  exact receipt/generation inspection and explicit release. Foreign, mounted and
  referenced volumes (including incomplete/disposable sessions) remain blocked.
- Brain collection of missing/corrupt Artifact paths without an exact file snapshot
  remains unavailable. Recovery authorization and source definition/checkpoint history
  are retained authority, not deleted payloads. Backups are separate stores.
- Scrape authenticated browser sessions belong to Browse; unattributed retirement
  quarantine and publication temporaries stay with existing queue recovery. Maintenance
  never breaks live, dead or unresolved claim evidence to make a plan pass.
- Roles legacy/unlocked injection directories or interrupted native teardown are
  unknown, not automatically adopted for removal. External native histories and
  Bot/Worker materializations remain with their owners.
- Settings legacy receipts without recorded target/admission age cannot be
  automatically retired. Permanent minimal dedupe tombstones are retained authority,
  not payloads; retirement promises no secret erasure or large byte reclamation.
- Auth Devin/Claude pure-cache cleanup is unsupported without a proven separable
  allow-list; Grok was retired. Broad profile/cache deletion is never substituted.
  Untracked external sign-in/provider processes must be quiesced by the operator;
  dependency observations do not prove absence of arbitrary external writers.
- Signal historical checkpoint replay is intentionally unavailable: rebaseline-to-now
  only. Explicit run replay remains a separate spend-bearing operation.
- Content Git history rewriting remains intentionally unsupported. Read-only
  `content_vault_history_plan` discloses exact-slug retained ref/reflog commits/blobs
  and remote names; no bodies or secret-bearing URLs, no network or Git writes.
  Unreachable objects, older shallow history, renamed different slugs, clones and
  backups remain unobservable. Document/Artifact tombstones do not erase them.
  `content_publication_list/plan/clear` collects only exact provenance-backed
  dead-writer temporary claims, keeping published/source references and permanent
  claims/receipts. Legacy/unattributed temporaries and quarantines are retained.
- Client-local Canvas layouts/drafts and Chrome/Android outboxes/history. Device
  state is destination-bound; server maintenance cannot delete browser/device storage.
  [Device-local clear contract](device-state-clear-contract.md) and ADR 0157 are
  proposed only; no runtime, signing/enrollment, transport or UI action is shipped.

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
