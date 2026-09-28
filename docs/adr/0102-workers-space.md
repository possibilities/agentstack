# 102. A read-only Workers space

Status: accepted, 2026-09-28. Adds a ninth Canvas space to the open bench of
[ADR 0058](0058-open-bench-and-global-tools.md) and gives the `worker` Package
API ([ADR 0038](0038-durable-acp-worker-execution.md),
[ADR 0060](0060-claude-sdk-workers.md)) its first conversation and review UI.
It supersedes the deferral of dedicated Worker views in
[ADR 0039](0039-worker-wakeups-and-scoped-mcp.md) and
[ADR 0055](0055-agent-tree-observability.md); the rest of both stands.

## Decision

**Workers** (`/x/workers`, key 9) shows what Workers are doing. Bots start
Workers and steer them, and they get `worker_changed` wakeups for that purpose,
so the space only reads. There is no launch form, composer, permission answer,
cancel, resume, close or remove. If a person answered a permission here, they
would compete with the Bot that is waiting to answer it. Pending permissions are
shown with their offered options and "Waiting for its Bot to answer".
Account draining stays with account removal. The inspector lists only the
`worker` operations annotated read-only.

The space has three windows:

- **Workers** (`workers`) lists every Worker from `worker_list`, most recently
  updated first, in four groups:
  - **Needs attention:** awaiting a permission answer, needing recovery, or
    failed.
  - **Running.**
  - **Idle.**
  - **Closed:** collapsed.

  Filters narrow the list by the originating Bot (or the local operator) and by
  account. Choosing a row shows that Worker; the arrow keys move between rows.
  The list works from `worker_list` alone. A permission request already puts
  its Worker in `awaiting_input`, so the list reads no status per Worker.
- **Worker** (`worker`, `worker-N`) follows one Worker, like Fleet's chat
  windows ([ADR 0080](0080-fleet-chat-windows.md)). The primary window follows
  the list. Additional windows keep their Worker until closed, and a removed
  Worker closes them. The arrangement is browser-local.

  A summary shows:
  - phase and turn time
  - the originating Bot and the account
  - requested model and effort, with a warning when the natively observed
    settings differ
  - the worktree, the base commit, and whether the source checkout was dirty
  - the Role revision it started with
  - an unknown last-turn outcome
  - pending permissions

  The tabs read:
  - **Conversation:** `worker_read`. Agent and user chunks are joined, and a
    tool's updates and a turn's plan updates collapse to their latest state.
  - **Turns:** `worker_turn_list`, with each submitted prompt and requested
    versus observed settings.
  - **Tools:** `worker_tool_list`. Task references are labelled as unverified.
  - **Records:** `worker_record_list`, with oversized records joined from
    `worker_record_read` chunks.
  - **Session:** `worker_detail`, with capture limits and subagent coverage.
- **Runtimes** (`worker-runtimes`) shows `worker_runtime_list`: backend, process
  model, state, error, open Workers, and PIDs linked to System's processes.

**Live reads are scoped to open windows.** Each Worker window holds a
reference-counted subscription to `worker_changed` and `worker_progress`, scoped
to its Worker ID. Every notice, and every (re)subscription, bumps that Worker's
generation, because missed notices are not replayed.
- `worker_changed` also re-reads `worker_status`.
- The conversation continues from its last sequence number.
- Record pages continue once the reader has reached the end.
- Tools, turns and session metadata are re-read as snapshots.

The global `workers_changed` still refreshes the list and runtimes.

New node kinds:
- `worker`: the list row.
- `worker-runtime`: the runtime row.
- `worker-window`: a Worker window, which has no record of its own.

Links only, no controls, are added elsewhere: a Fleet Bot card and a Worker
account card each show a count of their Workers. That count opens the list
filtered to that Bot or account. The palette finds Workers.

The space uses a new `worker` accent (cyan). Attention covers Workers awaiting
permission, needing recovery or failed, Worker runtime errors, and a closed
`worker` channel.

## Consequences

[ADR 0104](0104-worker-diff-and-list-summaries.md) adds `worker_diff` and `worker_list` turn summaries. They resolve the first two consequences below: the space now has a Changes tab and marks unknown outcomes in the list.

The UI cannot show a Worker's diff. Reviewing a closed Worker's branch still
happens in Git, from the copied worktree path and base commit. A read-only
`worker_diff` would complete the review story. It is a separate API change.

A Worker's unknown last-turn outcome is visible only in its window, because the
list reads no status per Worker. An idle Worker whose Bot has already
acknowledged the unknown outcome therefore does not flag the space.

A long transcript is read from its start, one bounded page at a time, since
`worker_read` pages only forward. Loading the new UI into a running owner still
needs a build and an owner restart ([ADR 0013](0013-owner-managed-ui-canvas.md)).
