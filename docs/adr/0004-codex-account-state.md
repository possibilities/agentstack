# 4. Bind managed Codex servers to AgentStack accounts

Status: accepted, 2026-09-23. Builds on [ADR 0003](0003-required-codexnk-runtime.md). Ordinal account names and shared history for new Servers were superseded by [ADR 0012](0012-stable-codex-account-ids.md); the account-binding model later evolved through [ADR 0018](0018-unbound-server-launch.md) and [ADR 0022](0022-server-account-assignment.md). The credential-refresh rationale remains.

The Codex package owns sign-in and account selection for app servers it creates.
The browser UI starts the installed codexnk CLI's OAuth login in a private,
temporary Codex home, presents its authorization link, and stores credentials
only after the native command finishes successfully. It does not import or
alter a person's ordinary Codex login or AgentUsage-managed accounts.

`configuration.sqlite` stores the ordered `codex-N` names, active selection, and
server records. `secrets.sqlite` stores their `auth.json` content. Both live in
AgentStack's private state directory with mode 0600. Names are allocated with a
monotonic SQLite sequence: removal never renumbers or reuses a name. The first
account is active by default; selecting another changes future launches only.
Older JSON server records are imported once into SQLite before startup reaping.

At launch, AgentStack materializes the chosen secret into a private short-lived
identity directory and passes codexnk's `--identity`, `--capabilities`, and
`--history-dir` together. It removes the materialization after app-server
readiness. The capabilities directory is initially empty, and the shared history
directory remains codexnk's session store. The account name is recorded with the
server and displayed alongside its working directory. A live server does not
change identity when the active account changes, and its ID remains idempotent.

This is a local same-OS-user boundary, not encryption at rest. codexnk copies
credentials into a private runtime and does not write refreshed tokens back to
the input identity. Without changing codexnk, AgentStack gives each Server a
private `TMPDIR` so it can locate the retained runtime home, watch its
`auth.json`, and reconcile it before new launches, after exit, and on owner
recovery. A watcher event is only a hint: Codex truncates and rewrites the file
in place. AgentStack reads a stable complete copy, requires valid timestamps
on both the saved and candidate credentials, accepts a strictly newer
`last_refresh` only from the Server's known credential generation, and commits
it to SQLite. The runtime copy remains until the final reconciliation.

Concurrent Servers can independently rotate the same provider token because
Codex's refresh lock is per process. Generation fencing refuses a competing
write after another Server or re-sign-in has advanced the database. This is
best-effort propagation, not a guarantee that the provider considers the first
accepted refresh token valid. An ambiguous runtime is retained for diagnosis,
and the UI can sign in again under the same name without changing running
Servers. This avoids a new codexnk carry at the cost of that explicit limit.
