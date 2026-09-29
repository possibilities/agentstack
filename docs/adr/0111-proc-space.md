# 111. A Proc space for schedules, runs and their output

Status: accepted, 2026-09-28. Adds a thirteenth Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md), after the Brain space of
[ADR 0109](0109-brain-space.md), and gives the `proc` Package API of
[ADR 0105](0105-proc-local-scheduling-and-process-control.md) and
[ADR 0110](0110-proc-durable-caller-authority.md) its first UI. It supersedes 0105's
"no dedicated UI" note and 0110's UI section. Proc stays owner-local on remote
Access sessions per [ADR 0101](0101-remote-uix-through-access.md).

## Decision

**Proc** (`/x/proc`, key `p`, a new `proc` accent) is where people see what was
scheduled and what actually ran on this machine: who owns each schedule, when it
next runs, what its invocations did, and what its processes printed. It has five
windows, ordered what needs a person, what runs, when it all happened:

- **Schedules** (`proc-schedules`) lists `proc_schedule_list` with labels and the
  captured target (`package.operation` or the executable path), owner chips, cadence,
  next due, and an outcome strip of the 12 most recent executions per schedule. Groups
  are **Needs you** (unattributed legacy schedules, blocked schedules with no retry,
  enabled operator or system schedules whose latest execution failed or is unknown),
  **Held** (blocked with a retry countdown), **Upcoming** (by next due), **Off** and
  **Removed** (collapsed tombstones). Owner and kind filters narrow the list.
- **Schedule** (`proc-schedule`) follows the selection: the full definition —
  authority, creator and last editor, revision, cadence, blocked reason, process
  arguments and cwd — plus its execution history, paged with "Load older". API
  results show as collapsed JSON; `{truncated:true}` says the 32 KB bound hit.
  Process environment variable values are masked to `••••••` until a per-key
  **Reveal**; the summary API of [ADR 0110](0110-proc-durable-caller-authority.md)
  sends values only for the schedule's own spec, and runs keep environment names only.
- **Runs** (`proc-runs`) lists `proc_run_list` as **Running**, **Needs a look**
  (failed, unknown or non-zero exit within a day) and **Finished**, each row with its
  state word, label, owner, origin (schedule link or "direct"), elapsed time and line
  count. "Load older" pages the cursor.
- **Run** (`proc-run`, `proc-run-N`) shows one run's detail from `proc_run_get`:
  command and arguments, cwd, env key names only, timeout countdown, pid (linked to
  the System `process` node when observed), exit or signal, owner and origin. Its log
  reads `proc_run_read` forward from the last ~200 lines, pages "Load earlier lines"
  backscroll, joins partial line chunks by first seq, strips ANSI escapes, marks
  stderr in the gutter, streams a find-with-count, and reports retention gaps, the
  "doesn't keep output" banner for `retainOutput:false` runs, and the 2 MB / 10,000
  line truncation bound. A scoped `proc_output_changed` subscription per window
  refreshes it; the main channel never subscribes that topic because it fires once
  per line.
- **Timeline** (`proc-timeline`) draws `proc_execution_list` across schedules over a
  6 h or 24 h window each way: one lane per schedule ordered like the list, a Direct
  runs lane of process bars, and marks by state — filled for completed, × for failed,
  a ring for unknown, a dash for refused, a bar for running. Next-due ticks project
  forward; disabled or removed schedules project nothing; a held schedule hatches its
  overdue span. Dense lanes bin marks by column with the worst state's tone. Clicking
  a mark selects its schedule and goes to that execution.

`proc-schedule`, `proc-execution`, `proc-run` and `proc-run-window` are new node
kinds; the windows are their homes. The palette searches schedules and runs. The
inspector resolves every kind with read-only Proc operations and field notes for the
unknown, refused, removed and environment-key semantics. Fleet Bot cards get an
"N schedules" link that filters the Schedules list to that Bot's root.

**Attention is only what a human owns.** The space flags a dropped channel, a legacy
schedule needing reauthorization, a blocked operator or system schedule, an enabled
operator or system schedule whose latest execution failed or is unknown, and a full
process capacity. A Bot-owned failure shows in the lists and lanes but never flags,
because the Bot owns its effects.

Four controls act, each confirming first with its exact verb: **Disable** and
**Enable** (`proc_schedule_update` at the seen revision, enable moving `firstAt` to
now), **Remove** (`proc_schedule_remove`, keeping history and a tombstone), and
**Reauthorize** (`proc_schedule_reauthorize` on a null-authority legacy schedule,
showing the reviewed definition with environment masked and defaulting to "Keep
disabled"). **Stop** sends `proc_run_cancel`; the terminal state is re-read, never
assumed. Operator edits never change a Bot schedule's authority; promotion still
means creating a new operator schedule.

`proc_schedules_changed` refreshes schedules and status silently in Activity;
`proc_runs_changed` refreshes runs and status. Per-run output notices use a
ref-counted scoped channel that closes when the last Run window leaves it.

## Remote boundary

Proc is local-only: Access's remote selection excludes every Proc operation and its
topics, so a remote session cannot read process output, schedule inputs or
environment material at all — before this change it could read all three. Every
window shows "Available only on the local UIX" remotely and hides its controls.

## API additions that made the space possible

Part 1 of this change added what the UI needs without widening the agent surface:
short labels on schedules and runs (`label`, the spec's first key), a safe run
summary in schema v3 (executable, arguments, cwd and environment variable *names*,
never values), `recent` outcome strips on list items, `includeRemoved` tombstone
reads, `proc_status` for capacity and health, paged `proc_execution_list` across
schedules and `proc_run_list` with `nextCursor` cursors, and the limits module
(16 run/call slots, 2 MB or 10,000 retained lines, 30-day history).

## Consequences

A human can finally see and stop what the machine is doing on its own behalf: legacy
schedules surface for review instead of sitting silently disabled, blocked schedules
say why in words, and process output is tail-able without shell access. The local
UIX is the only place all of this works, which is the intent: the output and the
environment are what remote access must not leak. `proc_schedule_create`,
`proc_run_start`, `proc_run_wait`, `proc_run_join` and the diagnostic reads remain
API-only; the UI operates only the four controls above plus Stop.
