# 18. Allow a Server to start without a Codex account

Status: accepted, 2026-09-24. Extends [ADR 0004](0004-codex-account-state.md) and [ADR 0005](0005-server-main-threads.md). Supersedes the requirement that a new app server have an active account.

A Codex Server, including a Bot, may be created and launched when no Codex account exists. The launch still passes `--identity`, `--capabilities`, and `--history-dir` together, so it does not fall back to the person's ordinary Codex home. The identity directory has no `auth.json`. Codex already starts in that state and refuses a turn until credentials exist.

A new Server binds the active account when one exists. An existing unbound Server stays unbound until an explicit assignment. A live process does not change identity; sign-in does not attach to a running Server. A removed account still blocks restart of Servers bound to it. An unbound private runtime holds no credential to reconcile and is removed on stop. Assignment is [ADR 0022](0022-server-account-assignment.md).
