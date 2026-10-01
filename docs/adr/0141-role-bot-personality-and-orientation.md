# 141. Role-owned bot.md and fenced first-turn orientation

Status: accepted, 2026-09-30. Supersedes the first-UI-turn policy in
[ADR 0026](0026-lazy-server-main-thread.md) and
[ADR 0043](0043-bot-chat-apis.md) **for newly created, account-bound Bots only**.
Extends [ADR 0121](0121-roles-space-for-named-roles.md)'s Role editor and
[ADR 0028](0028-main-thread-voice-call.md)'s initial voice eligibility. Preserves
[ADR 0120](0120-codex-native-input-admission.md)'s admission semantics.

## Decision

Each Role owns a separate, revisioned `bot.md` personality, represented as
`botMarkdown` in its snapshots and create/update operations. It is neither a
task-instruction Fragment nor an onboarding prompt, and is not Bot-owned mutable
memory. Omission preserves the text; empty text disables it. New Roles get a
small, editable starter. Existing Roles gain an empty personality without changing
their authored instructions; fresh installations seed the Manager starter and
leave the Worker personality empty.

Every Bot launch captures the selected default Role's `bot.md` verbatim in its
private capabilities directory and composes it after instruction Fragments in
`SYSTEM_APPEND.md`. The combined developer-instruction byte budget still applies.
Edits take effect on a later launch, alongside the rest of the captured Role;
they do not edit a running Bot or cause a new introduction. Workers and Role
injection keep their existing instruction delivery without the Bot personality.
Native resume updates the developer-instruction configuration but retains the
old generic developer context in history. On a changed launch snapshot, Stack
also injects a superseding developer message through `thread/inject_items`,
without admitting a turn or invoking the model. A persisted content hash avoids
reinjection on unchanged launches; uncertain acknowledgements may duplicate the
same instruction snapshot but never the orientation turn. Empty snapshots
explicitly supersede the prior personality too.
The existing Role details editor edits the text using its scoped draft/conflict
flow, and Preview reports both the personality and combined Bot size.

New account-bound Bots allocate a sanctioned root and admit one genuine
orientation turn automatically. Its typed text explicitly identifies Stack as
the origin, includes a stable admission marker, and requests bounded orientation,
a short introduction and a grounded offer to help—not a questionnaire. The
request forbids mutation, network research, dispatch, contact and recurring work.
This is a behavioral instruction, **not a read-only security sandbox**; the Bot
retains its configured runtime permissions and Role tools. No external runtime
patch, native model choice or sandbox-setting rewrite is needed.

## Admission, observation and recovery

Initialization is persisted with the Bot record. It carries an admission UUID,
exact root and turn IDs, state, bounded issue and update time. States distinguish
pending work, root allocation, root-ready, turn submission, acknowledged running,
known completed/failed/interrupted outcomes, uncertainty and explicit retirement.
The supervisor's lifecycle queue serializes allocation, restart and root adoption.
It writes each fence **before** the native mutation and records its returned ID
before advancing. The recorded root is sanctioned during initialization, but its
existence alone proves neither durable turn admission nor readiness for voice.

`bot_start` returns on admission, never waiting for turn completion or polling for
idle. One native history read catches fast-completion races. Supervisor-owned
native event/reconnect observation then reconciles the **exact** turn independently
of any UI or Package API subscriber. Completion of another root or turn, thread
idle, approval waiting and user-input waiting cannot settle orientation.

A lost turn reply can be reconciled by its stable marker in full native turn
items on the recorded root. A lost root-allocation reply has no trustworthy root
ID: it stays unknown, never adopting an arbitrary root or allocating another one.
Unavailable history likewise stays unresolved. Automatic recovery never resends
an uncertain introduction. Readable terminal history does not release a failed
root-resume fence; stop/start must successfully resume that exact root first.
Existing inspection and exact conversation-reset
maintenance provide the escape hatch; no new recovery control is added.

Explicit conversation reset retires the old orientation in the same transaction
as the history-generation/root change. Retirement says nothing about its native
outcome and never repeats introduction. Legacy Bots—including empty ones—remain
unenrolled and retain their first durable UI-root behavior. Removing a Bot deletes
its initialization record; a genuinely new incarnation may orient again.

## Voice and presentation

Voice requires initialization to have a known terminal outcome (completed,
failed or interrupted), or to have been explicitly retired with its conversation.
Generating, tool execution, approval/input waiting and unknown outcomes keep the
one-time gate closed. This is not an idle gate on subsequent Chat turns.

`bot_list` exposes initialization, and `bots_changed` invalidates its reads. Fleet
Chat shows the introduction and labels the exact Stack-originated orientation
input rather than presenting it as human speech. Existing voice availability
labels reflect orienting/needs-inspection, and generic inspection shows the full
state. No new space, window or recovery workflow is introduced.

## Verification

Disposable-state owner/protocol checks protect admission versus completion,
exact-turn reconciliation, lost root and turn replies, owner restart, no duplicate
roots/introduction, launch snapshot changes, explicit retirement and legacy empty
Bots. Role checks protect scoped personality edits, composition and immutable
launch copies; voice checks own the eligibility boundary. Real-runtime checks use
private fixture credentials only, never an existing account or live Server.
