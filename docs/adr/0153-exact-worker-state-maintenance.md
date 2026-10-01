# 0153 — Exact closed-Worker state maintenance

## Status

Accepted. Extends [0135](0135-owner-state-maintenance.md),
[0149](0149-settings-receipt-retirement.md) and
[0150](0150-auth-pure-cache-allow-list.md).

## Context

Worker transcripts, Git worktrees/branches and native sessions have independent
lifecycles. Native account profiles are shared; source repositories are human-owned.
Closing a Worker alone does not authorize resetting source files, deleting a profile
or replaying its unknown turn.

## Decision

- One Worker `StateJournal` shares `workers.sqlite` with settings receipts.
  Transcript body/tool/prompt redaction and receipt commit together. Worker/turn
  clear markers invalidate cached readers; turn/admission IDs, digests, terminal
  outcomes, usage, settings and captured Work context survive.
- Git reset is closed-only in the exact ledger-owned linked worktree. Bind branch,
  common repository, HEAD, index, files/untracked paths and recorded base. Preserve
  the old tip at `refs/stack/retained/<worker>`; never overwrite a different earlier
  tip. Disable hooks, refuse checkout filters, symlinks and submodules. Safe file
  helpers remove exact untracked bytes; frozen Role resources remain.
- Record Stack-created branch identity before Worker removal. Collection requires
  no Worker reference, no checkout anywhere and merge into recorded base; the human
  may explicitly select unmerged deletion per branch. Git itself checks checkout
  restrictions. Collected identities remain retired; remotes/retained refs do not
  clear. Operators must quiesce other repository writers.
- Native purge is closed-only, never reset-and-reopen. Verified offline fixtures
  establish OpenCode 2.0.16 `session delete --standalone` (exact root plus descendants),
  Devin 3000.11.3 `rm <full-ID> --force` and Claude SDK 0.3.283 `deleteSession({dir})`.
  Bounded read-only native observations bind exact identity/directory, selected
  payload digests, siblings and credentials. Refuse unknown versions/platforms,
  unsafe roots, ambiguous Claude project scope and sibling Worker descendants.
  Select one root per account/plan. Verify absence and sibling/credential retention
  after native execution; provider logs/caches/shared blobs/shares remain.
- Worker issues a single-use callback token. Auth holds its existing account mutex
  through callback execution, requiring disabled account and idle sign-in. Worker
  additionally fences drained runtime, teardown and catalog activity. No implicit
  account disable, drain, sign-in, Worker recovery or turn admission. Private native
  subprocesses isolate HOME/XDG and deny external egress/browser activation on macOS.
- Catalog clear evicts exact account-shared Stack file/memory observations, fencing
  discovery and retaining sessions/credentials/settings. It admits no turn.
- External Git/native/file effects persist admission first. Partial/unknown receipts
  never rerun, including after restart; shutdown waits for known maintenance work.
  All controls are local-operator-only, excluded from MCP and refused remotely.

## Consequences

Unknown native scope is blocked, not treated as zero bytes or emulated by deleting a
profile. External writers, SQLite free pages/WAL, backups and other owners' content
remain independent. Existing UI wire types and cached readers stay truthful; new
controls require a separately authorized UI handoff.
