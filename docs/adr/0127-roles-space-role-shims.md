# 127. The Roles space manages Role shims

Status: accepted, 2026-09-29. Adds the local operator control for the Role shim API (`role_shim_*`, `role_shims_changed`) to the Roles space of [ADR 0121](0121-roles-space-for-named-roles.md). Launch semantics stay with `stack roles inject` ([ADR 0123](0123-role-injection-for-native-clis.md)).

## Decision

A Shims window in the Roles space lists, creates, edits, inspects and removes Role shims. It is not scoped to the selected Role: a shim names a Role as an argument, and that name is resolved each time the command runs. Each shim is a `role-shim` node addressed by its command name, whose home is the Shims window. The inspector shows the listed record and hands back to the window's editor.

The argument vector is edited as tokens, never as a shell string. The editor splits it at the first `--` into the Stack side, a harness chosen from `claude`, `codex` and `opencode`, and the native side, and joins it back in the same order. Nothing is trimmed, unquoted or reparsed. A `--` typed among the Stack arguments blocks saving, because it would move the boundary. Native arguments are not checked against any allowlist; `roles inject` judges them at launch. The Stack side is read only to label the Role and warn about arguments that `roles inject` would refuse. The preview renders one POSIX shell word per argument, followed by `"$@"`, so a shell reads back exactly the stored vector.

Every update and removal carries the listed revision and is never retried. A stale refusal leaves the edit in place and shows the installed version, with the choice to use it or keep the edit and save again. A collision with an existing command, or a shim edited outside Stack, is reported as refused, and the file is left as it is. The listing is reread after every shim write, whether it succeeded or was refused, on `role_shims_changed`, and on reconnect. The window shows the command directory the server returned, and explains that the directory must be on PATH. Removal is confirmed with the path, and the confirmation says that running sessions are unaffected.

Shims are local operator control. The remote Access gateway omits the operations and the notice, the store neither reads nor subscribes to them in a remote session, and the window shows only a local-only placeholder there.

## Consequences

Operators can install commands such as `opencode-astra` without hand-editing scripts, and cannot accidentally change argument boundaries through quoting. A rename is a new shim plus a removal. Shell profiles are never edited, so a command directory missing from PATH is explained but not fixed.
