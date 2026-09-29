# 128. Manage explicit runtime settings with native defaults and separate application evidence

Status: accepted, 2026-09-29. Extends [Bot launch snapshots](0037-bot-launch-settings.md), [native voice calls](0028-main-thread-voice-call.md), and [Worker execution](0038-durable-acp-worker-execution.md).

## Decision

Bots and Workers expose a versioned, backend-specific settings contract. `packages/settings` is a shared library, not another Package API or runtime supervisor. The owning `bots` and `worker` APIs provide catalog, read, preview, revision-fenced patch/reset, and explicit application operations. Bots additionally expose the pinned native configuration schema and live model/effort/service-tier, voice, feature and managed-requirement discovery.

The managed catalog is an explicit supported subset of the native schema. Native existence does not imply Stack application support, account eligibility or successful inference. Codex/Grok Workers use OpenCode ACP, Devin uses ACP, and Claude uses its SDK; a Codex Worker cannot accept a Codex app-server configuration key. Native Codex child-thread defaults are not Worker defaults. Roles continue to own instruction fragments, skills, MCP connections and trusted projects.

Existing Bot defaults and saved settings are migrated once. A fresh installation keeps Stack's existing Sol/medium/full-access/no-approval baseline, explicitly reported as Stack preferences. Every additional setting starts unset. Worker provider defaults initially contain no model or effort; admission still needs a valid explicit or saved selection from the account catalog. Defaults are **copied at creation**, preserving the established snapshot behavior; editing defaults does not retune existing instances. Reset deletes an override and reveals native resolution, not today's creation defaults. Existing Worker sessions retain their native selection when an override is removed.

## Save and application

Each target has an independent monotonic revision. Atomic edits require `expectedRevision` and a UUID `requestId`. Repeating the same request returns its original receipt; reusing that ID for different content fails. A rejected edit writes nothing. The saved record retains its creation source/default revision, while its own revision and timestamp advance on changes. A save receipt always says `applied: false`.

- **Bot process:** explicit native configuration overrides load on the next start, before saved caller arguments. `bot_settings_apply` starts only a stopped Bot with the exact saved revision. It never interrupts a running Bot. Existing main threads resume normally and can retain different thread settings.
- **Voice call:** explicit native fields load only on the next `voice_dial`. The active call holds an immutable snapshot. Transport stays native WebRTC v3/audio. Stack adds no prompt, startup-context suppression, append-slot emulation, replay, reconnect, client-managed handoff or synthetic child lifecycle behavior. A string prompt, empty string, explicit native null and omission remain distinct.
- **Worker:** saved selections load on the next follow-up or `worker_settings_apply` for the exact idle runtime instance and revision. Application holds the existing preparation fence and sends no prompt. Edits during application remain pending for the next boundary. A partial or ambiguous native failure retains the saved settings and requires normal recovery rather than automatic replay.

## Evidence and discovery

Reads separate **saved**, **loaded** (submitted at a boundary), **resolved** (native process configuration), and **effective** (observed native main-thread/Worker selections). Loaded snapshots are fenced by runtime identity and timestamped separately from save time. Voice fields use the active call's snapshot, not the process snapshot. Missing observations stay unknown; omitting an override is not evidence of the value Codex selected. Native null is a known value, distinct from unknown and native omission. Main-thread observations never accept unrelated top-level or child threads and are invalidated on disconnect.

The catalog supplies schemas, descriptions, groups, dependencies, default evidence, choice sources, stability and application boundaries. Documented pinned native defaults are labelled with their source; model/account-dependent defaults remain unknown until native discovery supplies evidence. Live Bot discovery returns independent partial outcomes without starting a thread or turn. `config/read` projects only managed keys and origin kinds, not full configuration layers or secrets. Argument masking reports names/classification, never private argument values. Arbitrary profiles and resumed-thread overrides can still require native inspection.

`bot_settings_native_schema` returns the full configuration schema from the consumer's exact Codex integration pin. Regenerate it with `node scripts/update-codex-settings-schema.mjs /path/to/codex-source` when updating the pin, and reconcile managed mappings against that revision. Deprecated/native-only settings remain discoverable there without becoming managed controls.

## Compatibility and presentation

`bot_defaults_get/set` and `bot_start.settings` remain the legacy four-field projection. Fields may now be absent after reset. The new API is the revision-fenced editing surface; legacy writes still update the same managed document. Existing UI controls and cards display omission as native resolution and existing notices refresh the projection.

Use `defaults_changed` for Bot defaults, scoped `bots_changed` for saved Bot edits/application, `threads_changed` for native thread observations, and global `voice_changed` for call-loaded state. Workers use `workers_changed`, scoped `worker_changed`, and `worker_progress` for native observations. Consumers subscribe then read, and reread after reconnect or uncertain acknowledgements; no notice carries settings content.

Managed Bot mutations and Worker provider-default edits are operator-only. Owned Worker edits retain existing Worker ownership checks. Transport availability remains in each Package API manifest and Worker MCP disclosure stays explicit. The existing API reference discovers the new operations. A dedicated rich settings editor is a separate UI change.
