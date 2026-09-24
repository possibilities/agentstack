# 22. Assign a Codex account to an existing Server

Status: accepted, 2026-09-24. Extends [ADR 0018](0018-unbound-server-launch.md). Supersedes automatic binding of an existing unbound Server to the active account.

`server_assign` and `bot_assign` record an account on an existing Server. They do not restart it. The view's `account` is that assignment; `runningAccount` identifies the live process's identity, or is null if stopped or launched unbound. A running process keeps its launched identity until stop, then start. `start` of a running Server whose assignment differs refuses to return that process. A new Server still binds the active account when one exists. An existing unbound Server does not.

Credential refresh follows the launched identity, not a pending assignment, so reassignment cannot import the old runtime into the new account. Removing an account deletes Servers assigned to or last launched with it, including Servers awaiting a restart under another account. This ensures removal cannot leave a process using the removed identity alive. An older stopped Server's retained runtime is reconciled against its last launched account during schema migration.
