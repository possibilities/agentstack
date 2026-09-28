# 104. Worker diffs and list summaries

Status: accepted, 2026-09-28. Extends the `worker` Package API of
[ADR 0038](0038-durable-acp-worker-execution.md) and fills the gaps the Workers
space ([ADR 0102](0102-workers-space.md)) left as consequences.

## Decision

**`worker_list` summarizes each Worker's latest turn.** Each row adds:
- `turn`: the current turn's id, phase, stop reason, issue, dispatch time and
  timestamps. This is the same turn `worker_status` summarizes, without the
  prompt size or settings.
- `pendingPermissions`: the count of requests still waiting for an answer.

The fields are additive. A list reader can now see an unknown outcome or a
permission wait without one status read per Worker. `worker_status` still
carries the exact requests.

**`worker_diff` reads a Worker's changes without writing to its worktree.** It
compares the retained worktree with the Worker's base commit and returns:
- the branch's commits since the base (up to 200);
- changed files with rename detection and line counts, plus untracked files
  (up to 2,000);
- whether uncommitted or untracked work exists;
- optionally, a unified patch for every file (`patch: true`, untracked files
  last) or for one listed `path`, cut at `maxChars` (default 100,000, at most
  200,000) and marked `truncated`.

A `path` must be one of the listed files, so input never reaches Git as an
option or as an arbitrary path. Git runs with:
- `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`, so a read never rewrites
  the index or starts a hook;
- `--no-ext-diff --no-textconv`, so repository configuration cannot run a
  program.

Output is streamed and cut at the limit rather than buffered. The operation is
read-only, so Bot MCP and Worker-bound MCP URLs expose it like the other reads.
It fails once `worker_remove` has discarded the worktree.

The Workers space uses both additions:
- List rows show the latest turn, and "Last turn outcome unknown" as a note
  rather than attention, because the outcome stays unknown after its Bot
  inspects and resumes.
- Worker windows gain a **Changes** tab: commits, files with counts and a
  patch per file or for all changes. The tab re-reads on the Worker's scoped
  notices.

## Consequences

A Worker still running a turn re-runs a few Git reads on each progress notice
while its Changes tab is open. The reads coalesce, but a very large repository
makes that visible. Patches beyond 200,000 characters are read in Git from the
worktree. Binary and untracked files report no line counts.
