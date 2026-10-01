# 0150 — Auth cache cleanup selects proven pure-cache bytes only

Status: accepted, 2026-09-30. Extends [ADR 0135](0135-owner-state-maintenance.md).

## Decision

The researched isolated Codex OpenCode profile allow-list is
`cache/opencode/models.json` only. Native credential/session SQLite, keychain items,
tokens, configuration and all other bytes remain. Devin/Claude have no proven
separable pure-cache allow-list; broad deletion is refused rather than substituted.

Require the account disabled, not removing, no pending/queued sign-in, and available
Worker dependency evidence showing runtime, native teardown and catalog reads
drained. Never drain or restart implicitly. Account lifecycle and cache observations
serialize in Auth. Worker reconciliation cannot relaunch a tearing-down backend;
failed native close keeps its exact backend reference and blocks cleanup until an
explicit successful teardown. Dependency reads wait for queued reconciliation.

Plans bind account metadata, dependency revision, owned profile/file identities.
Apply persists admission before descriptor-relative removal. Partial/quarantine or
interrupted effects remain partial/unknown and never repeat under the same request.
Missing caches, unsafe paths and unavailable dependency evidence are blocked, not
measured as empty. Account invalidation announces the committed result.

## Consequences

Native catalog discovery can recreate the model cache later; sign-in still works
against the retained credential fixture and Worker native recovery path. Operator
must quiesce untracked external provider/login processes; Stack observes only its
known resource lifecycles. No live credentials or provider stores are inspected as
part of verification, and no external CLI changes are required.
