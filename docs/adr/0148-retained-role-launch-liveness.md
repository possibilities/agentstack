# 0148 — Retained Role injection cleanup requires verified teardown

Status: accepted, 2026-09-30. Extends [ADR 0135](0135-owner-state-maintenance.md).

## Decision

Role injection records the launching PID and OS start identity before preparing
capabilities. It marks the retained Codex directory exited only after reaping the
native child/private host and removing temporary capabilities. Other harnesses
continue their existing automatic ephemeral-directory cleanup.

`role_launch_list` exposes metadata only. Exact plans bind directory snapshots and
lock/liveness observations; a matching live PID blocks even when the file says
exited. Reused PIDs are distinguished by start identity. An interrupted launch,
missing/legacy lock, unknown liveness, symlink or special file is not permission
to erase. Unknown teardown remains retained for investigation.

Apply persists admission before descriptor-relative removal and returns partial
or unknown effects, including quarantine. Interrupted admission never reruns.
Role configuration/shims, Bot/Worker materializations, external native history and
credentials remain separate. File/liveness observation requires explicit refresh;
the directory is not an authority to stop a harness or resume it.
